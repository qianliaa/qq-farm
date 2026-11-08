'use strict';

/**
 * 原生 NapCat 运行器。
 *
 * 不再依赖 Docker：
 * - 使用官方 NapCat-Installer 在 NAS 本地安装 Linux QQ + NapCat；
 * - 每个账号拥有独立 HOME、Xvfb 显示、WebUI 端口与 OneBot 端口；
 * - 通过 PID 文件与进程组管理启停，日志落盘到应用数据目录。
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { DATA_DIR } = require('./store.cjs');

const ACCOUNTS_DIR = process.env.QQNAS_ACCOUNTS_DIR || path.join(DATA_DIR, 'accounts');
const RUNTIME_DIR = process.env.QQNAS_RUNTIME_DIR || path.join(DATA_DIR, 'runtime');
const TEMPLATE_HOME = path.join(RUNTIME_DIR, 'home');
const TEMPLATE_NAPCAT = path.join(TEMPLATE_HOME, 'Napcat');
const TEMPLATE_QQ = path.join(TEMPLATE_NAPCAT, 'opt', 'QQ', 'qq');
const INSTALLER =
  process.env.QQNAS_INSTALLER || path.resolve(__dirname, '..', '..', 'runtime', 'napcat-install.sh');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const RUNTIME_LOG = path.join(LOG_DIR, 'runtime-install.log');
const RUNTIME_PID_FILE = path.join(RUNTIME_DIR, 'install.pid');
const MANAGER_INTERNAL_URL =
  process.env.MANAGER_INTERNAL_URL || `http://127.0.0.1:${Number(process.env.PORT) || 8787}`;

const runtimeState = {
  status: 'missing',
  message: '尚未安装 QQ 运行环境',
  progress: '',
  startedAt: 0,
  finishedAt: 0,
};

const startLocks = new Map();
const copyLocks = new Map();

/* ------------------------------- 工具函数 ------------------------------- */

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tailFile(file, lines = 80) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const all = text.split(/\r?\n/).filter((line, index, array) => line || index < array.length - 1);
    return all.slice(-lines).join('\n');
  } catch (_e) {
    return '';
  }
}

function ensureBaseDirs() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

function isRuntimeReady() {
  try {
    return fs.statSync(TEMPLATE_QQ).isFile();
  } catch (_e) {
    return false;
  }
}

function installerPid() {
  try {
    const pid = Number(fs.readFileSync(RUNTIME_PID_FILE, 'utf8').trim());
    return Number.isFinite(pid) && pid > 0 ? pid : 0;
  } catch (_e) {
    return 0;
  }
}

function installerAlive() {
  const pid = installerPid();
  return pid > 0 && isAlive(pid);
}

function removeInstallerPidFile() {
  try {
    fs.rmSync(RUNTIME_PID_FILE, { force: true });
  } catch (_e) {
    /* ignore */
  }
}

function getRuntimeState() {
  const ready = isRuntimeReady();
  if (ready) {
    if (runtimeState.status !== 'ready') {
      runtimeState.status = 'ready';
      runtimeState.message = 'QQ 运行环境已就绪';
      runtimeState.progress = '';
    }
    // 安装进程可能在上次面板退出期间完成，清理遗留的 PID 文件。
    if (installerPid()) removeInstallerPidFile();
  } else if (runtimeState.status === 'installing' && !installerAlive()) {
    removeInstallerPidFile();
    setRuntimeFailure('安装进程已退出，请查看安装日志后重试');
  } else if (runtimeState.status !== 'installing' && installerAlive()) {
    // 管理面板重启后接管仍在运行的安装进程。
    runtimeState.status = 'installing';
    runtimeState.message = '正在安装 Linux QQ 与 NapCat';
    runtimeState.progress = tailFile(RUNTIME_LOG, 1).trim();
  }
  return {
    ...runtimeState,
    ready,
    nodeBin: process.env.QQNAS_NODE_BIN || '',
    installer: INSTALLER,
    template: TEMPLATE_NAPCAT,
    installLog: RUNTIME_LOG,
    log: tailFile(RUNTIME_LOG, 40),
  };
}

