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
/** 主动停止中的进程集合：一次停止可能涉及 xvfb-run / Xvfb / qq 多个 pid。 */
const expectedExits = new Map();

function markExpectedExit(accountId, pids) {
  expectedExits.set(accountId, new Set(pids.filter(Boolean)));
  return expectedExits.get(accountId);
}

function isExpectedExit(accountId, pid) {
  const set = expectedExits.get(accountId);
  return Boolean(set && set.has(pid));
}

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
  suspendedAt: 0,
  failures: 0,
  unreachable: 0,
  attempts: 0,
  nextRetryAt: 0,
  lastAttemptAt: 0,
  updatedAt: 0,
});

/** 自动重启被暂停后冷却这么久自动解除一次，避免账号永久停摆等人处理。 */
const SUSPEND_COOLDOWN_MS = 30 * 60 * 1000;
/** supervise(8s) 与保活(30s) 可能在同一轮故障里各记一次重启，短时间只算一次。 */
const RESTART_ATTEMPT_DEDUP_MS = 15 * 1000;

function ensureRestartGuard(account) {
  // 原地补全，不重新分配对象：tasks/server 里多处持有 guard 引用，
  // 每次换一个新对象会让后续写入落在旧副本上、状态悄悄丢失。
  if (!account.autoRestartGuard || typeof account.autoRestartGuard !== 'object') {
    account.autoRestartGuard = { ...RESTART_GUARD_DEFAULTS };
  } else {
    for (const [key, value] of Object.entries(RESTART_GUARD_DEFAULTS)) {
      if (account.autoRestartGuard[key] === undefined) account.autoRestartGuard[key] = value;
    }
  }
  return account.autoRestartGuard;
}

function resetRestartGuard(account) {
  const guard = ensureRestartGuard(account);
  Object.assign(guard, RESTART_GUARD_DEFAULTS, { updatedAt: Date.now() });
  return guard;
}

function restartBackoffMs(attempts) {
  const n = Math.max(1, Number(attempts) || 1);
  return Math.min(30 * 60 * 1000, 30 * 1000 * Math.pow(2, n - 1));
}

