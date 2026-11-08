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
const expectedExits = new Map();

/* ------------------------------- 工具函数 ------------------------------- */

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 账号级生命周期锁：start/stop/restart/snapshot/restore/reset 共用一条队列。
 * 后到的请求排在前面操作完成之后执行，从而让“最后一次操作”落到最终状态。
 */
const accountLocks = new Map();

function withAccountLock(accountOrId, task) {
  const id = typeof accountOrId === 'string' ? accountOrId : accountOrId.id;
  const previous = accountLocks.get(id) || Promise.resolve();
  const run = previous.then(() => task());
  const gate = run.catch(() => {});
  const stored = gate.finally(() => {
    if (accountLocks.get(id) === stored) accountLocks.delete(id);
  });
  accountLocks.set(id, stored);
  return run;
}

const RESTART_GUARD_DEFAULTS = Object.freeze({
  suspended: false,
  failures: 0,
  attempts: 0,
  nextRetryAt: 0,
  lastAttemptAt: 0,
  updatedAt: 0,
});

function ensureRestartGuard(account) {
  account.autoRestartGuard = { ...RESTART_GUARD_DEFAULTS, ...(account.autoRestartGuard || {}) };
  return account.autoRestartGuard;
}

function resetRestartGuard(account) {
  account.autoRestartGuard = { ...RESTART_GUARD_DEFAULTS, updatedAt: Date.now() };
  return account.autoRestartGuard;
}

function restartBackoffMs(attempts) {
  const n = Math.max(1, Number(attempts) || 1);
  return Math.min(30 * 60 * 1000, 30 * 1000 * Math.pow(2, n - 1));
}

function noteRestartAttempt(account) {
  const guard = ensureRestartGuard(account);
  guard.attempts = Number(guard.attempts || 0) + 1;
  guard.lastAttemptAt = Date.now();
  guard.nextRetryAt = Date.now() + restartBackoffMs(guard.attempts);
  guard.updatedAt = Date.now();
  return guard;
}

function noteRestartFailure(account) {
  const guard = ensureRestartGuard(account);
  guard.failures = Number(guard.failures || 0) + 1;
  guard.updatedAt = Date.now();
  return guard;
}

function canAutoRestart(account, now = Date.now()) {
  const guard = ensureRestartGuard(account);
  return !guard.suspended && now >= Number(guard.nextRetryAt || 0);
}

function appendAccountLog(account, message) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(accountDirs(account).log, `[${new Date().toISOString()}] ${message}\n`);
  } catch (_e) {
    /* 日志失败不能影响主流程 */
  }
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