function setRuntimeFailure(message) {
  runtimeState.status = 'error';
  runtimeState.message = message;
  runtimeState.finishedAt = Date.now();
}

/** 安装 QQ + NapCat 运行环境。安装过程在后台进行，面板可轮询进度。 */
function ensureRuntimeInBackground({ force = false } = {}) {
  ensureBaseDirs();
  if (runtimeState.status === 'installing') return getRuntimeState();
  if (isRuntimeReady() && !force) return getRuntimeState();

  if (!fs.existsSync(INSTALLER)) {
    setRuntimeFailure(`安装脚本缺失：${INSTALLER}`);
    return getRuntimeState();
  }

  // 管理面板重启后，接管仍在运行的安装进程，避免并发重复安装。
  if (installerAlive()) {
    runtimeState.status = 'installing';
    runtimeState.message = '正在安装 Linux QQ 与 NapCat';
    runtimeState.progress = tailFile(RUNTIME_LOG, 1).trim();
    return getRuntimeState();
  }

  fs.mkdirSync(TEMPLATE_HOME, { recursive: true });
  // 只清理上次失败留下的解压目录；已下载的 NapCat.Shell.zip / QQ.deb / QQ.rpm
  // 保留下来，重试时可以直接复用或续传（.part 残片也保留）。
  try {
    fs.rmSync(path.join(TEMPLATE_HOME, 'NapCat'), { recursive: true, force: true });
  } catch (_e) {
    /* ignore */
  }
  const logFd = fs.openSync(RUNTIME_LOG, 'a');
  const stamp = `\n===== ${new Date().toISOString()} 开始安装 QQ 运行环境 =====\n`;
  fs.writeSync(logFd, stamp);

  runtimeState.status = 'installing';
  runtimeState.message = '正在安装 Linux QQ 与 NapCat，首次安装约 5–20 分钟';
  runtimeState.progress = '准备下载安装包';
  runtimeState.startedAt = Date.now();
  runtimeState.finishedAt = 0;

  const env = { ...process.env, HOME: TEMPLATE_HOME, TZ: process.env.TZ || 'Asia/Shanghai' };
  delete env.DISPLAY;
  // 安装过程可能调用 apt-get，禁用交互式提示，避免后台安装卡住。
  env.DEBIAN_FRONTEND = 'noninteractive';
  env.APT_LISTCHANGES_FRONTEND = 'none';

  const child = spawn('bash', [INSTALLER, '--docker', 'n', '--cli', 'n', '--proxy', 'auto'], {
    cwd: TEMPLATE_HOME,
    env,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });

  if (child.pid) {
    try {
      fs.writeFileSync(RUNTIME_PID_FILE, String(child.pid), 'utf8');
    } catch (_e) {
      /* ignore */
    }
  }

  const clearChildPid = () => {
    if (child.pid && installerPid() === child.pid) removeInstallerPidFile();
  };

  const progressTimer = setInterval(() => {
    const text = tailFile(RUNTIME_LOG, 5);
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length) runtimeState.progress = lines[lines.length - 1].slice(0, 240);
  }, 2500);
  if (progressTimer.unref) progressTimer.unref();

  let finished = false;
  const finish = (message) => {
    if (finished) return;
    finished = true;
    clearInterval(progressTimer);
    clearChildPid();
    try {
      fs.closeSync(logFd);
    } catch (_e) {
      /* ignore */
    }
    if (isRuntimeReady()) {
      runtimeState.status = 'ready';
      runtimeState.message = 'QQ 运行环境已就绪';
      runtimeState.progress = '';
      runtimeState.finishedAt = Date.now();
    } else {
      setRuntimeFailure(message);
    }
  };

  child.on('error', (err) => {
    finish(`启动安装脚本失败：${err.message}`);
  });
  child.on('close', (code) => {
    finish(`安装未完成（退出码 ${code}），请查看运行环境日志`);
  });
  child.unref();
  return getRuntimeState();
}

/* ------------------------------- 账号目录 ------------------------------- */