function noteRestartAttempt(account) {
  const guard = ensureRestartGuard(account);
  const now = Date.now();
  // 后台巡检与保活是两条独立循环，同一轮故障里可能各记一次；
  // 15 秒内的重复调用只更新退避时间，不再把 attempts 翻倍。
  if (now - Number(guard.lastAttemptAt || 0) >= RESTART_ATTEMPT_DEDUP_MS) {
    guard.attempts = Number(guard.attempts || 0) + 1;
  }
  guard.lastAttemptAt = now;
  guard.nextRetryAt = now + restartBackoffMs(guard.attempts);
  guard.updatedAt = now;
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
  if (guard.suspended) {
    // 用独立的 suspendedAt 计时：失败计数会不断刷新 updatedAt，
    // 拿它当暂停起点会导致冷却永远走不完。
    if (!Number(guard.suspendedAt || 0)) guard.suspendedAt = Number(guard.updatedAt) || now;
    if (now - Number(guard.suspendedAt) < SUSPEND_COOLDOWN_MS) return false;
    guard.suspended = false;
    guard.suspendedAt = 0;
    guard.attempts = 0;
    guard.failures = 0;
    guard.unreachable = 0;
    guard.nextRetryAt = 0;
    guard.updatedAt = now;
    return true;
  }
  return now >= Number(guard.nextRetryAt || 0);
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
  let parseFailed = false;
  if (existed) {
    try {
      config = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_e) {
      config = desired;
      parseFailed = true;
    }
  } else {
    config = desired;
  }
  config.network = config.network || {};
  config.network.httpServers = Array.isArray(config.network.httpServers) ? config.network.httpServers : [];
  config.network.httpClients = Array.isArray(config.network.httpClients) ? config.network.httpClients : [];

  const hasHttp = config.network.httpServers.some((s) => s && s.name === 'qqnas-http');
  const hasHook = config.network.httpClients.some((c) => c && c.name === 'qqnas-manager');
  // 配置已完整时绝不回写：NapCat 会监听账号级配置文件，
  // 管理端每次重启都原子替换一次会触发热重载、把在线的 OneBot 连接打断。
  if (existed && !parseFailed && hasHttp && hasHook) return false;
  if (!hasHttp) config.network.httpServers.push(desired.network.httpServers[0]);
  if (!hasHook) config.network.httpClients.push(desired.network.httpClients[0]);
  writeJsonFile(file, config);
  return true;
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

/**
 * 端口释放有延迟：刚 SIGKILL 掉的进程，监听 socket 可能还短暂存在。
 * 立即报“端口被占用”会让账号卡在 error 反复重启，这里等一小会儿再下结论。
 */
async function assertPortsAvailable(account, { waitMs = 15000 } = {}) {
  const ports = [
    ['WebUI', Number(account.webuiPort) || 0],
    ['OneBot', Number(account.onebotPort) || 0],
  ].filter(([, port]) => port > 0);
  if (!ports.length) return;
  const deadline = Date.now() + waitMs;
  for (;;) {
    let busy = null;
    for (const [name, port] of ports) {
      // eslint-disable-next-line no-await-in-loop
      if (await probePort(port)) {
        busy = { name, port };
        break;
      }
    }
    if (!busy) return;
    if (Date.now() >= deadline) {
      throw new Error(`${busy.name} 端口 ${busy.port} 已被占用，请先停止占用该端口的进程`);
    }
    await sleep(500);
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
      if (!isExpectedExit(account.id, child.pid)) {
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
      const expected = isExpectedExit(account.id, child.pid);
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
 * QQ(NT) 在本机的真实数据布局（真机日志实证）：
 *   ~/.config/QQ/global                  全局数据，含 nt_data/mmkv
 *   ~/.config/QQ/nt_qq_<32位hex>/        每个登录实例的数据，含 nt_data/mmkv
 * 旧实现写死 ~/.config/QQ/nt_qq/global，这个目录在真机上并不存在，快照永远为空。
 * 现在统一按“整体数据集”处理：global 与全部 nt_qq_* 一起快照、整体原子还原。
 */
const QQ_DATASET_DIR_RE = /^nt_qq(_[0-9a-f]{32})?$/;
/** 快照时间比当前数据最新写入时间新出这个阈值，才算“快照明显更新”。 */
const SNAPSHOT_NEWER_MS = 60 * 1000;
/** 刚用某份快照恢复过就不再重复覆盖的保护窗口。 */
const RESTORE_COOLDOWN_MS = 30 * 60 * 1000;
/** 快照复制前后各枚举一次，结构变化就整份重取，最多重试次数。 */
const SNAPSHOT_CONSISTENCY_RETRIES = 3;

/** 列出 QQ 数据根目录下参与登录态的数据入口：global 与全部 nt_qq_*（含旧版 nt_qq）。 */
function listQqDatasetNames(root) {
  const names = [];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'global' || QQ_DATASET_DIR_RE.test(entry.name)) names.push(entry.name);
    }
  } catch (_e) {
    return names;
  }
  names.sort();
  return names;
}

/** 统计一个路径（文件或目录）的真实文件数与字节数，并取最新 mtime；空目录/空文件算无效。 */
function inspectPathBytes(target, limit = 40) {
  const result = { exists: false, files: 0, bytes: 0, newestAt: 0 };
  let stat;
  try {
    stat = fs.statSync(target);
  } catch (_e) {
    return result;
  }
  result.exists = true;
  if (stat.isFile()) {
    result.files = 1;
    result.bytes = stat.size;
    result.newestAt = Math.round(stat.mtimeMs);
    return result;
  }
  if (!stat.isDirectory()) return result;
  const stack = [target];
  while (stack.length && result.files < limit) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_e) {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        stack.push(path.join(current, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const full = path.join(current, entry.name);
      result.files += 1;
      try {
        const info = fs.statSync(full);
        result.bytes += info.size;
        if (info.mtimeMs > result.newestAt) result.newestAt = Math.round(info.mtimeMs);
      } catch (_e) {
        /* ignore */
      }
      if (result.files >= limit) break;
    }
  }
  return result;
}

/**
 * 校验一份 QQ 数据集是否真的可用：global 与每个 nt_qq_* 的 nt_data/mmkv
 * 都必须有真实文件/字节，而不是目录存在。登录票据在 nt_qq_* 里，
 * 因此至少一个 nt_qq_* 的 mmkv 非空才算有效。
 */
function inspectQqDataSet(root) {
  const names = listQqDatasetNames(root);
  const ntNames = names.filter((name) => name !== 'global');
  const globalState = inspectPathBytes(path.join(root, 'global', 'nt_data', 'mmkv'));
  const ntStates = ntNames.map((name) => ({
    name,
    mmkv: inspectPathBytes(path.join(root, name, 'nt_data', 'mmkv')),
  }));
  const validNt = ntStates.filter((item) => item.mmkv.files > 0 && item.mmkv.bytes > 0);
  let newestAt = globalState.newestAt;
  for (const item of validNt) {
    if (item.mmkv.newestAt > newestAt) newestAt = item.mmkv.newestAt;
  }
  return {
    root,
    names,
    ntNames,
    ntStates,
    ntCount: ntNames.length,
    validNtCount: validNt.length,
    globalExists: globalState.exists,
    globalValid: globalState.files > 0 && globalState.bytes > 0,
    globalBytes: globalState.bytes,
    newestAt,
    valid: validNt.length > 0,
  };
}

/**
 * 识别一份快照/备份的结构：
 * - dataset：含 nt_qq_* 子目录，是 2.0.22 起的整体快照；
 * - global：只有 global 子目录（旧版 session-good 复制的是 <QQ>/nt_qq，即含 global）；
 * - legacy-backup：根下直接是 global 的内容（旧版 session-backup 复制的是 <QQ>/nt_qq/global）。
 */
function inspectSnapshotDir(dir) {
  const missing = { exists: false, kind: 'missing', names: [], entries: [], valid: false };
  let exists = false;
  try {
    exists = fs.statSync(dir).isDirectory();
  } catch (_e) {
    return missing;
  }
  if (!exists) return missing;
  const names = listQqDatasetNames(dir);
  const ntNames = names.filter((name) => name !== 'global');
  if (ntNames.length) {
    const state = inspectQqDataSet(dir);
    return {
      exists: true,
      kind: 'dataset',
      names,
      entries: names,
      state,
      newestAt: state.newestAt,
      valid: state.valid,
    };
  }
  if (names.includes('global')) {
    const left = inspectPathBytes(path.join(dir, 'global'));
    return {
      exists: true,
      kind: 'global',
      names,
      entries: names,
      files: left.files,
      bytes: left.bytes,
      newestAt: left.newestAt,
      valid: left.files > 0 && left.bytes > 0,
    };
  }
  const legacyMmkv = inspectPathBytes(path.join(dir, 'nt_data', 'mmkv'));
  const legacyAny = legacyMmkv.exists ? legacyMmkv : inspectPathBytes(dir);
  return {
    exists: true,
    kind: 'legacy-backup',
    names: [],
    entries: [],
    files: legacyAny.files,
    bytes: legacyAny.bytes,
    newestAt: legacyAny.newestAt,
    valid: legacyAny.files > 0 && legacyAny.bytes > 0,
  };
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

async function describeSnapshot(dir) {
  const inspection = inspectSnapshotDir(dir);
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
    ...inspection,
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
  phase: '',
  restoredAt: 0,
  snapshotFound: false,
  snapshotAt: 0,
  snapshotSize: 0,
  snapshotSource: '',
  snapshotFormat: '',
  datasetEntries: [],
  currentValid: false,
  currentNewestAt: 0,
  ntCount: 0,
  globalValid: false,
  globalBytes: 0,
  goodCount: 0,
  backupCount: 0,
  goodVerifiedAt: 0,
  decision: '',
  probeSource: '',
  webuiOfflineHint: false,
  webuiPhase: '',
  loginError: '',
  restoreAttempted: false,
  restoreResult: '',
  restoreAction: '',
  webuiIsLogin: null,
  lastRestoredGoodAt: 0,
  lastRestoredSnapshotAt: 0,
  error: '',
};

function noteRecovery(account, patch = {}) {
  const { silent = false, ...data } = patch;
  account.loginRecovery = { ...RECOVERY_DEFAULTS, ...(account.loginRecovery || {}), ...data, at: Date.now() };
  if (!silent) {
    const record = account.loginRecovery;
    const iso = (value) => (value ? new Date(value).toISOString() : '');
    appendAccountLog(
      account,
      `登录态诊断 ${JSON.stringify({
        phase: record.phase || '',
        snapshotFound: record.snapshotFound,
        snapshotFormat: record.snapshotFormat || '',
        snapshotAt: iso(record.snapshotAt),
        snapshotSize: record.snapshotSize,
        snapshotSource: record.snapshotSource,
        datasetEntries: record.datasetEntries || [],
        currentValid: Boolean(record.currentValid),
        currentNewestAt: iso(record.currentNewestAt),
        ntCount: Number(record.ntCount) || 0,
        globalValid: Boolean(record.globalValid),
        globalBytes: Number(record.globalBytes) || 0,
        goodCount: Number(record.goodCount) || 0,
        backupCount: Number(record.backupCount) || 0,
        goodVerifiedAt: iso(record.goodVerifiedAt),
        decision: record.decision || '',
        probeSource: record.probeSource || '',
        webuiOfflineHint: Boolean(record.webuiOfflineHint),
        webuiPhase: record.webuiPhase || '',
        loginError: record.loginError || '',
        restoredAt: iso(record.restoredAt),
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

/** 停止前把整份 QQ 数据（global + 全部 nt_qq_*）备份，滚动保留最近两份。 */
async function backupSessionState(dirs) {
  const qqRoot = dirs.qqData;
  // 已有可用的整体快照时不再额外整份复制：
  // 停止后还会生成一份一致的快照，进程仍在写盘时复制既慢又可能复制到半份数据。
  const good = inspectSnapshotDir(path.join(dirs.root, 'session-good'));
  if (good.valid && good.kind === 'dataset') return false;
  const current = inspectQqDataSet(qqRoot);
  if (!current.valid) return false;
  const { staging, live, prev } = sessionBackupPaths(dirs);
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    for (const name of current.names) {
      await copyDir(path.join(qqRoot, name), path.join(staging, name));
    }
    if (!inspectQqDataSet(staging).valid) throw new Error('备份复制后校验失败');
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

/** 启动前校验登录态：目录存在但 mmkv 为空/缺失也算不可用并恢复。 */
async function restoreSessionStateIfMissing(account) {
  return withAccountLock(account, () => restoreSessionStateIfMissingUnlocked(account, accountDirs(account)));
}

/** 把当前 QQ 数据整体挪走（重置登录态用），返回移动的目录数。 */
function moveQqDataSet(sourceRoot, targetDir) {
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  let moved = 0;
  for (const name of listQqDatasetNames(sourceRoot)) {
    try {
      fs.renameSync(path.join(sourceRoot, name), path.join(targetDir, name));
      moved += 1;
    } catch (_e) {
      fs.rmSync(path.join(sourceRoot, name), { recursive: true, force: true });
    }
  }
  return moved;
}

/** 整体原子还原：复制到 .restore-* -> 校验 -> 旧数据挪到 .old-* -> 新数据就位，失败回滚。 */
async function applyDatasetSnapshot(snapshotDir, qqRoot) {
  const names = listQqDatasetNames(snapshotDir);
  if (!names.length) throw new Error('快照中没有可还原的数据目录');
  const suffix = crypto.randomBytes(6).toString('hex');
  const temp = path.join(qqRoot, `.restore-${suffix}`);
  const aside = path.join(qqRoot, `.old-${suffix}`);
  fs.mkdirSync(qqRoot, { recursive: true });
  fs.rmSync(temp, { recursive: true, force: true });
  fs.rmSync(aside, { recursive: true, force: true });
  try {
    fs.mkdirSync(temp, { recursive: true });
    for (const name of names) {
      await copyDir(path.join(snapshotDir, name), path.join(temp, name));
    }
    if (!inspectQqDataSet(temp).valid) throw new Error('复制后的快照校验失败：缺少可用的 nt_data/mmkv');
    fs.mkdirSync(aside, { recursive: true });
    const moved = [];
    for (const name of listQqDatasetNames(qqRoot)) {
      try {
        fs.renameSync(path.join(qqRoot, name), path.join(aside, name));
        moved.push(name);
      } catch (_e) {
        /* 旧目录可能已被并发清理，忽略 */
      }
    }
    const placed = [];
    try {
      for (const name of names) {
        fs.renameSync(path.join(temp, name), path.join(qqRoot, name));
        placed.push(name);
      }
    } catch (err) {
      for (const name of placed) fs.rmSync(path.join(qqRoot, name), { recursive: true, force: true });
      for (const name of moved) {
        try {
          fs.renameSync(path.join(aside, name), path.join(qqRoot, name));
        } catch (_e) {
          /* 回滚失败时保留 .old-* 供人工找回 */
        }
      }
      throw err;
    }
    fs.rmSync(aside, { recursive: true, force: true });
    fs.rmSync(temp, { recursive: true, force: true });
    return true;
  } catch (err) {
    fs.rmSync(temp, { recursive: true, force: true });
    throw err;
  }
}

/** 旧格式快照只带 global 时，只还原 global 子目录。 */
async function applyGlobalSnapshot(report, qqRoot) {
  const source = report.kind === 'global' ? path.join(report.path, 'global') : report.path;
  const target = path.join(qqRoot, 'global');
  await replaceDirAtomically(source, target, (dir) => {
    const info = inspectPathBytes(dir);
    return info.files > 0 && info.bytes > 0;
  });
}

async function restoreSessionStateIfMissingUnlocked(account, dirs) {
  const qqRoot = dirs.qqData;
  const current = inspectQqDataSet(qqRoot);
  const goodPaths = goodSessionPaths(dirs);
  const backupPaths = sessionBackupPaths(dirs);
  const goodReports = [];
  for (const [name, dir] of [
    ['session-good', goodPaths.live],
    ['session-good.prev', goodPaths.prev],
  ]) {
    const report = await describeSnapshot(dir);
    if (report.valid) goodReports.push({ name, ...report });
  }
  const backupReports = [];
  for (const [name, dir] of [
    ['session-backup', backupPaths.live],
    ['session-backup.prev', backupPaths.prev],
  ]) {
    const report = await describeSnapshot(dir);
    if (report.valid) backupReports.push({ name, ...report });
  }
  const bestGood = goodReports[0] || null;
  const baseRecord = {
    phase: 'startup',
    snapshotFound: goodReports.length > 0,
    snapshotFormat: bestGood ? bestGood.kind : '',
    snapshotAt: bestGood ? bestGood.verifiedAt : 0,
    snapshotSize: bestGood ? bestGood.size : 0,
    snapshotSource: bestGood ? bestGood.name : '',
    datasetEntries: current.names,
    currentValid: current.valid,
    currentNewestAt: current.newestAt,
    ntCount: current.ntCount,
    globalValid: current.globalValid,
    globalBytes: current.globalBytes,
    goodCount: goodReports.length,
    backupCount: backupReports.length,
    goodVerifiedAt: bestGood ? bestGood.verifiedAt : 0,
  };

  // 判定依据（不偷偷决定，全部写进诊断行）：
  // 1. 当前数据没有可用的 nt_data/mmkv -> 必须用快照；
  // 2. 当前可用，但 good 快照 verifiedAt 明显新于当前最新写入 -> 以快照为准；
  // 3. 其余情况保留当前数据，避免把刚被 QQ 更新的票据又覆盖回旧快照。
  const previous = account.loginRecovery || {};
  const lastRestoredGoodAt = Number(previous.lastRestoredGoodAt) || 0;
  const lastRestoredSnapshotAt = Number(previous.lastRestoredSnapshotAt) || 0;

  let decision = 'current-valid';
  let candidates = [];
  if (!current.valid) {
    decision = 'current-invalid';
    candidates = [...goodReports, ...backupReports];
  } else if (
    bestGood &&
    bestGood.kind === 'dataset' &&
    Number(bestGood.verifiedAt) > Number(current.newestAt) + SNAPSHOT_NEWER_MS
  ) {
    if (
      lastRestoredSnapshotAt === bestGood.verifiedAt &&
      Date.now() - lastRestoredGoodAt < RESTORE_COOLDOWN_MS
    ) {
      decision = 'skip-recently-restored';
    } else {
      decision = 'snapshot-newer';
      candidates = goodReports;
    }
  }

  if (candidates.length) {
    let lastError = '';
    let attempted = false;
    for (const report of candidates) {
      attempted = true;
      const action = report.kind === 'dataset' ? 'restore-qq-dataset' : 'restore-global';
      try {
        if (report.kind === 'dataset') await applyDatasetSnapshot(report.path, qqRoot);
        else await applyGlobalSnapshot(report, qqRoot);
        noteRecovery(account, {
          ...baseRecord,
          snapshotFound: true,
          snapshotFormat: report.kind,
          snapshotAt: report.verifiedAt,
          snapshotSize: report.size,
          snapshotSource: report.name,
          decision,
          restoreAttempted: true,
          restoreAction: action,
          restoreResult: 'success',
          restoredAt: Date.now(),
          lastRestoredGoodAt: Date.now(),
          lastRestoredSnapshotAt: report.verifiedAt,
          error: '',
        });
        return true;
      } catch (err) {
        lastError = err.message;
        noteRecovery(account, {
          ...baseRecord,
          snapshotFound: true,
          snapshotFormat: report.kind,
          snapshotAt: report.verifiedAt,
          snapshotSize: report.size,
          snapshotSource: report.name,
          decision,
          restoreAttempted: true,
          restoreAction: action,
          restoreResult: 'failed',
          error: err.message,
        });
      }
    }
    if (attempted) {
      noteRecovery(account, {
        ...baseRecord,
        decision,
        restoreAttempted: true,
        restoreAction: 'none',
        restoreResult: 'failed',
        error: lastError || '快照恢复失败',
      });
      return false;
    }
  }

  noteRecovery(account, {
    ...baseRecord,
    decision,
    restoreAttempted: false,
    restoreAction: 'none',
    restoreResult: current.valid ? 'existing-data' : 'no-valid-snapshot',
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
  const qqRoot = dirs.qqData;
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
  const current = inspectQqDataSet(qqRoot);
  if (!current.valid) {
    noteRecovery(account, {
      phase: 'snapshot',
      snapshotFound: false,
      snapshotAt: 0,
      snapshotSize: 0,
      datasetEntries: current.names,
      currentValid: false,
      currentNewestAt: current.newestAt,
      ntCount: current.ntCount,
      globalValid: current.globalValid,
      globalBytes: current.globalBytes,
      restoreAction: 'snapshot-skip',
      restoreResult: 'failed',
      webuiIsLogin: true,
      error: '当前 QQ 数据缺少可用的 nt_qq_*/nt_data/mmkv，未生成快照',
    });
    return false;
  }
  const staging = `${paths.live}.${crypto.randomBytes(6).toString('hex')}.new`;
  try {
    let snapshotEntries = null;
    for (let attempt = 1; attempt <= SNAPSHOT_CONSISTENCY_RETRIES; attempt += 1) {
      const before = listQqDatasetNames(qqRoot);
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(staging, { recursive: true });
      for (const name of before) {
        await copyDir(path.join(qqRoot, name), path.join(staging, name));
      }
      // 运行中的账号可能新增或替换 nt_qq_*；复制前后枚举必须一致，否则整份重取。
      const after = listQqDatasetNames(qqRoot);
      if (before.join('|') !== after.join('|')) {
        fs.rmSync(staging, { recursive: true, force: true });
        appendAccountLog(
          account,
          `快照一致性检查：第 ${attempt} 次复制前后数据目录不一致（${before.join(',')} -> ${after.join(',')}），重试`
        );
        continue;
      }
      if (!inspectQqDataSet(staging).valid) {
        throw new Error('快照复制后校验失败：缺少可用的 nt_data/mmkv');
      }
      snapshotEntries = before;
      break;
    }
    if (!snapshotEntries) {
      throw new Error(`快照期间 QQ 数据目录持续变化（已重试 ${SNAPSHOT_CONSISTENCY_RETRIES} 次）`);
    }
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
      version: 2,
      uin: String(uin || account.qq || ''),
      verifiedAt,
      createdAt: verifiedAt,
      size,
      source: 'webui',
      entries: snapshotEntries,
    });
    noteRecovery(account, {
      phase: 'snapshot',
      snapshotFound: true,
      snapshotFormat: 'dataset',
      snapshotAt: verifiedAt,
      snapshotSize: size,
      snapshotSource: 'session-good',
      datasetEntries: snapshotEntries,
      currentValid: true,
      currentNewestAt: current.newestAt,
      ntCount: current.ntCount,
      globalValid: current.globalValid,
      globalBytes: current.globalBytes,
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
  return inspectSnapshotDir(paths.live).valid || inspectSnapshotDir(paths.prev).valid;
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
    const report = await describeSnapshot(dir);
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
    snapshotFormat: source.kind,
    snapshotAt: source.verifiedAt,
    snapshotSize: source.size,
    snapshotSource: source.name,
    restoreAttempted: true,
    restoreAction: 'restore-good',
    restoreResult: 'running',
    error: '',
  });
  await stopAccountUnlocked(account, { preserveDesired: true, snapshotGood: false });
  const qqRoot = dirs.qqData;
  let lastError = null;
  for (const candidate of candidates) {
    try {
      if (candidate.kind === 'dataset') await applyDatasetSnapshot(candidate.path, qqRoot);
      else await applyGlobalSnapshot(candidate, qqRoot);
      noteRecovery(account, {
        phase: 'restore',
        snapshotFound: true,
        snapshotFormat: candidate.kind,
        snapshotAt: candidate.verifiedAt,
        snapshotSize: candidate.size,
        snapshotSource: candidate.name,
        restoreAttempted: true,
        restoreAction: 'restore-good',
        restoreResult: 'success',
        restoredAt: Date.now(),
        lastRestoredGoodAt: Date.now(),
        lastRestoredSnapshotAt: candidate.verifiedAt,
        error: '',
      });
      return startAccountUnlocked(account);
    } catch (err) {
      lastError = err;
      noteRecovery(account, {
        phase: 'restore',
        snapshotFound: true,
        snapshotFormat: candidate.kind,
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

  let exitMark = null;
  if (pids.length) {
    // 记录本次停止涉及的全部 pid：xvfb-run / Xvfb / qq 的退出事件都算“主动停止”，
    // 避免把正常退出误判成异常退出、进而抬升失败计数触发暂停。
    exitMark = markExpectedExit(account.id, pids);
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

  // 退出事件可能比 waitGone 稍晚送达；停号后还要做完整登录快照，
  // 标记保留 60 秒，避免晚到的正常退出被记成异常退出、抬升失败计数。
  if (exitMark) {
    const timer = setTimeout(() => {
      if (expectedExits.get(account.id) === exitMark) expectedExits.delete(account.id);
    }, 60000);
    if (timer.unref) timer.unref();
  } else {
    expectedExits.delete(account.id);
  }
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
  // 重启期间保留 running 意图：否则后台巡检/面板会在 stop 与 start 之间
  // 看到 desiredState=stopped，把一次普通重启误认为用户主动停号。
  await stopAccountUnlocked(account, { preserveDesired: true });
  await sleep(800);
  return startAccountUnlocked(account);
}

/** 重建运行环境但保留 home 下的登录数据，整段在同一把账号锁内完成。 */
async function recreateAccount(account) {
  return withAccountLock(account, async () => {
    await stopAccountUnlocked(account, { preserveDesired: true });
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
          let parsed;
          try {
            parsed = text ? JSON.parse(text) : {};
          } catch (_e) {
            const err = new Error(`WebUI 返回非 JSON（HTTP ${res.statusCode}）：${text.slice(0, 120)}`);
            err.statusCode = res.statusCode;
            reject(err);
            return;
          }
          if (res.statusCode >= 400) {
            const err = new Error(`WebUI 未授权或请求失败（HTTP ${res.statusCode}）：${String(parsed.message || '').slice(0, 120)}`);
            err.statusCode = res.statusCode;
            reject(err);
            return;
          }
          resolve(parsed);
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
/** 保活、面板状态、二维码轮询会同时打 WebUI；登录请求单飞，避免撞上 loginRate 限流。 */
const webuiLoginInflight = new Map();

function webuiBase(account) {
  if (!account.webuiPort) throw new Error('账号 WebUI 端口尚未分配');
  return `http://127.0.0.1:${account.webuiPort}`;
}

async function webuiLogin(account) {
  const cached = credentialCache.get(account.id);
  if (cached && Date.now() < cached.expires) return cached.credential;
  const pending = webuiLoginInflight.get(account.id);
  if (pending) return pending;

  const baseUrl = webuiBase(account);
  const task = (async () => {
    const hash = sha256(`${account.webuiToken}.napcat`);
    const result = await webuiRequest(baseUrl, 'POST', '/api/auth/login', { hash });
    if (!result || result.code !== 0 || !result.data || !result.data.Credential) {
      throw new Error((result && result.message) || 'WebUI 登录失败');
    }
    const credential = result.data.Credential;
    credentialCache.set(account.id, { credential, expires: Date.now() + 50 * 60 * 1000 });
    return credential;
  })();
  webuiLoginInflight.set(account.id, task);
  try {
    return await task;
  } finally {
    if (webuiLoginInflight.get(account.id) === task) webuiLoginInflight.delete(account.id);
  }
}

async function webuiPost(account, pathName, body = {}, timeout = 8000) {
  const baseUrl = webuiBase(account);
  let credential = await webuiLogin(account);
  try {
    const result = await webuiRequest(baseUrl, 'POST', pathName, body, credential, timeout);
    // NapCat 有时返回 200 + code!=0 表示凭据失效，也要走重登。
    if (result && result.code !== 0 && /Unauthorized|token|credential/i.test(result.message || '')) {
      throw Object.assign(new Error('WebUI 凭据失效'), { credentialExpired: true });
    }
    return result;
  } catch (err) {
    // NapCat 重启后旧 Credential 会失效，且常以 HTTP 401/403（非 JSON）返回。
    // 旧实现只认 JSON 里的 Unauthorized，探测会连续失败到触发误重启。
    const expired =
      err.credentialExpired === true || err.statusCode === 401 || err.statusCode === 403;
    if (!expired) throw err;
    credentialCache.delete(account.id);
    credential = await webuiLogin(account);
    return webuiRequest(baseUrl, 'POST', pathName, body, credential, timeout);
  }
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

/**
 * 只读登录状态：只调 CheckLoginStatus（登录后顺带读一次登录信息），
 * 绝不生成二维码、绝不 RefreshQRcode。
 * 保活探测、面板状态轮询这类高频只读路径必须用这个，
 * 否则一次瞬时 isLogin=false 就会触发取码/刷新，把正在快速登录的账号打断。
 */
async function getWebuiLoginStateQuiet(account, timeout = 6000) {
  let status;
  try {
    status = await webuiPost(account, '/api/QQLogin/CheckLoginStatus', {}, timeout);
  } catch (_e) {
    return null;
  }
  if (!status || status.code !== 0) return null;
  const data = status.data || {};
  // 老版本 NapCat 可能不带 isLogin 字段：字段缺失时不能当成“明确离线”。
  const hasLoginFlag = Object.prototype.hasOwnProperty.call(data, 'isLogin');
  let info = null;
  if (data.isLogin) {
    try {
      const infoResult = await webuiPost(account, '/api/QQLogin/GetQQLoginInfo', {}, timeout);
      if (infoResult && infoResult.code === 0) info = infoResult.data || null;
    } catch (_e) {
      /* 信息接口失败不影响登录状态 */
    }
  }
  return {
    isLogin: Boolean(data.isLogin),
    isOffline: Boolean(data.isOffline),
    hasLoginFlag,
    phase: data.loginPhase || '',
    error: data.loginError || '',
    qrcode: '',
    info,
  };
}

async function getWebuiLoginStatus(account, timeout = 5000) {
  const state = await getWebuiLoginStateQuiet(account, timeout);
  if (!state) return null;
  return {
    isLogin: state.isLogin,
    isOffline: state.isOffline,
    hasLoginFlag: state.hasLoginFlag,
    phase: state.phase,
    error: state.error,
    info: state.info,
  };
}

/**
 * 出码前确认「确实没登录」。
 *
 * GetQQLoginQrcode / RefreshQRcode 会把 QQ 内核从快速登录流程切到扫码流程，
 * 在账号只是瞬时抖动或正在重连时调用，等于自己把在线账号踢下线。
 * 2.0.23 已把保活和面板状态改为只读，但登录弹窗仍会每 3 秒走一次取码路径，
 * 所以这里要求连续三次只读探测都明确返回 isLogin=false 才允许出码。
 */
async function confirmLoggedOut(account) {
  // 只有接口读不通才阻止出码。老版本 NapCat 的 CheckLoginStatus 可能不带
  // isLogin 字段，字段缺失时按「未登录候选」处理，否则这些版本永远出不了码。
  const second = await getWebuiLoginStateQuiet(account, 4000);
  if (!second) return { loggedOut: false, recovered: null };
  if (second.isLogin) return { loggedOut: false, recovered: second };
  await sleep(1500);
  const third = await getWebuiLoginStateQuiet(account, 4000);
  if (!third) return { loggedOut: false, recovered: null };
  if (third.isLogin) return { loggedOut: false, recovered: third };
  return { loggedOut: true, recovered: null };
}

async function getWebuiLoginState(account) {
  const status = await webuiPost(account, '/api/QQLogin/CheckLoginStatus');
  if (!status || status.code !== 0) {
    throw new Error((status && status.message) || '无法读取登录状态');
  }
  const data = status.data || {};
  let qrcode = extractQrcode(data);
  if (!data.isLogin && !qrcode) {
    const confirmation = await confirmLoggedOut(account);
    if (confirmation.recovered) {
      // 第一次 CheckLoginStatus 是滞后的 false：按已登录返回，让弹窗直接关闭。
      return {
        isLogin: true,
        isOffline: false,
        phase: confirmation.recovered.phase || '',
        error: '',
        qrcode: '',
        info: confirmation.recovered.info || null,
        transient: false,
      };
    }
    if (!confirmation.loggedOut) {
      // 状态不可读或内核正在重连：本轮不出码、不刷新，等下一轮轮询。
      return {
        isLogin: false,
        isOffline: Boolean(data.isOffline),
        phase: data.loginPhase || '',
        error: data.loginError || '',
        qrcode: '',
        info: null,
        transient: true,
      };
    }
    const qr = await webuiPost(account, '/api/QQLogin/GetQQLoginQrcode', {}, QRCODE_FETCH_TIMEOUT);
    if (qr && qr.code === 0) qrcode = extractQrcode(qr.data);
    // 被踢下线的账号内核常卡在旧票据快速重登循环里，不进扫码阶段，
    // 被动取码一直为空；确认确实没登录后，主动 Refresh 强制切回扫码阶段出码。
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
    transient: false,
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
    // 旧快照不再直接删除：先归档到 session-reset-<时间戳>/（只留最近一份），
    // 这样即使重置判断错误，也还能人工找回刚恢复的登录态。
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archive = path.join(dirs.root, `session-reset-${stamp}`);
    const keep = [
      ['session-backup', backupPaths.live],
      ['session-backup.prev', backupPaths.prev],
      ['session-good', goodPaths.live],
      ['session-good.prev', goodPaths.prev],
      ['session-good.meta.json', goodPaths.liveMeta],
      ['session-good.prev.meta.json', goodPaths.prevMeta],
    ];
    let archived = 0;
    for (const [name, dir] of keep) {
      if (!fs.existsSync(dir)) continue;
      try {
        fs.mkdirSync(archive, { recursive: true });
        fs.renameSync(dir, path.join(archive, name));
        archived += 1;
      } catch (_e) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    fs.rmSync(backupPaths.staging, { recursive: true, force: true });
    // 只保留最近一次重置的归档，避免快照长期堆积占空间。
    try {
      for (const entry of fs.readdirSync(dirs.root)) {
        if (!entry.startsWith('session-reset-')) continue;
        const full = path.join(dirs.root, entry);
        if (full === archive) continue;
        fs.rmSync(full, { recursive: true, force: true });
      }
    } catch (_e) {
      /* ignore */
    }
    if (archived) appendAccountLog(account, `重置登录态：旧快照已归档到 ${path.basename(archive)}（${archived} 项）`);
    const stale = path.join(dirs.root, 'session-stale');
    // 旧票据可能分布在 global 与多个 nt_qq_* 里，整份挪走而不是只处理某一个目录。
    const moved = moveQqDataSet(dirs.qqData, stale);
    if (moved) {
      appendAccountLog(account, `重置登录态：已把 ${moved} 个 QQ 数据目录（global/nt_qq_*）移到 session-stale`);
    }
    noteRecovery(account, {
      phase: 'reset',
      snapshotFound: false,
      snapshotAt: 0,
      snapshotSize: 0,
      datasetEntries: [],
      currentValid: false,
      decision: 'reset',
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
  getWebuiLoginStateQuiet,
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