function runCommandOutput(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} 退出码 ${code}${stderr ? `：${stderr.slice(-300)}` : ''}`));
    });
  });
}

async function measureDirSize(dir) {
  try {
    const output = await runCommandOutput('du', ['-sb', dir]);
    const bytes = Number(String(output).trim().split(/\s+/)[0]);
    return Number.isFinite(bytes) ? bytes : 0;
  } catch (_e) {
    return 0;
  }
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

async function assertPortsAvailable(account) {
  const ports = [
    ['WebUI', Number(account.webuiPort) || 0],
    ['OneBot', Number(account.onebotPort) || 0],
  ];
  for (const [name, port] of ports) {
    if (!port) continue;
    if (await probePort(port)) {
      throw new Error(`${name} 端口 ${port} 已被占用，请先停止占用该端口的进程`);
    }
  }
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
  return withAccountLock(account, () => startAccountUnlocked(account));
}

async function startAccountUnlocked(account) {
  account.desiredState = 'running';
  const dirs = ensureAccountDirs(account);
  const existing = readPid(account);
  if (existing && isAlive(existing) && processBelongsToHome(existing, dirs.home)) {
    account.pid = existing;
    account.containerState = 'running';
    return { ok: true, pid: existing, already: true };
  }
  if (startLocks.has(account.id)) return startLocks.get(account.id);

  // pid 文件可能丢失或过期，但 QQ 仍以本账号 HOME 存活：先接管，避免同 HOME 起第二份。
  const homePids = findPidsByHome(dirs.home).filter((pid) => isAlive(pid) && !isProtectedPid(pid));
  if (homePids.length) {
    if (homePids.length === 1) {
      const pid = homePids[0];
      fs.writeFileSync(dirs.pidFile, String(pid), 'utf8');
      account.pid = pid;
      account.containerState = 'running';
      appendAccountLog(account, `发现同 HOME 的孤儿 NapCat 进程 ${pid}，已接管`);
      return { ok: true, pid, adopted: true };
    }
    appendAccountLog(account, `发现 ${homePids.length} 个同 HOME 孤儿进程，先全部停止再重新启动`);
    for (const pid of homePids) await killProcessGroup(pid);
    await waitGone(homePids, 5000);
  }

  const task = (async () => {
    if (!isRuntimeReady()) {
      startRuntimeIfNeeded(account);
      account.containerState = 'waiting';
      return { ok: false, message: 'QQ 运行环境正在安装' };
    }
    await prepareAccount(account);
    // 登录态目录缺失或关键文件不可用时用快照恢复，保住免扫码自动登录。
    await restoreSessionStateIfMissingUnlocked(account, dirs);
    await assertPortsAvailable(account);

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

    child.on('error', (err) => {
      const current = readPid(account);
      if (child.pid && current === child.pid) {
        try {
          fs.rmSync(dirs.pidFile, { force: true });
        } catch (_e) {
          /* ignore */
        }
        account.pid = 0;
      }
      if (!expectedExits.get(account.id)) {
        account.containerState = 'error';
        account.lastError = `QQ 进程启动失败：${err.message}`;
        if (account.stats) account.stats.online = false;
      }
      appendAccountLog(account, `QQ 进程 error：${err.message}`);
    });

    child.on('exit', (code, signal) => {
      const current = readPid(account);
      if (child.pid && current === child.pid) {
        try {
          fs.rmSync(dirs.pidFile, { force: true });
        } catch (_e) {
          /* ignore */
        }
        account.pid = 0;
      }
      const expected = expectedExits.get(account.id) === child.pid;
      appendAccountLog(
        account,
        `QQ 进程退出：code=${code === null ? 'null' : code} signal=${signal || 'none'}${expected ? '（主动停止）' : '（异常退出）'}`
      );
      if (!expected) {
        account.containerState = 'error';
        account.lastError = `QQ 进程异常退出（code=${code === null ? 'null' : code}, signal=${signal || 'none'}）`;
        account.lastExitAt = Date.now();
        if (account.stats) account.stats.online = false;
        const guard = noteRestartFailure(account);
        guard.updatedAt = Date.now();
      }
    });

    if (!child.pid) throw new Error('无法启动 QQ 进程');
    fs.writeFileSync(dirs.pidFile, String(child.pid), 'utf8');
    account.pid = child.pid;
    account.startedAt = Date.now();
    account.containerState = 'running';

    // 启动 90 秒后记录一次 WebUI 权威 isLogin，下一次重启时可直接看到“起来后到底登没登”。
    const loginCheckTimer = setTimeout(async () => {
      if (account.desiredState !== 'running' || Number(account.pid) !== Number(child.pid)) return;
      const login = await getWebuiLoginStatus(account, 5000);
      noteRecovery(account, {
        phase: 'post-start',
        webuiIsLogin: login ? login.isLogin : null,
        error: login ? (login.isLogin ? '' : `WebUI 返回未登录${login.isOffline ? '（离线）' : ''}`) : 'WebUI 无响应',
      });
    }, 90000);
    if (loginCheckTimer.unref) loginCheckTimer.unref();

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
 * QQ 登录态（设备信息、登录票据）保存在 ~/.config/QQ/nt_qq/global。
 * 停止前快照、启动时校验并恢复，确保各种重启都尽量保住登录状态。
 */
function sessionGlobalDir(dirs) {
  return path.join(dirs.qqData, 'nt_qq', 'global');
}

function sessionBackupPaths(dirs) {
  const live = path.join(dirs.root, 'session-backup');
  return { staging: `${live}.new`, live, prev: `${live}.prev` };
}

function goodSessionPaths(dirs) {
  const live = path.join(dirs.root, 'session-good');
  return {
    live,
    prev: `${live}.prev`,
    liveMeta: `${live}.meta.json`,
    prevMeta: `${live}.prev.meta.json`,
  };
}

function readSnapshotMeta(dirOrMeta) {
  const file = dirOrMeta.endsWith('.json') ? dirOrMeta : `${dirOrMeta}.meta.json`;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_e) {
    return null;
  }
}

function writeSnapshotMeta(dir, meta) {
  try {
    fs.writeFileSync(`${dir}.meta.json`, JSON.stringify(meta, null, 2), 'utf8');
  } catch (_e) {
    /* 元信息写失败不影响快照本身 */
  }
}

/** 以有限深度统计目录中的普通文件数与字节数，用于判断快照是否“非空可用”。 */
function inspectDir(dir, limit = 50) {
  const result = { exists: false, files: 0, bytes: 0 };
  try {
    if (!fs.statSync(dir).isDirectory()) return result;
  } catch (_e) {
    return result;
  }
  result.exists = true;
  const stack = [dir];
  while (stack.length && result.files < limit) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_e) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        result.files += 1;
        try {
          result.bytes += fs.statSync(full).size;
        } catch (_e) {
          /* ignore */
        }
        if (result.files >= limit) break;
      }
    }
  }
  return result;
}

/** 完整 nt_qq 快照必须包含非空的 global 子目录。 */
function inspectNtSnapshot(dir) {
  const base = inspectDir(dir, 1);
  if (!base.exists) return { ...base, valid: false };
  const global = inspectDir(path.join(dir, 'global'));
  return {
    ...base,
    globalFiles: global.files,
    globalBytes: global.bytes,
    valid: base.exists && global.files > 0 && global.bytes > 0,
  };
}

function inspectGlobalSnapshot(dir) {
  const info = inspectDir(dir);
  return { ...info, valid: info.exists && info.files > 0 && info.bytes > 0 };
}

async function describeSnapshot(dir, fullNt) {
  const inspection = fullNt ? inspectNtSnapshot(dir) : inspectGlobalSnapshot(dir);
  const meta = readSnapshotMeta(dir);
  let byteSize = Number(meta && meta.size) || 0;
  if (!byteSize && inspection.exists) byteSize = await measureDirSize(dir);
  let mtime = 0;
  try {
    mtime = Math.round(fs.statSync(dir).mtimeMs);
  } catch (_e) {
    /* ignore */
  }
  return {
    path: dir,
    exists: inspection.exists,
    valid: inspection.valid,
    files: inspection.files,
    size: byteSize,
    verifiedAt: Number(meta && (meta.verifiedAt || meta.createdAt)) || mtime,
    meta,
  };
}

async function copyDir(src, dest) {
  try {
    // fnOS 用 btrfs 时 reflink 几乎不占空间；不支持则自动全量复制。
    await runCommand('cp', ['-a', '--reflink=auto', src, dest]);
  } catch (_e) {
    fs.rmSync(dest, { recursive: true, force: true });
    await runCommand('cp', ['-a', src, dest]);
  }
}

/**
 * 复制到临时目录 -> 校验 -> 原子 rename。
 * 目标目录在校验通过前不会被删除；rename 失败会把原目录移回来。
 */
async function replaceDirAtomically(src, target, validator) {
  const parent = path.dirname(target);
  const suffix = crypto.randomBytes(6).toString('hex');
  const temp = `${target}.restore-${suffix}`;
  const aside = `${target}.old-${suffix}`;
  fs.mkdirSync(parent, { recursive: true });
  try {
    fs.rmSync(temp, { recursive: true, force: true });
    await copyDir(src, temp);
    if (!validator(temp)) throw new Error('复制后的快照校验失败');
    let moved = false;
    if (fs.existsSync(target)) {
      fs.renameSync(target, aside);
      moved = true;
    }
    try {
      fs.renameSync(temp, target);
    } catch (err) {
      if (moved) {
        try {
          fs.renameSync(aside, target);
        } catch (_restoreErr) {
          throw new Error(`${err.message}；原目录暂存在 ${aside}`);
        }
      }
      throw err;
    }
    if (moved) fs.rmSync(aside, { recursive: true, force: true });
    return true;
  } catch (err) {
    fs.rmSync(temp, { recursive: true, force: true });
    throw err;
  }
}

const RECOVERY_DEFAULTS = {
  at: 0,
  snapshotFound: false,
  snapshotAt: 0,
  snapshotSize: 0,
  snapshotSource: '',
  restoreAttempted: false,
  restoreResult: '',
  restoreAction: '',
  webuiIsLogin: null,
  error: '',
};

function noteRecovery(account, patch = {}) {
  const { silent = false, ...data } = patch;
  account.loginRecovery = { ...RECOVERY_DEFAULTS, ...(account.loginRecovery || {}), ...data, at: Date.now() };
  if (!silent) {
    const record = account.loginRecovery;
    appendAccountLog(
      account,
      `登录态诊断 ${JSON.stringify({
        phase: record.phase || '',
        snapshotFound: record.snapshotFound,
        snapshotAt: record.snapshotAt ? new Date(record.snapshotAt).toISOString() : '',
        snapshotSize: record.snapshotSize,
        snapshotSource: record.snapshotSource,
        restoreAttempted: record.restoreAttempted,
        restoreAction: record.restoreAction,
        restoreResult: record.restoreResult,
        webuiIsLogin: record.webuiIsLogin,
        error: record.error || '',
      })}`
    );
  }
  return account.loginRecovery;
}

/** 停止前快照登录态，滚动保留最近两份。 */
async function backupSessionState(dirs) {
  const src = sessionGlobalDir(dirs);
  if (!inspectGlobalSnapshot(src).valid) return false;
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

/** 启动前校验登录态：目录存在但关键文件为空/缺失时也算不可用并恢复。 */
async function restoreSessionStateIfMissing(account) {
  return withAccountLock(account, () => restoreSessionStateIfMissingUnlocked(account, accountDirs(account)));
}

async function restoreSessionStateIfMissingUnlocked(account, dirs) {
  const ntDir = path.join(dirs.qqData, 'nt_qq');
  const global = sessionGlobalDir(dirs);
  const ntState = inspectNtSnapshot(ntDir);
  const globalState = inspectGlobalSnapshot(global);
  const goodPaths = goodSessionPaths(dirs);
  const goods = [
    ['session-good', goodPaths.live],
    ['session-good.prev', goodPaths.prev],
  ];
  const backupPaths = sessionBackupPaths(dirs);
  const backups = [
    ['session-backup', backupPaths.live],
    ['session-backup.prev', backupPaths.prev],
  ];
  const goodReports = [];
  for (const [name, dir] of goods) {
    const report = await describeSnapshot(dir, true);
    if (report.valid) goodReports.push({ name, ...report });
  }
  const backupReports = [];
  for (const [name, dir] of backups) {
    const report = await describeSnapshot(dir, false);
    if (report.valid) backupReports.push({ name, ...report });
  }
  const bestGood = goodReports[0];
  const baseRecord = {
    phase: 'startup',
    snapshotFound: goodReports.length > 0,
    snapshotAt: bestGood ? bestGood.verifiedAt : 0,
    snapshotSize: bestGood ? bestGood.size : 0,
    snapshotSource: bestGood ? bestGood.name : '',
    ntNtExists: ntState.exists,
    ntNtValid: ntState.valid,
    globalExists: globalState.exists,
    globalValid: globalState.valid,
    goodSnapshotFound: goodReports.length > 0,
    globalBackupFound: backupReports.length > 0,
  };

  if (!ntState.valid) {
    for (const report of goodReports) {
      try {
        await replaceDirAtomically(report.path, ntDir, (dir) => inspectNtSnapshot(dir).valid);
        noteRecovery(account, {
          ...baseRecord,
          snapshotFound: true,
          snapshotAt: report.verifiedAt,
          snapshotSize: report.size,
          snapshotSource: report.name,
          restoreAttempted: true,
          restoreAction: 'restore-nt_qq',
          restoreResult: 'success',
          error: '',
        });
        return true;
      } catch (err) {
        noteRecovery(account, {
          ...baseRecord,
          snapshotFound: true,
          snapshotAt: report.verifiedAt,
          snapshotSize: report.size,
          snapshotSource: report.name,
          restoreAttempted: true,
          restoreAction: 'restore-nt_qq',
          restoreResult: 'failed',
          error: err.message,
        });
      }
    }
  }

  if (!globalState.valid) {
    for (const report of backupReports) {
      try {
        await replaceDirAtomically(report.path, global, (dir) => inspectGlobalSnapshot(dir).valid);
        noteRecovery(account, {
          ...baseRecord,
          snapshotSource: report.name,
          snapshotAt: report.verifiedAt,
          snapshotSize: report.size,
          restoreAttempted: true,
          restoreAction: 'restore-global',
          restoreResult: 'success',
          error: '',
        });
        return true;
      } catch (err) {
        noteRecovery(account, {
          ...baseRecord,
          snapshotSource: report.name,
          snapshotAt: report.verifiedAt,
          snapshotSize: report.size,
          restoreAttempted: true,
          restoreAction: 'restore-global',
          restoreResult: 'failed',
          error: err.message,
        });
      }
    }
  }

  noteRecovery(account, {
    ...baseRecord,
    restoreAttempted: false,
    restoreAction: 'none',
    restoreResult: ntState.valid ? 'existing-nt_qq' : 'no-valid-snapshot',
    error: '',
  });
  return false;
}

/* ------------------------- 登录成功后的完整快照 ------------------------- */

async function snapshotGoodLogin(account, options = {}) {
  return withAccountLock(account, () => snapshotGoodLoginUnlocked(account, options));
}

/** 只有 WebUI 权威确认 isLogin=true 时才做完整快照，未验证的数据绝不覆盖旧 good。 */
async function snapshotGoodLoginUnlocked(account, { verified = false, uin = '' } = {}) {
  const dirs = accountDirs(account);
  const src = path.join(dirs.qqData, 'nt_qq');
  const paths = goodSessionPaths(dirs);
  if (!verified) {
    noteRecovery(account, {
      phase: 'snapshot',
      snapshotFound: false,
      snapshotAt: 0,
      snapshotSize: 0,
      restoreAction: 'snapshot-skip',
      restoreResult: 'skipped',
      webuiIsLogin: false,
      error: 'WebUI 未确认 isLogin=true，不生成/不覆盖 good 快照',
    });
    return false;
  }
  const sourceState = inspectNtSnapshot(src);
  if (!sourceState.valid) {
    noteRecovery(account, {
      phase: 'snapshot',
      snapshotFound: false,
      snapshotAt: 0,
      snapshotSize: 0,
      restoreAction: 'snapshot-skip',
      restoreResult: 'failed',
      webuiIsLogin: true,
      error: '当前 nt_qq 缺少可用 global 数据，未生成快照',
    });
    return false;
  }
  const staging = `${paths.live}.${crypto.randomBytes(6).toString('hex')}.new`;
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    await copyDir(src, staging);
    if (!inspectNtSnapshot(staging).valid) throw new Error('快照复制后校验失败');
    const size = await measureDirSize(staging);
    let rotated = false;
    if (fs.existsSync(paths.live)) {
      fs.rmSync(paths.prev, { recursive: true, force: true });
      fs.rmSync(paths.prevMeta, { force: true });
      fs.renameSync(paths.live, paths.prev);
      if (fs.existsSync(paths.liveMeta)) fs.renameSync(paths.liveMeta, paths.prevMeta);
      rotated = true;
    }
    try {
      fs.renameSync(staging, paths.live);
    } catch (err) {
      if (rotated) {
        try {
          fs.renameSync(paths.prev, paths.live);
          if (fs.existsSync(paths.prevMeta)) fs.renameSync(paths.prevMeta, paths.liveMeta);
        } catch (_restoreErr) {
          throw new Error(`${err.message}；上一代快照暂存在 ${paths.prev}`);
        }
      }
      throw err;
    }
    const verifiedAt = Date.now();
    writeSnapshotMeta(paths.live, {
      version: 1,
      uin: String(uin || account.qq || ''),
      verifiedAt,
      createdAt: verifiedAt,
      size,
      source: 'webui',
    });
    noteRecovery(account, {
      phase: 'snapshot',
      snapshotFound: true,
      snapshotAt: verifiedAt,
      snapshotSize: size,
      snapshotSource: 'session-good',
      restoreAttempted: true,
      restoreAction: 'snapshot-good',
      restoreResult: 'success',
      webuiIsLogin: true,
      error: '',
    });
    return true;
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    noteRecovery(account, {
      phase: 'snapshot',
      snapshotFound: false,
      snapshotAt: 0,
      snapshotSize: 0,
      restoreAttempted: true,
      restoreAction: 'snapshot-good',
      restoreResult: 'failed',
      webuiIsLogin: true,
      error: err.message,
    });
    return false;
  }
}

function hasGoodLogin(account) {
  const paths = goodSessionPaths(accountDirs(account));
  return inspectNtSnapshot(paths.live).valid || inspectNtSnapshot(paths.prev).valid;
}

/** 用登录快照覆盖 QQ 数据后重启；当前数据先复制校验，失败不动原目录，可用上一代回退。 */
async function restoreGoodLogin(account) {
  return withAccountLock(account, () => restoreGoodLoginUnlocked(account));
}

async function restoreGoodLoginUnlocked(account) {
  const dirs = accountDirs(account);
  const paths = goodSessionPaths(dirs);
  const candidates = [];
  for (const [name, dir] of [
    ['session-good', paths.live],
    ['session-good.prev', paths.prev],
  ]) {
    const report = await describeSnapshot(dir, true);
    if (report.valid) candidates.push({ name, ...report });
  }
  if (!candidates.length) {
    noteRecovery(account, {
      phase: 'restore',
      snapshotFound: false,
      restoreAttempted: false,
      restoreAction: 'restore-good',
      restoreResult: 'no-snapshot',
      error: '没有可用的 good 快照',
    });
    return false;
  }
  const source = candidates[0];
  noteRecovery(account, {
    phase: 'restore',
    snapshotFound: true,
    snapshotAt: source.verifiedAt,
    snapshotSize: source.size,
    snapshotSource: source.name,
    restoreAttempted: true,
    restoreAction: 'restore-good',
    restoreResult: 'running',
    error: '',
  });
  await stopAccountUnlocked(account, { preserveDesired: true, snapshotGood: false });
  const target = path.join(dirs.qqData, 'nt_qq');
  let lastError = null;
  for (const candidate of candidates) {
    try {
      await replaceDirAtomically(candidate.path, target, (dir) => inspectNtSnapshot(dir).valid);
      noteRecovery(account, {
        phase: 'restore',
        snapshotFound: true,
        snapshotAt: candidate.verifiedAt,
        snapshotSize: candidate.size,
        snapshotSource: candidate.name,
        restoreAttempted: true,
        restoreAction: 'restore-good',
        restoreResult: 'success',
        error: '',
      });
      return startAccountUnlocked(account);
    } catch (err) {
      lastError = err;
      noteRecovery(account, {
        phase: 'restore',
        snapshotFound: true,
        snapshotAt: candidate.verifiedAt,
        snapshotSize: candidate.size,
        snapshotSource: candidate.name,
        restoreAttempted: true,
        restoreAction: 'restore-good',
        restoreResult: 'failed',
        error: err.message,
      });
    }
  }
  throw new Error(`登录快照恢复失败：${lastError ? lastError.message : '未知错误'}`);
}

async function stopAccount(account, options = {}) {
  return withAccountLock(account, () => stopAccountUnlocked(account, options));
}

async function stopAccountUnlocked(account, { preserveDesired = false, snapshotGood = true } = {}) {
  if (!preserveDesired) account.desiredState = 'stopped';
  const dirs = accountDirs(account);
  const candidate = readPid(account) || Number(account.pid) || 0;
  const pid = candidate && processBelongsToHome(candidate, dirs.home) ? candidate : 0;
  const homePids = findPidsByHome(dirs.home);
  const pids = Array.from(new Set([pid, ...homePids].filter(Boolean)));
  const wasRunning = pids.some((item) => isAlive(item));

  // 停号前用 WebUI 权威确认在线，只有确认 isLogin=true 才允许生成 good 快照。
  let verifiedOnline = false;
  let uin = String(account.qq || '');
  if (wasRunning && snapshotGood && Number(account.webuiPort)) {
    const login = await getWebuiLoginStatus(account, 5000);
    verifiedOnline = Boolean(login && login.isLogin);
    if (login && login.info) uin = String(login.info.uin || login.info.user_id || uin);
    appendAccountLog(
      account,
      `停号前 WebUI 登录检查：${login ? `isLogin=${login.isLogin} isOffline=${login.isOffline}` : 'WebUI 无响应'}`
    );
    noteRecovery(account, {
      phase: 'stop',
      webuiIsLogin: login ? login.isLogin : null,
      snapshotFound: verifiedOnline,
      error: verifiedOnline ? '' : '停号前 WebUI 未确认在线',
    });
  }

  // 先快照 global 再停进程，防止强杀/断电导致票据损坏后无法自动重登。
  await backupSessionState(dirs);

  if (pids.length) {
    expectedExits.set(account.id, pid || Number(account.pid) || pids[0]);
    for (const item of pids) await killProcessGroup(item);
    // 给足 10 秒让 QQ 把登录态写盘，尽量避免走到 SIGKILL。
    const gone = await waitGone(pids, 10000);
    if (!gone) {
      for (const item of pids) {
        if (isAlive(item)) await killProcessGroup(item, { force: true });
      }
      await waitGone(pids, 2000);
    }
  }

  // 在线账号正常停止后会写盘，此时再做一份完整快照最干净。
  if (snapshotGood) {
    if (verifiedOnline) {
      await snapshotGoodLoginUnlocked(account, { verified: true, uin });
    } else {
      noteRecovery(account, {
        phase: 'stop',
        snapshotFound: false,
        snapshotAt: 0,
        snapshotSize: 0,
        restoreAction: 'snapshot-skip',
        restoreResult: 'skipped',
        webuiIsLogin: null,
        error: wasRunning ? 'WebUI 未确认 isLogin=true，跳过 good 快照' : '进程未运行，跳过 good 快照',
      });
    }
  }

  expectedExits.delete(account.id);
  try {
    fs.rmSync(dirs.pidFile, { force: true });
  } catch (_e) {
    /* ignore */
  }
  account.pid = 0;
  account.containerState = 'exited';
  if (account.stats) account.stats.online = false;
  return { ok: true };
}

async function restartAccount(account) {
  return withAccountLock(account, () => restartAccountUnlocked(account));
}

async function restartAccountUnlocked(account) {
  await stopAccountUnlocked(account);
  await sleep(800);
  return startAccountUnlocked(account);
}

/** 重建运行环境但保留 home 下的登录数据，整段在同一把账号锁内完成。 */
async function recreateAccount(account) {
  return withAccountLock(account, async () => {
    await stopAccountUnlocked(account);
    fs.rmSync(accountDirs(account).napcat, { recursive: true, force: true });
    return startAccountUnlocked(account);
  });
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

async function getWebuiLoginStatus(account, timeout = 5000) {
  try {
    const status = await webuiPost(account, '/api/QQLogin/CheckLoginStatus', {}, timeout);
    if (!status || status.code !== 0) return null;
    const data = status.data || {};
    return {
      isLogin: Boolean(data.isLogin),
      isOffline: Boolean(data.isOffline),
      phase: data.loginPhase || '',
      error: data.loginError || '',
      info: null,
    };
  } catch (_e) {
    return null;
  }
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
  return withAccountLock(account, async () => {
    await stopAccountUnlocked(account, { preserveDesired: true, snapshotGood: false });
    const dirs = accountDirs(account);
    const backupPaths = sessionBackupPaths(dirs);
    const goodPaths = goodSessionPaths(dirs);
    // 旧快照同样是被踢的票据，必须一并清掉，否则下次启动又会被恢复。
    fs.rmSync(backupPaths.live, { recursive: true, force: true });
    fs.rmSync(backupPaths.prev, { recursive: true, force: true });
    fs.rmSync(backupPaths.staging, { recursive: true, force: true });
    fs.rmSync(goodPaths.live, { recursive: true, force: true });
    fs.rmSync(goodPaths.prev, { recursive: true, force: true });
    fs.rmSync(goodPaths.liveMeta, { force: true });
    fs.rmSync(goodPaths.prevMeta, { force: true });
    const stale = path.join(dirs.root, 'session-stale');
    fs.rmSync(stale, { recursive: true, force: true });
    try {
      const src = sessionGlobalDir(dirs);
      if (fs.existsSync(src)) fs.renameSync(src, stale);
    } catch (_e) {
      fs.rmSync(sessionGlobalDir(dirs), { recursive: true, force: true });
    }
    noteRecovery(account, {
      phase: 'reset',
      snapshotFound: false,
      snapshotAt: 0,
      snapshotSize: 0,
      restoreAttempted: true,
      restoreAction: 'reset-login',
      restoreResult: 'success',
      webuiIsLogin: false,
      error: '',
    });
    await sleep(600);
    return startAccountUnlocked(account);
  });
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
  recreateAccount,
  ensureRestartGuard,
  resetRestartGuard,
  noteRestartAttempt,
  noteRestartFailure,
  canAutoRestart,
  noteRecovery,
  backupSessionState,
  restoreSessionStateIfMissing,
  statusAccount,
  startRuntimeIfNeeded,
  removeAccountRuntime,
  getAccountLogs,
  writeOnebotConfig,
  ensureAccountOnebotConfig,
  getWebuiLoginState,
  getWebuiLoginStatus,
  refreshQrcode,
  resetLoginState,
  snapshotGoodLogin,
  hasGoodLogin,
  restoreGoodLogin,
  deleteAccountData,
  webuiLogin,
  probePort,
};