function accountDirs(account) {
  const root = path.join(ACCOUNTS_DIR, account.id);
  const home = path.join(root, 'home');
  return {
    root,
    home,
    qqData: path.join(home, '.config', 'QQ'),
    log: path.join(LOG_DIR, `account-${account.id}.log`),
    pidFile: path.join(root, 'napcat.pid'),
    napcat: path.join(home, 'Napcat'),
    qq: path.join(home, 'Napcat', 'opt', 'QQ', 'qq'),
    config: path.join(home, 'Napcat', 'opt', 'QQ', 'resources', 'app', 'app_launcher', 'napcat', 'config'),
  };
}

function ensureAccountDirs(account) {
  const dirs = accountDirs(account);
  for (const dir of [
    dirs.root,
    dirs.home,
    path.join(dirs.home, '.config'),
    path.join(dirs.home, '.local', 'share'),
    path.join(dirs.home, '.cache'),
    path.join(dirs.home, '.runtime'),
    dirs.config,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  try {
    fs.chmodSync(path.join(dirs.home, '.runtime'), 0o700);
  } catch (_e) {
    /* 部分文件系统不支持 chmod */
  }
  return dirs;
}

/* ------------------------------- 运行环境复制 ------------------------------- */

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(`${command} 退出码 ${code}${stderr ? `：${stderr.slice(-300)}` : ''}`));
    });
  });
}

async function copyRuntime(account) {
  if (copyLocks.has(account.id)) return copyLocks.get(account.id);
  const task = (async () => {
    const dirs = ensureAccountDirs(account);
    if (fs.existsSync(dirs.qq)) return dirs;
    if (!isRuntimeReady()) throw new Error('QQ 运行环境尚未安装完成');

    fs.rmSync(dirs.napcat, { recursive: true, force: true });
    try {
      await runCommand('cp', ['-a', '--reflink=auto', TEMPLATE_NAPCAT, dirs.napcat]);
    } catch (_e) {
      fs.rmSync(dirs.napcat, { recursive: true, force: true });
      await runCommand('cp', ['-a', TEMPLATE_NAPCAT, dirs.napcat]);
    }
    if (!fs.existsSync(dirs.qq)) throw new Error('复制 QQ 运行文件失败');
    return dirs;
  })();
  copyLocks.set(account.id, task);
  try {
    return await task;
  } finally {
    copyLocks.delete(account.id);
  }
}

/* ------------------------------- 配置写入 ------------------------------- */

function writeJsonFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function writeWebuiConfig(account) {
  const dirs = ensureAccountDirs(account);
  const file = path.join(dirs.config, 'webui.json');
  writeJsonFile(file, {
    host: '0.0.0.0',
    port: Number(account.webuiPort) || 6099,
    token: account.webuiToken,
    loginRate: 3,
  });
}

function buildOnebotConfig(account) {
  const port = Number(account.onebotPort) || 3000;
  const hookUrl = `${MANAGER_INTERNAL_URL.replace(/\/+$/, '')}/onebot/event/${account.id}?secret=${account.hookSecret}`;
  return {
    network: {
      httpServers: [
        {
          name: 'qqnas-http',
          enable: true,
          host: '127.0.0.1',
          port,
          token: account.onebotToken,
          messagePostFormat: 'array',
          debug: false,
        },
      ],
      httpSseServers: [],
      httpClients: [
        {
          name: 'qqnas-manager',
          enable: true,
          url: hookUrl,
          messagePostFormat: 'array',
          reportSelfMessage: false,
          token: '',
          debug: false,
        },
      ],
      websocketServers: [],
      websocketClients: [],
      plugins: [],
    },
    musicSignUrl: '',
    enableLocalFile2Url: false,
    parseMultMsg: false,
  };
}

function writeOnebotConfig(account) {
  const dirs = ensureAccountDirs(account);
  writeJsonFile(path.join(dirs.config, 'onebot11.json'), buildOnebotConfig(account));
}

/** 登录后补写账号级配置，保留已有网络配置，只补缺失的 HTTP 服务端与事件回调。 */
function ensureAccountOnebotConfig(account, uin) {
  if (!uin) return false;
  const dirs = ensureAccountDirs(account);
  const file = path.join(dirs.config, `onebot11_${uin}.json`);
  const desired = buildOnebotConfig(account);
  const existed = fs.existsSync(file);
  let config;
  if (existed) {
    try {
      config = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_e) {
      config = desired;
    }
  } else {
    config = desired;
  }
  config.network = config.network || {};
  config.network.httpServers = Array.isArray(config.network.httpServers) ? config.network.httpServers : [];
  config.network.httpClients = Array.isArray(config.network.httpClients) ? config.network.httpClients : [];

  const hasHttp = config.network.httpServers.some((s) => s && s.name === 'qqnas-http');
  const hasHook = config.network.httpClients.some((c) => c && c.name === 'qqnas-manager');
  if (!hasHttp) config.network.httpServers.push(desired.network.httpServers[0]);
  if (!hasHook) config.network.httpClients.push(desired.network.httpClients[0]);

  const before = JSON.stringify(config);
  writeJsonFile(file, config);
  return !existed || before !== JSON.stringify(config);
}

/* ------------------------------- 进程管理 ------------------------------- */

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_e) {
    return false;
  }
}

function readPid(account) {
  const dirs = accountDirs(account);
  try {
    const value = Number(fs.readFileSync(dirs.pidFile, 'utf8').trim());
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch (_e) {
    return 0;
  }
}

function probePort(port, timeout = 400) {
  return new Promise((resolve) => {
    if (!port) return resolve(false);
    const socket = net.connect({ host: '127.0.0.1', port: Number(port) });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** 判断进程是否真的属于该账号（HOME 指向账号目录），避免 PID 复用误杀。 */
function processBelongsToHome(pid, home) {
  if (process.platform !== 'linux') return true;
  try {
    return fs.readFileSync(`/proc/${pid}/environ`).includes(Buffer.from(`HOME=${home}\0`));
  } catch (_e) {
    return false;
  }
}

/** 只查找 HOME 指向本账号目录的进程，避免误伤系统或其它应用。 */
function findPidsByHome(home) {
  if (process.platform !== 'linux') return [];
  const target = Buffer.from(`HOME=${home}\0`);
  const result = [];
  let entries = [];
  try {
    entries = fs.readdirSync('/proc');
  } catch (_e) {
    return result;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const environ = fs.readFileSync(`/proc/${name}/environ`);
      if (environ.includes(target)) result.push(Number(name));
    } catch (_e) {
      /* 进程已退出或没有权限 */
    }
  }
  return result;
}

const PROTECTED_COMMS = new Set([
  'tac-server',
  'tac-cli',
  'qodercli',
  'node',
  'XLSmartTray',
  'XLSmartUI',
  'XLSmartService',
]);

/** 系统与天禧相关进程一律不发送信号。 */
function isProtectedPid(pid) {
  if (process.platform !== 'linux') return false;
  try {
    const comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
    if (PROTECTED_COMMS.has(comm)) return true;
    return /tianxi|天禧/i.test(comm);
  } catch (_e) {
    return false;
  }
}

async function killProcessGroup(pid, { force = false } = {}) {
  if (!pid || pid === 1 || pid === process.pid) return;
  if (isProtectedPid(pid)) return;
  const signal = force ? 'SIGKILL' : 'SIGTERM';
  try {
    process.kill(-pid, signal);
  } catch (_e) {
    try {
      process.kill(pid, signal);
    } catch (_e2) {
      /* 已退出 */
    }
  }
}

async function waitGone(pids, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pids.some((pid) => isAlive(pid))) return true;
    await sleep(200);
  }
  return false;
}

async function prepareAccount(account) {
  const dirs = await copyRuntime(account);
  writeWebuiConfig(account);
  writeOnebotConfig(account);
  return dirs;
}

async function startAccount(account) {
  account.desiredState = 'running';
  const dirs = ensureAccountDirs(account);
  const existing = readPid(account);
  if (existing && isAlive(existing) && processBelongsToHome(existing, dirs.home)) {
    account.pid = existing;
    account.containerState = 'running';
    return { ok: true, pid: existing, already: true };
  }
  if (startLocks.has(account.id)) return startLocks.get(account.id);

  const task = (async () => {
    if (!isRuntimeReady()) {
      startRuntimeIfNeeded(account);
      account.containerState = 'waiting';
      return { ok: false, message: 'QQ 运行环境正在安装' };
    }
    await prepareAccount(account);
    // 登录态目录缺失时（误清/损坏/迁移）用最近快照恢复，保住免扫码自动登录。
    await restoreSessionStateIfMissing(dirs);

    const logFd = fs.openSync(dirs.log, 'a');
    fs.writeSync(logFd, `\n===== ${new Date().toISOString()} 启动 NapCat =====\n`);

    const env = { ...process.env, HOME: dirs.home };
    delete env.DISPLAY;
    env.XDG_CONFIG_HOME = path.join(dirs.home, '.config');
    env.XDG_DATA_HOME = path.join(dirs.home, '.local', 'share');
    env.XDG_CACHE_HOME = path.join(dirs.home, '.cache');
    env.XDG_RUNTIME_DIR = path.join(dirs.home, '.runtime');
    env.TZ = process.env.TZ || 'Asia/Shanghai';
    env.LANG = process.env.LANG || 'C.UTF-8';

    const args = [
      '-a',
      '-s',
      '-screen 0 1280x800x24',
      dirs.qq,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
    ];
    const child = spawn('xvfb-run', args, {
      cwd: dirs.home,
      env,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    fs.closeSync(logFd);

    if (!child.pid) throw new Error('无法启动 QQ 进程');
    fs.writeFileSync(dirs.pidFile, String(child.pid), 'utf8');
    account.pid = child.pid;
    account.startedAt = Date.now();
    account.containerState = 'running';
    return { ok: true, pid: child.pid };
  })();

  startLocks.set(account.id, task);
  try {
    return await task;
  } catch (err) {
    account.containerState = 'error';
    account.lastError = err.message;
    throw err;
  } finally {
    startLocks.delete(account.id);
  }
}

/* ------------------------------- 登录态保护 ------------------------------- */

/**
 * QQ 登录态（设备信息、登录票据）保存在 ~/.config/QQ/nt_qq/global，体积很小。
 * 每次停止进程前先快照、启动时若目录缺失则用快照恢复，确保各种重启
 * （保活自动重启、手动重启、面板或 NAS 重启后拉起）都保住登录状态，
 * 即使进程被 SIGKILL 强杀或断电导致票据损坏，也不必重新扫码。
 */
function sessionGlobalDir(dirs) {
  return path.join(dirs.qqData, 'nt_qq', 'global');
}

function sessionBackupPaths(dirs) {
  const live = path.join(dirs.root, 'session-backup');
  return { staging: `${live}.new`, live, prev: `${live}.prev` };
}

/** 停止前快照登录态，滚动保留最近两份。 */
async function backupSessionState(dirs) {
  const src = sessionGlobalDir(dirs);
  if (!fs.existsSync(src)) return false;
  const { staging, live, prev } = sessionBackupPaths(dirs);
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    await runCommand('cp', ['-a', src, staging]);
    if (fs.existsSync(live)) {
      fs.rmSync(prev, { recursive: true, force: true });
      fs.renameSync(live, prev);
    }
    fs.renameSync(staging, live);
    return true;
  } catch (_e) {
    fs.rmSync(staging, { recursive: true, force: true });
    return false;
  }
}

/** 启动前若登录态目录缺失（数据被误清或异常损坏），用最近一份快照恢复。 */
async function restoreSessionStateIfMissing(dirs) {
  const target = sessionGlobalDir(dirs);
  if (fs.existsSync(target)) return false;
  const { live, prev } = sessionBackupPaths(dirs);
  for (const backup of [live, prev]) {
    if (!fs.existsSync(backup)) continue;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await runCommand('cp', ['-a', backup, target]);
      return true;
    } catch (_e) {
      /* 尝试上一份快照 */
    }
  }
  return false;
}

async function stopAccount(account, { preserveDesired = false } = {}) {
  if (!preserveDesired) account.desiredState = 'stopped';
  const dirs = accountDirs(account);
  // 先快照登录态再停进程，防止强杀/断电导致票据损坏后无法自动重登。
  await backupSessionState(dirs);
  const candidate = readPid(account) || Number(account.pid) || 0;
  const pid = candidate && processBelongsToHome(candidate, dirs.home) ? candidate : 0;
  const homePids = findPidsByHome(dirs.home);
  const pids = Array.from(new Set([pid, ...homePids].filter(Boolean)));

  for (const item of pids) await killProcessGroup(item);
  if (pids.length) {
    // 给足 10 秒让 QQ 把登录态写盘，尽量避免走到 SIGKILL。
    const gone = await waitGone(pids, 10000);
    if (!gone) {
      for (const item of pids) {
        if (isAlive(item)) await killProcessGroup(item, { force: true });
      }
      await waitGone(pids, 2000);
    }
  }
  try {
    fs.rmSync(dirs.pidFile, { force: true });
  } catch (_e) {
    /* ignore */
  }
  account.pid = 0;
  account.containerState = 'exited';
  return { ok: true };
}

async function restartAccount(account) {
  await stopAccount(account);
  await sleep(800);
  return startAccount(account);
}

async function statusAccount(account) {
  const dirs = accountDirs(account);
  const pid = readPid(account) || Number(account.pid) || 0;
  const running = pid > 0 && isAlive(pid) && processBelongsToHome(pid, dirs.home);
  if (running) {
    account.containerState = 'running';
    account.pid = pid;
  } else if (account.containerState === 'running' || account.containerState === 'starting') {
    account.containerState = 'exited';
    account.pid = 0;
  }
  return {
    running,
    state: account.containerState || 'exited',
    pid,
    webuiReady: running ? await probePort(account.webuiPort, 300) : false,
    startedAt: account.startedAt || 0,
  };
}

function startRuntimeIfNeeded(account) {
  if (!isRuntimeReady() && runtimeState.status !== 'installing') {
    ensureRuntimeInBackground();
  }
  if (account) account.containerState = 'waiting';
}

async function removeAccountRuntime(account) {
  await stopAccount(account).catch(() => {});
  const dirs = accountDirs(account);
  fs.rmSync(dirs.root, { recursive: true, force: true });
}

function getAccountLogs(account, lines = 120) {
  const dirs = accountDirs(account);
  return tailFile(dirs.log, lines);
}

/* ------------------------------- WebUI API ------------------------------- */

function webuiRequest(baseUrl, method, pathName, body, credential, timeout = 8000) {
  const url = new URL(baseUrl.replace(/\/+$/, '') + pathName);
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
  const headers = { 'Content-Type': 'application/json' };
  if (payload) headers['Content-Length'] = payload.length;
  if (credential) headers.Authorization = `Bearer ${credential}`;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method,
        headers,
        timeout,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve(JSON.parse(text));
          } catch (_e) {
            reject(new Error(`WebUI 返回非 JSON：${text.slice(0, 120)}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('WebUI 请求超时')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const credentialCache = new Map();

function webuiBase(account) {
  if (!account.webuiPort) throw new Error('账号 WebUI 端口尚未分配');
  return `http://127.0.0.1:${account.webuiPort}`;
}

async function webuiLogin(account) {
  const baseUrl = webuiBase(account);
  const cached = credentialCache.get(account.id);
  if (cached && Date.now() < cached.expires) return cached.credential;

  const hash = sha256(`${account.webuiToken}.napcat`);
  const result = await webuiRequest(baseUrl, 'POST', '/api/auth/login', { hash });
  if (!result || result.code !== 0 || !result.data || !result.data.Credential) {
    throw new Error((result && result.message) || 'WebUI 登录失败');
  }
  const credential = result.data.Credential;
  credentialCache.set(account.id, { credential, expires: Date.now() + 50 * 60 * 1000 });
  return credential;
}

async function webuiPost(account, pathName, body = {}, timeout = 8000) {
  const baseUrl = webuiBase(account);
  let credential = await webuiLogin(account);
  let result = await webuiRequest(baseUrl, 'POST', pathName, body, credential, timeout);
  if (result && result.code !== 0 && /Unauthorized|token/i.test(result.message || '')) {
    credentialCache.delete(account.id);
    credential = await webuiLogin(account);
    result = await webuiRequest(baseUrl, 'POST', pathName, body, credential, timeout);
  }
  return result;
}

/** 二维码生成是阻塞式的：NapCat 要等 QQ 出图，启动初期可达几十秒，8 秒默认值等不到。 */
const QRCODE_FETCH_TIMEOUT = 45000;

/** 不同 NapCat 版本返回二维码的字段不一致，统一取出可用内容。 */
function extractQrcode(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  return (
    data.qrcode || data.qrcodeurl || data.qrcodeUrl || data.url || data.base64 || data.image || ''
  );
}

async function getWebuiLoginState(account) {
  const status = await webuiPost(account, '/api/QQLogin/CheckLoginStatus');
  if (!status || status.code !== 0) {
    throw new Error((status && status.message) || '无法读取登录状态');
  }
  const data = status.data || {};
  let qrcode = extractQrcode(data);
  if (!data.isLogin && !qrcode) {
    const qr = await webuiPost(account, '/api/QQLogin/GetQQLoginQrcode', {}, QRCODE_FETCH_TIMEOUT);
    if (qr && qr.code === 0) qrcode = extractQrcode(qr.data);
    // 被踢下线的账号内核常卡在旧票据快速重登循环里，不进扫码阶段，
    // 被动取码一直为空；主动 Refresh 强制切回扫码阶段出码。
    if (!qrcode) {
      const refreshed = await webuiPost(account, '/api/QQLogin/RefreshQRcode', {}, QRCODE_FETCH_TIMEOUT);
      if (refreshed && refreshed.code === 0) qrcode = extractQrcode(refreshed.data);
    }
  }
  let info = null;
  if (data.isLogin) {
    try {
      const infoResult = await webuiPost(account, '/api/QQLogin/GetQQLoginInfo');
      if (infoResult && infoResult.code === 0) info = infoResult.data || null;
    } catch (_e) {
      /* 信息接口失败不影响登录状态 */
    }
  }
  return {
    isLogin: Boolean(data.isLogin),
    isOffline: Boolean(data.isOffline),
    phase: data.loginPhase || '',
    error: data.loginError || '',
    qrcode,
    info,
  };
}

/**
 * 强制回到扫码登录：清掉本地登录票据与登录态快照后再启动。
 * 账号被踢下线后，QQ 内核会拿旧票据反复重登、永远不进扫码页，
 * 此时只有丢掉旧票据才能让 QQ 重新生成二维码。
 */
async function resetLoginState(account) {
  await stopAccount(account, { preserveDesired: true });
  const dirs = accountDirs(account);
  const { live, prev } = sessionBackupPaths(dirs);
  // 旧快照同样是被踢的票据，必须一并清掉，否则下次启动又会被恢复。
  fs.rmSync(live, { recursive: true, force: true });
  fs.rmSync(prev, { recursive: true, force: true });
  const stale = path.join(dirs.root, 'session-stale');
  fs.rmSync(stale, { recursive: true, force: true });
  try {
    const src = sessionGlobalDir(dirs);
    if (fs.existsSync(src)) fs.renameSync(src, stale);
  } catch (_e) {
    fs.rmSync(sessionGlobalDir(dirs), { recursive: true, force: true });
  }
  await sleep(600);
  return startAccount(account);
}

async function refreshQrcode(account) {
  const result = await webuiPost(account, '/api/QQLogin/RefreshQRcode', {}, QRCODE_FETCH_TIMEOUT);
  if (result && result.code === 0) return extractQrcode(result.data);
  return '';
}

async function deleteAccountData(account) {
  await removeAccountRuntime(account);
}

module.exports = {
  ACCOUNTS_DIR,
  RUNTIME_DIR,
  TEMPLATE_HOME,
  accountDirs,
  ensureAccountDirs,
  isRuntimeReady,
  getRuntimeState,
  ensureRuntimeInBackground,
  prepareAccount,
  startAccount,
  stopAccount,
  restartAccount,
  backupSessionState,
  restoreSessionStateIfMissing,
  statusAccount,
  startRuntimeIfNeeded,
  removeAccountRuntime,
  getAccountLogs,
  writeOnebotConfig,
  ensureAccountOnebotConfig,
  getWebuiLoginState,
  refreshQrcode,
  resetLoginState,
  deleteAccountData,
  webuiLogin,
  probePort,
};
