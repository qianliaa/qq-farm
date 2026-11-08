'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { URL } = require('node:url');

const { Store, DATA_DIR, createAccountRecord } = require('./lib/store.cjs');
const { Logger } = require('./lib/logger.cjs');
const napcat = require('./lib/napcat.cjs');
const { TaskEngine, TASK_KEYS, TASK_META } = require('./lib/tasks.cjs');

const APP_VERSION = '2.0.23';
const UPDATE_REPO = (process.env.QQNAS_UPDATE_REPO || 'qianliaa/qq-online').trim();
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MOCK = process.env.QQNAS_MOCK === '1';
const MAX_AUTO_RESTARTS = 3;

/** 访问密码优先取环境变量，其次读取数据目录下的 access-password（飞牛应用安装向导写入）。 */
function loadAccessPassword() {
  const fromEnv = (process.env.ACCESS_PASSWORD || '').trim();
  if (fromEnv) return fromEnv;
  try {
    const file = path.join(DATA_DIR, 'access-password');
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  } catch (_e) {
    /* 读取失败按未设置密码处理 */
  }
  return '';
}

const ACCESS_PASSWORD = loadAccessPassword();
const MANAGER_INTERNAL_URL =
  process.env.MANAGER_INTERNAL_URL || `http://127.0.0.1:${PORT}`;

const store = new Store();
const logger = new Logger({ dir: path.join(DATA_DIR, 'logs'), limit: store.settings.logLimit });
const notifyChannel = require('./lib/notify.cjs');
const fnosUser = require('./lib/fnos-user.cjs');

/** 保活触发的用户通知：按账号归属人读取其通知配置。 */
async function dispatchNotify(account, kind) {
  const cfg = store.getNotify(account.owner || 'admin');
  if (!cfg || !cfg.type || !cfg.target) return;
  if (kind === 'offline' && cfg.offline === false) return;
  if (kind === 'online' && !cfg.online) return;
  const name = account.alias || account.qq || account.id;
  const time = new Date().toLocaleString('zh-CN', { hour12: false });
  const offline = kind === 'offline';
  const title = offline ? '【QQ挂机仓】账号掉线提醒' : '【QQ挂机仓】账号已恢复在线';
  const text = offline
    ? `账号「${name}」${account.qq ? `（QQ ${account.qq}）` : ''}已确认离线，请打开面板查看，必要时重新扫码。\n时间：${time}`
    : `账号「${name}」${account.qq ? `（QQ ${account.qq}）` : ''}已恢复在线。\n时间：${time}`;
  await notifyChannel.send(cfg, title, text);
  logger.info(`已发送${offline ? '掉线' : '恢复'}通知`, { accountId: account.id, account: name });
}

const engine = new TaskEngine({ store, logger, managerInternalUrl: MANAGER_INTERNAL_URL, notify: dispatchNotify });

const runtime = {
  startedAt: Date.now(),
};

/* ----------------------------- 版本更新检查 ----------------------------- */

function versionParts(value) {
  return String(value || '')
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersion(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

function getJson(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'qq-online-update-check',
          Accept: 'application/vnd.github+json',
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data;
          try {
            data = text ? JSON.parse(text) : {};
          } catch (_e) {
            reject(new Error(`GitHub 返回内容无法解析（HTTP ${res.statusCode}）`));
            return;
          }
          if (res.statusCode === 404) {
            const err = new Error('not-found');
            err.status = 404;
            reject(err);
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(data.message || `GitHub 返回 HTTP ${res.statusCode}`));
            return;
          }
          resolve(data);
        });
      }
    );
    req.setTimeout(timeout, () => req.destroy(new Error('连接 GitHub 超时')));
    req.on('error', reject);
  });
}

async function checkUpdate() {
  const base = {
    current: APP_VERSION,
    repo: UPDATE_REPO,
    checkedAt: new Date().toISOString(),
  };
  try {
    let release;
    try {
      release = await getJson(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`);
    } catch (err) {
      if (err.status !== 404) throw err;
      const tags = await getJson(`https://api.github.com/repos/${UPDATE_REPO}/tags?per_page=1`);
      release = Array.isArray(tags) && tags[0] ? { tag_name: tags[0].name } : {};
    }
    const latest = String(release.tag_name || '').replace(/^v/i, '');
    if (!latest) return { ...base, latest: '', hasUpdate: false, error: '仓库暂无可用的版本标签' };
    return {
      ...base,
      latest,
      hasUpdate: compareVersion(latest, APP_VERSION) > 0,
      url: release.html_url || `https://github.com/${UPDATE_REPO}/releases`,
      notes: String(release.body || '').slice(0, 4000),
      publishedAt: release.published_at || '',
    };
  } catch (err) {
    return { ...base, latest: '', hasUpdate: false, error: err.message || '检查更新失败' };
  }
}

/* ------------------------------- 工具函数 ------------------------------- */

function json(res, status, data) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_e) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const result = {};
  for (const item of header.split(';')) {
    const [key, ...rest] = item.split('=');
    if (!key) continue;
    result[key.trim()] = decodeURIComponent(rest.join('=').trim());
  }
  return result;
}

function passwordHash(password) {
  return crypto.createHash('sha256').update(`${password}:qqnas`).digest('hex');
}

/** 额外用户的密码哈希与用户名绑定，改名即失效。 */
function userPasswordHash(name, password) {
  return crypto.createHash('sha256').update(`${name}:${password}:qqnas-user`).digest('hex');
}

/** 会话令牌由用户身份与密码哈希派生：重启不失效，改密即失效。 */
function sessionToken(userId, secret) {
  return crypto.createHash('sha256').update(`token:${userId}:${secret}:qqnas`).digest('hex');
}

/** 主账号（管理员）不落用户表，id 固定为 admin；密码取安装向导的访问密码。 */
const ADMIN_USER = { id: 'admin', name: '主账号', admin: true };

/** 会话有效期：登录一次长期记住，180 天。 */
const SESSION_MAX_AGE = 180 * 24 * 3600;

/** 主账号密码的令牌种子：未设访问密码时用空密码派生。 */
function adminSeed() {
  return passwordHash(ACCESS_PASSWORD || '');
}

/** 用户间隔离：账号归属登录用户；旧数据没有 owner，归主账号。 */
function owns(user, account) {
  return (account.owner || 'admin') === user.id;
}

function requestToken(req) {
  const cookies = parseCookies(req);
  let actual = cookies.qqnas_auth || '';
  if (!actual) {
    // 飞牛 Web UI 以 iframe 打开本应用时，跨站 Cookie 可能被浏览器丢弃。
    // 前端登录后会把令牌放请求头，这里同时接受 Header 方式。
    actual = String(req.headers['x-qqnas-token'] || '');
    if (!actual) {
      const auth = String(req.headers.authorization || '');
      const match = /^Bearer\s+(.+)$/i.exec(auth);
      if (match) actual = match[1].trim();
    }
  }
  return actual;
}

function resolveAuthUser(req) {
  const actual = requestToken(req);
  if (!actual) return null;
  if (safeEqual(actual, sessionToken('admin', adminSeed()))) return ADMIN_USER;
  for (const user of store.users) {
    if (!user.passwordHash) continue;
    if (safeEqual(actual, sessionToken(user.id, user.passwordHash))) {
      return { id: user.id, name: user.name, admin: Boolean(user.admin) };
    }
  }
  return null;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function consecutiveDays(days) {
  if (!Array.isArray(days) || !days.length) return 0;
  const set = new Set(days);
  const pad = (n) => String(n).padStart(2, '0');
  const cursor = new Date();
  let count = 0;
  for (let i = 0; i < 400; i++) {
    const key = `${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}-${pad(cursor.getDate())}`;
    if (set.has(key)) {
      count += 1;
      cursor.setDate(cursor.getDate() - 1);
    } else if (i === 0) {
      cursor.setDate(cursor.getDate() - 1);
    } else {
      break;
    }
  }
  return count;
}

function runtimeSnapshot() {
  const state = napcat.getRuntimeState();
  if (MOCK) return { ...state, status: 'mock', message: '演示模式', ready: true };
  return state;
}

function publicAccount(account) {
  return {
    id: account.id,
    alias: account.alias,
    qq: account.qq,
    nickname: account.nickname,
    createdAt: account.createdAt,
    containerName: account.containerName,
    containerState: account.containerState || 'unknown',
    desiredState: account.desiredState || 'stopped',
    pid: account.pid || 0,
    webuiPort: account.webuiPort,
    onebotPort: account.onebotPort,
    webuiToken: account.webuiToken,
    lastError: account.lastError || '',
    autoRestartGuard: account.autoRestartGuard || null,
    loginRecovery: account.loginRecovery || null,
    tasks: account.tasks,
    stats: {
      online: Boolean(account.stats && account.stats.online),
      onlineDays: (account.stats && account.stats.onlineDays) || [],
      onlineDayCount: ((account.stats && account.stats.onlineDays) || []).length,
      consecutiveDays: consecutiveDays((account.stats && account.stats.onlineDays) || []),
      lastSeen: (account.stats && account.stats.lastSeen) || 0,
      lastLoginAt: (account.stats && account.stats.lastLoginAt) || 0,
    },
  };
}

function findAccount(id) {
  const account = store.find(id);
  if (!account) throw Object.assign(new Error('账号不存在'), { status: 404 });
  return account;
}

/* ---------------------------- 任务参数清洗 ---------------------------- */

const NUMBER_RULES = {
  intervalMin: [1, 120],
  failThreshold: [1, 10],
  count: [1, 20],
  intervalSec: [1, 10],
  gapMin: [10, 1440],
  cooldownSec: [3, 86400],
};

function sanitizeTaskPatch(key, patch) {
  if (!TASK_KEYS.includes(key)) throw Object.assign(new Error('未知任务'), { status: 400 });
  const result = {};
  if (typeof patch.enabled === 'boolean') result.enabled = patch.enabled;
  if (typeof patch.autoRestart === 'boolean') result.autoRestart = patch.autoRestart;
  if (typeof patch.sendText === 'boolean') result.sendText = patch.sendText;
  if (key === 'dailyLike' && typeof patch.source === 'string' && ['group', 'friend'].includes(patch.source)) {
    result.source = patch.source;
  }
  if (key === 'broadcast' && typeof patch.scope === 'string' && ['group', 'friend'].includes(patch.scope)) {
    result.scope = patch.scope;
  }
  if (key === 'qzonePost' && patch.ugcRight !== undefined) {
    const ugcRight = Number(patch.ugcRight);
    if ([1, 4, 16, 64, 128].includes(ugcRight)) result.ugcRight = ugcRight;
  }
  if (key === 'qzonePost' && typeof patch.autoDelete === 'boolean') result.autoDelete = patch.autoDelete;
  if (key === 'qzonePost' && patch.deleteAfter !== undefined) {
    const value = Number(patch.deleteAfter);
    if (Number.isFinite(value)) result.deleteAfter = Math.min(86400, Math.max(0, Math.round(value)));
  }
  for (const [field, [min, max]] of Object.entries(NUMBER_RULES)) {
    if (patch[field] !== undefined) {
      const value = Number(patch[field]);
      if (Number.isFinite(value)) result[field] = Math.min(max, Math.max(min, Math.round(value)));
    }
  }
  for (const field of ['time', 'start', 'end']) {
    if (patch[field] !== undefined) {
      const value = String(patch[field] || '').trim();
      if (/^\d{1,2}:\d{2}$/.test(value)) result[field] = value;
    }
  }
  for (const field of ['groups', 'groupId', 'targets', 'times', 'keywords', 'text', 'reply', 'phrases', 'contents', 'images']) {
    if (patch[field] !== undefined) result[field] = String(patch[field] ?? '').slice(0, 4000);
  }
  return result;
}

/* ------------------------------ 端口分配 ------------------------------ */

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '0.0.0.0');
  });
}

async function allocatePort(accounts, field, start) {
  const used = new Set(
    accounts
      .map((account) => Number(account[field]))
      .filter((port) => Number.isFinite(port) && port > 0)
  );
  used.add(PORT);
  for (let port = start; port < start + 300; port += 1) {
    if (used.has(port)) continue;
    // eslint-disable-next-line no-await-in-loop
    if (await portFree(port)) return port;
  }
  throw new Error(`无法为 ${field} 分配可用端口`);
}

/** 兼容 1.x 升级上来的账号：补齐 WebUI 与 OneBot 端口。 */
async function ensureAccountPorts() {
  let changed = false;
  for (const account of store.accounts) {
    if (account.containerId === 'mock') continue;
    const others = store.accounts.filter((item) => item !== account);
    if (!Number(account.webuiPort)) {
      // eslint-disable-next-line no-await-in-loop
      account.webuiPort = await allocatePort(others, 'webuiPort', 6099);
      changed = true;
    }
    if (!Number(account.onebotPort)) {
      // eslint-disable-next-line no-await-in-loop
      account.onebotPort = await allocatePort(others, 'onebotPort', 3000);
      changed = true;
    }
  }
  if (changed) store.save();
  return changed;
}

/* ------------------------------ 状态探测 ------------------------------ */

const statusCache = new Map();
/** 状态探测单飞：同一账号同时只允许一个探测在跑。 */
const probeInflight = new Map();
const CONFIG_STATE = new Map();
const starting = new Set();

/**
 * 二维码缓存：NapCat 生成二维码是阻塞式的（要等 QQ 出图，常达数秒甚至
 * 超过接口超时），而登录弹窗每 3 秒轮询一次，逐个等待就会一直转圈。
 * 这里缓存最近的登录状态毫秒级返回，超过 15 秒后台异步刷新，
 * 5 分钟内的旧码先展示再静默换新，弹窗秒开、二维码自动接力。
 */
const QRCODE_REFRESH_AFTER = 15 * 1000;
const QRCODE_STALE_MAX = 5 * 60 * 1000;
const qrcodeCache = new Map();

function cacheQrState(accountId, webui) {
  const existing = qrcodeCache.get(accountId);
  // 后台刷新可能晚于更新的请求返回，旧结果不覆盖新结果。
  if (existing && existing.freshAt && existing.freshAt > (webui.fetchedAt || 0)) return;
  qrcodeCache.set(accountId, {
    qrcode: webui.qrcode || '',
    isLogin: Boolean(webui.isLogin),
    isOffline: Boolean(webui.isOffline),
    phase: webui.phase || '',
    error: webui.error || '',
    info: webui.info || null,
    at: Date.now(),
    freshAt: webui.fetchedAt || Date.now(),
    refreshing: false,
  });
}

function applyWebuiLogin(account, webui) {
  if (!webui.isLogin || !webui.info) return;
  const uin = webui.info.uin || webui.info.user_id;
  if (!uin) return;
  account.qq = String(uin);
  account.nickname = webui.info.nickname || webui.info.nick || account.nickname;
  account.stats.lastLoginAt = Date.now();
  napcat.ensureAccountOnebotConfig(account, account.qq);
  store.save();
}

/** 同一账号同一时刻只允许一个取码请求在飞，并发轮询共享同一个 Promise，不叠加压力。 */
const qrInflight = new Map();

function fetchQrStateOnce(account) {
  let pending = qrInflight.get(account.id);
  if (pending) return pending;
  const fetchedAt = Date.now();
  pending = napcat
    .getWebuiLoginState(account)
    .then((webui) => {
      webui.fetchedAt = fetchedAt;
      cacheQrState(account.id, webui);
      applyWebuiLogin(account, webui);
      trackQrProgress(account, webui);
      return webui;
    })
    .finally(() => {
      if (qrInflight.get(account.id) === pending) qrInflight.delete(account.id);
      const entry = qrcodeCache.get(account.id);
      if (entry) entry.refreshing = false;
    });
  qrInflight.set(account.id, pending);
  return pending;
}

function refreshQrStateInBackground(account) {
  // 正在重置登录态时不要取码，否则重启中的 WebUI 会返回一堆报错覆盖缓存。
  if (qrResetting.has(account.id)) return;
  const cached = qrcodeCache.get(account.id);
  if (cached && cached.refreshing) return;
  if (cached) cached.refreshing = true;
  fetchQrStateOnce(account).catch((err) => {
    // 失败也写入缓存，轮询能把错误带出来，而不是永远显示「生成中」。
    qrcodeCache.set(account.id, {
      qrcode: '',
      isLogin: false,
      isOffline: false,
      phase: '',
      error: (err && err.message) || '取码失败',
      info: null,
      at: Date.now(),
      freshAt: Date.now(),
      refreshing: false,
    });
  });
}

/* ---------------- 二维码取不到时的自愈：重置本地登录态 ---------------- */

/**
 * 账号被踢下线后，内核会拿本地旧票据反复重登、始终不进扫码页，
 * 表现为二维码永远是空、也没有任何报错。连续多轮取不到码就丢掉票据重启，
 * 强制 QQ 回到扫码登录界面重新出码。
 */
const QR_EMPTY_ROUNDS_BEFORE_RESET = 3;
const QR_RESET_TIMEOUT = 180 * 1000;
/** 本次启动刚恢复过登录态时，给内核留出进扫码页的时间，避免重置把刚恢复的票据删掉。 */
const QR_RESET_AFTER_RESTORE = 5 * 60 * 1000;
const qrEmptyRounds = new Map();
const qrResetDeferred = new Map();
const qrResetting = new Set();
/** 主动刷新二维码的连续失败次数：一次超时不足以判定票据失效。 */
const qrRefreshFails = new Map();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trackQrProgress(account, webui) {
  if (webui.isLogin || webui.qrcode) {
    qrEmptyRounds.delete(account.id);
    return;
  }
  // 启动初期内核还没进扫码阶段，先等宽限期，避免把有效登录票据误判成失效。
  const startedAt = Number(account.startedAt) || 0;
  if (startedAt && Date.now() - startedAt < 90 * 1000) return;
  // 之前登录过的账号有完整快照，交给保活用快照恢复，清票据反而会丢掉登录态。
  if (account.qq && napcat.hasGoodLogin(account)) return;
  // 本次启动刚成功恢复过登录态：内核可能还没进扫码页，或取码接口暂时异常，
  // 这期间自动重置会删掉刚落地的 nt_qq 票据，先跳过并记录一次。
  const restoredAt = Number((account.loginRecovery && account.loginRecovery.restoredAt) || 0);
  if (startedAt && restoredAt >= startedAt && Date.now() - restoredAt < QR_RESET_AFTER_RESTORE) {
    if (qrResetDeferred.get(account.id) !== restoredAt) {
      qrResetDeferred.set(account.id, restoredAt);
      logger.warn('本次启动刚恢复登录态，暂缓自动重置（等待内核进入扫码页）', {
        accountId: account.id,
        account: account.alias,
        restoredAt: new Date(restoredAt).toISOString(),
      });
    }
    return;
  }
  const rounds = (qrEmptyRounds.get(account.id) || 0) + 1;
  qrEmptyRounds.set(account.id, rounds);
  if (rounds >= QR_EMPTY_ROUNDS_BEFORE_RESET) resetAccountForQrcode(account);
}

async function waitQrcodeAfterReset(account, timeoutMs = QR_RESET_TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(2500);
    const info = await napcat.statusAccount(account).catch(() => null);
    if (!info || !info.webuiReady) continue;
    const webui = await napcat.getWebuiLoginState(account).catch(() => null);
    if (!webui) continue;
    account.qrSessionAt = Date.now();
    if (webui.isLogin || webui.qrcode) {
      cacheQrState(account.id, { ...webui, fetchedAt: Date.now() });
      applyWebuiLogin(account, webui);
      qrEmptyRounds.delete(account.id);
      return webui;
    }
  }
  throw new Error('重置登录态后仍未出码，请打开完整 WebUI 查看');
}

/** 两次自动重置之间的最小间隔，避免反复重启把账号拖死。 */
const QR_RESET_COOLDOWN = 5 * 60 * 1000;

function resetAccountForQrcode(account, { force = false } = {}) {
  if (qrResetting.has(account.id)) return;
  if (!force && Date.now() - (Number(account.qrResetAt) || 0) < QR_RESET_COOLDOWN) return;
  account.qrResetAt = Date.now();
  qrResetting.add(account.id);
  qrEmptyRounds.delete(account.id);
  qrcodeCache.set(account.id, {
    qrcode: '',
    isLogin: false,
    isOffline: false,
    phase: 'resetting',
    error: '登录票据已失效，正在重置登录状态并重新生成二维码…',
    info: null,
    at: Date.now(),
    freshAt: Date.now(),
    refreshing: false,
  });
  logger.warn('二维码连续为空，重置本地登录态并重启账号', {
    accountId: account.id,
    account: account.alias,
  });
  account.qrSessionAt = Date.now();
  napcat
    .resetLoginState(account)
    .then(() => waitQrcodeAfterReset(account))
    .then(() => logger.info('已重新生成二维码', { accountId: account.id, account: account.alias }))
    .catch((err) => {
      logger.error(`重置登录态失败：${err.message}`, { accountId: account.id, account: account.alias });
      qrcodeCache.set(account.id, {
        qrcode: '',
        isLogin: false,
        isOffline: false,
        phase: '',
        error: err.message,
        info: null,
        at: Date.now(),
        freshAt: Date.now(),
        refreshing: false,
      });
    })
    .finally(() => {
      qrResetting.delete(account.id);
      statusCache.delete(account.id);
    });
}

/**
 * 主动刷新二维码失败：先确认账号是否真的没登录，并且连续失败两次才允许重置票据。
 * 之前一次取码超时就删票据，会把仍然有效的登录态自己清掉。
 */
async function handleQrRefreshFailure(account, res, error) {
  const fails = (qrRefreshFails.get(account.id) || 0) + 1;
  qrRefreshFails.set(account.id, fails);
  if (fails < 2) {
    logger.warn('刷新二维码失败，先重试一次再考虑重置登录态', {
      accountId: account.id,
      account: account.alias,
      error: error || '',
    });
    return json(res, 200, { ok: true, retry: true, error: error || '二维码暂不可用' });
  }
  try {
    const state = await napcat.getWebuiLoginStateQuiet(account);
    if (state && state.isLogin) {
      qrRefreshFails.delete(account.id);
      cacheQrState(account.id, { isLogin: true, qrcode: '', info: state.info, fetchedAt: Date.now() });
      return json(res, 200, { ok: true, isLogin: true });
    }
  } catch (_e) {
    /* 读不到就按失效处理 */
  }
  qrRefreshFails.delete(account.id);
  resetAccountForQrcode(account, { force: true });
  return json(res, 200, { ok: true, resetting: true, error: error || '二维码已失效' });
}

async function probeAccount(account, { force = false } = {}) {
  const cached = statusCache.get(account.id);
  if (!force && cached && Date.now() - cached.at < 4000) return cached.value;
  // 面板每 5 秒轮询一次状态：同一账号的探测必须单飞，
  // 否则请求会堆叠，把 NapCat 打慢甚至拖垮。
  const pending = probeInflight.get(account.id);
  if (!force && pending) return pending;
  const run = probeAccountOnce(account).finally(() => {
    if (probeInflight.get(account.id) === run) probeInflight.delete(account.id);
  });
  probeInflight.set(account.id, run);
  return run;
}

async function probeAccountOnce(account) {
  if (MOCK) {
    const value = {
      running: true,
      containerState: 'running',
      online: false,
      qq: account.qq || '10001',
      nickname: account.nickname || '演示账号',
      webuiPort: account.webuiPort || 6099,
      onebotPort: account.onebotPort || 3000,
      webuiToken: account.webuiToken,
      startedAt: new Date().toISOString(),
      onebotReady: false,
      onlineDayCount: (account.stats.onlineDays || []).length,
      consecutiveDays: consecutiveDays(account.stats.onlineDays || []),
      runtimeReady: true,
    };
    statusCache.set(account.id, { at: Date.now(), value });
    return value;
  }

  const info = await napcat.statusAccount(account);
  const result = {
    running: info.running,
    containerState: account.containerState || 'unknown',
    online: false,
    qq: account.qq,
    nickname: account.nickname,
    webuiPort: account.webuiPort,
    onebotPort: account.onebotPort,
    webuiToken: account.webuiToken,
    startedAt: new Date(info.startedAt || Date.now()).toISOString(),
    onebotReady: false,
    webuiReady: info.webuiReady,
    runtimeReady: napcat.isRuntimeReady(),
  };

  if (info.running && info.webuiReady) {
    try {
      const client = engine.clientFor(account);
      const status = await client.getStatus();
      result.onebotReady = true;
      // get_status 的 online 可能是 null（查询不到）或踢下线后滞后误报，
      // 只有明确为 true 且能取到登录信息才算在线，否则交给 WebUI 登录态复核。
      let login = null;
      try {
        login = await client.getLoginInfo();
      } catch (_e) {
        login = null;
      }
      if (status && status.online === true && login && login.user_id) {
        result.online = true;
        result.qq = login.user_id;
        result.nickname = login.nickname;
        store.recordOnline(account, login.user_id, login.nickname);
        const key = `${account.id}:${login.user_id}`;
        if (!CONFIG_STATE.has(key)) {
          CONFIG_STATE.set(key, true);
          const changed = napcat.ensureAccountOnebotConfig(account, login.user_id);
          if (changed) logger.debug('已补写账号级 OneBot 配置', { accountId: account.id, account: account.alias });
          account.configReadyFor = String(login.user_id);
          store.save();
        }
      }
    } catch (_e) {
      result.online = false;
    }
  }

  if (!result.online && info.running && info.webuiReady) {
    try {
      // 只读探测：不能在这里顺手生成二维码/RefreshQRcode，
      // 否则面板每 5 秒轮询一次就可能把正在快速登录的账号打断。
      const webui = await napcat.getWebuiLoginStateQuiet(account);
      if (webui && webui.isLogin) {
        // OneBot 状态不明确时，以 NapCat WebUI 的登录态为准。
        result.webuiLoggedIn = true;
        result.online = true;
        const uin = webui.info && (webui.info.uin || webui.info.user_id);
        if (webui.info) {
          result.qq = uin || result.qq;
          result.nickname = webui.info.nickname || result.nickname;
        }
        store.recordOnline(account, uin, result.nickname);
      }
    } catch (_e) {
      /* WebUI 未就绪 */
    }
  }

  const value = {
    ...result,
    onlineDayCount: (account.stats.onlineDays || []).length,
    consecutiveDays: consecutiveDays(account.stats.onlineDays || []),
  };
  statusCache.set(account.id, { at: Date.now(), value });
  return value;
}

/* ------------------------------ 业务操作 ------------------------------ */

async function createAccount({ alias, owner }) {
  if (MOCK) {
    const account = createAccountRecord(alias || '演示账号');
    account.containerId = 'mock';
    account.containerState = 'running';
    account.desiredState = 'running';
    account.webuiPort = 6099;
    account.onebotPort = 3000;
    account.owner = owner || 'admin';
    store.add(account);
    return account;
  }

  const account = createAccountRecord(alias);
  account.owner = owner || 'admin';
  account.webuiPort = await allocatePort(store.accounts, 'webuiPort', 6099);
  account.onebotPort = await allocatePort(store.accounts, 'onebotPort', 3000);
  account.desiredState = 'running';
  account.containerState = 'preparing';
  napcat.ensureAccountDirs(account);
  napcat.resetRestartGuard(account);
  store.add(account);
  logger.info(`正在准备账号运行环境 ${account.alias}`, { accountId: account.id, account: account.alias });

  if (!napcat.isRuntimeReady()) {
    napcat.startRuntimeIfNeeded(account);
    logger.info('QQ 运行环境尚未安装，已开始后台安装', { accountId: account.id, account: account.alias });
    return account;
  }

  startAccountInBackground(account, { auto: false });
  return account;
}

function startAccountInBackground(account, { auto = true } = {}) {
  if (starting.has(account.id)) return;
  starting.add(account.id);
  napcat
    .startAccount(account)
    .then(() => {
      logger.info('NapCat 已启动', { accountId: account.id, account: account.alias });
    })
    .catch((err) => {
      logger.error(`启动 NapCat 失败：${err.message}`, { accountId: account.id, account: account.alias });
      account.containerState = 'error';
      account.lastError = err.message;
      if (auto) {
        const guard = napcat.noteRestartFailure(account);
        if (guard.attempts > MAX_AUTO_RESTARTS) {
          guard.suspended = true;
          account.lastError = `${err.message}（连续 ${guard.attempts} 次启动失败，已暂停自动重启）`;
        }
      }
      store.save();
    })
    .finally(() => {
      starting.delete(account.id);
      statusCache.delete(account.id);
    });
}

function sanitizeAlias(value) {
  return String(value || '').trim().slice(0, 40);
}

/* ------------------------------ 路由处理 ------------------------------ */

async function handleApi(req, res, url) {
  const method = req.method;
  const parts = url.pathname.split('/').filter(Boolean);

  if (url.pathname === '/api/health' && method === 'GET') {
    const state = runtimeSnapshot();
    return json(res, 200, {
      ok: true,
      engine: state.status,
      runtime: {
        status: state.status,
        message: state.message,
        progress: state.progress,
        ready: state.ready,
      },
      node: process.version,
      dataDir: DATA_DIR,
      version: APP_VERSION,
      uptime: Math.floor((Date.now() - runtime.startedAt) / 1000),
    });
  }

  if (url.pathname === '/api/session' && method === 'GET') {
    const current = resolveAuthUser(req);
    // 注册时按飞牛登录身份定权限：只有飞牛主账号（UID 1000）注册出来的才是主账号。
    const identity = fnosUser.detect(req);
    return json(res, 200, {
      // 始终用账号密码登录一次，之后长期记住。
      authRequired: true,
      adminPasswordSet: Boolean(ACCESS_PASSWORD),
      registrationOpen: true,
      canRegisterAdmin: fnosUser.isAdmin(identity),
      identity: identity ? { uid: identity.uid, name: identity.name, admin: identity.admin } : null,
      authed: Boolean(current),
      user: current ? { id: current.id, name: current.name, admin: current.admin } : null,
    });
  }

  if (url.pathname === '/api/login' && method === 'POST') {
    const body = await readBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    let user = null;
    let token = '';
    if (!username) {
      // 用户名留空即主账号（管理员），密码为安装向导设置的访问密码。
      if (ACCESS_PASSWORD && !safeEqual(password, ACCESS_PASSWORD)) {
        return json(res, 401, { error: '主账号密码不正确' });
      }
      user = ADMIN_USER;
      token = sessionToken('admin', adminSeed());
    } else {
      const found = store.findUserByName(username);
      const passwordOk = Boolean(found && found.passwordHash)
        && safeEqual(userPasswordHash(username, password), found.passwordHash);
      if (!passwordOk) {
        return json(res, 401, { error: '用户名或密码不正确' });
      }
      user = { id: found.id, name: found.name, admin: Boolean(found.admin) };
      token = sessionToken(found.id, found.passwordHash);
    }
    const cookie = `qqnas_auth=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`;
    res.setHeader('Set-Cookie', cookie);
    return json(res, 200, { ok: true, token, user });
  }

  if (url.pathname === '/api/logout' && method === 'POST') {
    res.setHeader('Set-Cookie', 'qqnas_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    return json(res, 200, { ok: true });
  }

  /* 自助注册：每个飞牛用户都能注册自己的账号密码，注册后自动登录。 */
  if (url.pathname === '/api/register' && method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || body.username || '').trim();
    if (!/^[\w一-龥-]{2,20}$/.test(name)) {
      return json(res, 400, { error: '用户名需 2–20 位，可用中英文、数字、下划线' });
    }
    if (name.toLowerCase() === 'admin') return json(res, 400, { error: '该用户名为系统保留' });
    if (store.findUserByName(name)) return json(res, 400, { error: '用户名已被注册' });
    const password = String(body.password || '');
    if (password.length < 6) return json(res, 400, { error: '密码至少 6 位' });

    // 权限只看飞牛登录身份：飞牛主账号（UID 1000）注册即主账号，其他人注册为普通用户。
    const identity = fnosUser.detect(req);
    const admin = fnosUser.isAdmin(identity);
    const created = store.addUser({
      id: crypto.randomBytes(6).toString('hex'),
      name,
      passwordHash: userPasswordHash(name, password),
      admin,
      fnosUid: identity ? identity.uid : '',
      createdAt: Date.now(),
    });
    const token = sessionToken(created.id, created.passwordHash);
    res.setHeader(
      'Set-Cookie',
      `qqnas_auth=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`
    );
    logger.info(`新用户注册：${name}${admin ? '（主账号）' : ''}`, { fnosUid: created.fnosUid });
    return json(res, 201, {
      ok: true,
      token,
      user: { id: created.id, name: created.name, admin },
      canRegisterAdmin: admin,
    });
  }

  const user = resolveAuthUser(req);
  if (!user) {
    return json(res, 401, { error: '需要登录', authRequired: true });
  }

  if (url.pathname === '/api/runtime' && method === 'GET') {
    return json(res, 200, { runtime: runtimeSnapshot(), node: process.version });
  }

  if (url.pathname === '/api/runtime/install' && method === 'POST') {
    if (MOCK) return json(res, 200, { ok: true, runtime: runtimeSnapshot() });
    const state = napcat.ensureRuntimeInBackground({ force: url.searchParams.get('force') === '1' });
    logger.info('已请求安装 QQ 运行环境');
    return json(res, 200, { ok: true, runtime: state });
  }

  if (url.pathname === '/api/runtime/log' && method === 'GET') {
    const state = runtimeSnapshot();
    return json(res, 200, { logs: state.log || '', runtime: state });
  }

  if (url.pathname === '/api/bootstrap' && method === 'GET') {
    return json(res, 200, {
      settings: store.settings,
      // 飞牛用户间隔离：只返回当前登录用户自己的账号。
      accounts: store.accounts.filter((account) => owns(user, account)).map(publicAccount),
      engine: runtimeSnapshot().status,
      runtime: runtimeSnapshot(),
      taskMeta: TASK_META,
      authRequired: true,
      user: { id: user.id, name: user.name, admin: user.admin },
      version: APP_VERSION,
    });
  }

  if (url.pathname === '/api/update/check' && method === 'GET') {
    return json(res, 200, await checkUpdate());
  }

  if (url.pathname === '/api/settings' && method === 'PATCH') {
    if (!user.admin) return json(res, 403, { error: '全局设置仅主账号可修改' });
    const body = await readBody(req);
    const settings = store.updateSettings(body);
    logger.info('已更新全局设置');
    return json(res, 200, { settings });
  }

  /* 通知设置：每个用户配置自己的掉线/恢复通知（企业微信/钉钉/飞书/Server酱/Bark）。 */

  if (url.pathname === '/api/notify' && method === 'GET') {
    const cfg = store.getNotify(user.id) || {};
    return json(res, 200, {
      notify: {
        type: cfg.type || '',
        target: cfg.target || '',
        offline: cfg.offline !== false,
        online: Boolean(cfg.online),
      },
      channels: notifyChannel.CHANNELS,
    });
  }

  if (url.pathname === '/api/notify' && method === 'PUT') {
    const body = await readBody(req);
    const type = String(body.type || '').trim();
    if (type && !notifyChannel.CHANNELS[type]) return json(res, 400, { error: '未知通知渠道' });
    const cfg = {
      type,
      target: String(body.target || '').trim(),
      offline: body.offline !== false,
      online: Boolean(body.online),
    };
    if (cfg.type && !cfg.target) return json(res, 400, { error: '请填写 Webhook 地址或 Key' });
    store.setNotify(user.id, cfg);
    logger.info('已更新通知设置');
    return json(res, 200, { notify: cfg });
  }

  if (url.pathname === '/api/notify/test' && method === 'POST') {
    const cfg = store.getNotify(user.id);
    if (!cfg || !cfg.type || !cfg.target) return json(res, 400, { error: '请先保存通知设置' });
    try {
      await notifyChannel.send(cfg, '【QQ挂机仓】测试通知', '通知渠道配置成功，账号掉线/恢复提醒将推送到这里。');
      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, 400, { error: `发送失败：${err.message}` });
    }
  }

  /* 用户管理：仅主账号（管理员）。主账号为每个飞牛用户创建独立的用户名+密码。 */

  if (url.pathname === '/api/users' && method === 'GET') {
    if (!user.admin) return json(res, 403, { error: '仅主账号可管理用户' });
    return json(res, 200, {
      users: store.users.map((u) => ({
        id: u.id,
        name: u.name,
        admin: Boolean(u.admin),
        createdAt: u.createdAt,
        accounts: store.accounts.filter((a) => (a.owner || 'admin') === u.id).length,
      })),
    });
  }

  if (url.pathname === '/api/users' && method === 'POST') {
    if (!user.admin) return json(res, 403, { error: '仅主账号可管理用户' });
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    if (!/^[\w一-龥-]{2,20}$/.test(name)) {
      return json(res, 400, { error: '用户名需 2–20 位，可用中英文、数字、下划线' });
    }
    if (name.toLowerCase() === 'admin') return json(res, 400, { error: '该用户名为系统保留' });
    if (store.findUserByName(name)) return json(res, 400, { error: '用户名已存在' });
    const password = String(body.password || '');
    if (password.length < 6) return json(res, 400, { error: '密码至少 6 位' });
    const created = store.addUser({
      id: crypto.randomBytes(6).toString('hex'),
      name,
      passwordHash: userPasswordHash(name, password),
      createdAt: Date.now(),
    });
    logger.info(`已创建用户：${name}`);
    return json(res, 201, { user: { id: created.id, name: created.name, createdAt: created.createdAt } });
  }

  if (parts[1] === 'users' && parts[2]) {
    if (!user.admin) return json(res, 403, { error: '仅主账号可管理用户' });
    const target = store.findUser(parts[2]);
    if (!target) return json(res, 404, { error: '用户不存在' });

    if (parts.length === 3 && method === 'DELETE') {
      const owned = store.accounts.filter((a) => (a.owner || 'admin') === target.id);
      if (owned.length) {
        return json(res, 400, { error: `该用户名下还有 ${owned.length} 个 QQ 账号，请先删除` });
      }
      store.removeUser(target.id);
      logger.info(`已删除用户：${target.name}`);
      return json(res, 200, { ok: true });
    }

    if (parts[3] === 'password' && method === 'POST') {
      const body = await readBody(req);
      const password = String(body.password || '');
      if (password.length < 6) return json(res, 400, { error: '密码至少 6 位' });
      target.passwordHash = userPasswordHash(target.name, password);
      store.save();
      logger.info(`已重置用户密码：${target.name}`);
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: '接口不存在' });
  }

  if (url.pathname === '/api/accounts' && method === 'POST') {
    const body = await readBody(req);
    const account = await createAccount({ alias: sanitizeAlias(body.alias), owner: user.id });
    return json(res, 201, { account: publicAccount(account) });
  }

  if (parts[1] === 'accounts' && parts[2]) {
    const account = store.find(parts[2]);
    // 隔离：他人账号对当前用户不可见，统一按不存在处理，不泄露任何信息。
    if (!account || !owns(user, account)) return json(res, 404, { error: '账号不存在' });

    if (parts.length === 3 && method === 'DELETE') {
      const purge = url.searchParams.get('purge') === '1';
      logger.info('正在删除账号', { accountId: account.id, account: account.alias });
      await napcat.stopAccount(account).catch(() => {});
      store.remove(account.id);
      if (purge) {
        await napcat.deleteAccountData(account).catch(() => {});
        logger.warn(`账号数据目录已删除：${account.id}`, { accountId: account.id, account: account.alias });
      }
      statusCache.delete(account.id);
      qrcodeCache.delete(account.id);
      qrEmptyRounds.delete(account.id);
      return json(res, 200, { ok: true, purged: purge });
    }

    if (parts.length === 3 && method === 'PATCH') {
      const body = await readBody(req);
      const alias = sanitizeAlias(body.alias);
      if (alias) account.alias = alias;
      store.save();
      return json(res, 200, { account: publicAccount(account) });
    }

    if (parts[3] === 'action' && method === 'POST') {
      const body = await readBody(req);
      const action = body.action;
      if (!['start', 'stop', 'restart', 'recreate'].includes(action)) {
        return json(res, 400, { error: '不支持的操作' });
      }
      if (!MOCK) {
        if (action === 'start') {
          account.desiredState = 'running';
          napcat.resetRestartGuard(account);
          await napcat.startAccount(account);
        }
        if (action === 'stop') {
          account.desiredState = 'stopped';
          await napcat.stopAccount(account);
        }
        if (action === 'restart') {
          account.desiredState = 'running';
          napcat.resetRestartGuard(account);
          await napcat.restartAccount(account);
        }
        if (action === 'recreate') {
          account.desiredState = 'running';
          napcat.resetRestartGuard(account);
          await napcat.recreateAccount(account);
        }
        const status = await napcat.statusAccount(account);
        if (action === 'stop') account.containerState = 'exited';
        else if (status.running) account.containerState = 'running';
      }
      if (MOCK) account.containerState = action === 'stop' ? 'exited' : 'running';
      store.save();
      statusCache.delete(account.id);
      qrcodeCache.delete(account.id); // 启停/重启/重建后旧二维码作废
      qrEmptyRounds.delete(account.id);
      logger.info(`账号操作：${action}`, { accountId: account.id, account: account.alias });
      return json(res, 200, { ok: true, account: publicAccount(account) });
    }

    if (parts[3] === 'status' && method === 'GET') {
      const status = await probeAccount(account, { force: url.searchParams.get('force') === '1' });
      return json(res, 200, { status, runtime: runtimeSnapshot() });
    }

    if (parts[3] === 'qr' && method === 'GET') {
      if (MOCK) {
        return json(res, 200, {
          ready: true,
          isLogin: false,
          qrcode: 'https://qun.qq.com/qrcode-demo',
          phase: 'waiting',
          error: '',
        });
      }
      const state = napcat.getRuntimeState();
      if (!state.ready) {
        napcat.startRuntimeIfNeeded(account);
        const next = napcat.getRuntimeState();
        return json(res, 200, {
          ready: false,
          isLogin: false,
          qrcode: '',
          phase: next.status,
          error: `正在安装 QQ 运行环境：${next.progress || next.message}`,
        });
      }
      const info = await napcat.statusAccount(account);
      if (!info.running) {
        if (account.desiredState === 'running') {
          napcat.resetRestartGuard(account);
          startAccountInBackground(account, { auto: false });
        }
        return json(res, 200, {
          ready: false,
          isLogin: false,
          qrcode: '',
          phase: 'starting',
          error: account.containerState === 'error' ? account.lastError : 'NapCat 正在启动，请稍候…',
        });
      }
      if (!info.webuiReady) {
        return json(res, 200, {
          ready: false,
          isLogin: false,
          qrcode: '',
          phase: 'starting',
          error: 'NapCat 正在启动，首次启动可能需要 30–60 秒',
        });
      }
      try {
        // 扫码窗口：用户正在弹窗里扫码，保活在此期间不重启进程，
        // 否则重启会作废刚生成的二维码、打断扫码登录。
        account.qrSessionAt = Date.now();
        const cached = qrcodeCache.get(account.id);
        // 正在重置登录态：明确告诉前端在做什么，避免弹窗一直空白。
        if (qrResetting.has(account.id)) {
          return json(res, 200, {
            ready: false,
            isLogin: false,
            qrcode: '',
            phase: 'resetting',
            error: (cached && cached.error) || '正在重置登录状态并重新生成二维码…',
          });
        }
        // 已登录：缓存很新才可信（掉线后旧登录态不能当真），否则后台复核。
        if (cached && cached.isLogin && Date.now() - cached.at < QRCODE_REFRESH_AFTER) {
          return json(res, 200, {
            ready: true,
            isLogin: true,
            isOffline: cached.isOffline,
            qrcode: '',
            phase: cached.phase,
            error: '',
            info: cached.info,
          });
        }
        // 缓存有码：毫秒级返回，超过 15 秒顺手后台刷新，弹窗不再转圈等码。
        if (cached && !cached.isLogin && cached.qrcode && Date.now() - cached.at < QRCODE_STALE_MAX) {
          if (Date.now() - cached.at > QRCODE_REFRESH_AFTER) refreshQrStateInBackground(account);
          return json(res, 200, {
            ready: true,
            isLogin: false,
            isOffline: cached.isOffline,
            qrcode: cached.qrcode,
            phase: cached.phase,
            error: cached.error,
            info: cached.info,
          });
        }
        // 无码可用：后台取码（被踢账号会自动强制刷新出码），立即返回占位，
        // 接口永不阻塞，取码完成后写入缓存，下一轮轮询（3 秒）即可拿到。
        refreshQrStateInBackground(account);
        // 最近一次取码失败：把错误透传给前端展示，15 秒后回到「生成中」继续重试。
        if (cached && cached.error && !cached.qrcode && !cached.isLogin && Date.now() - cached.at < QRCODE_REFRESH_AFTER) {
          return json(res, 200, { ready: false, isLogin: false, qrcode: '', phase: '', error: cached.error });
        }
        return json(res, 200, {
          ready: true,
          isLogin: false,
          qrcode: '',
          phase: (cached && cached.phase) || 'generating',
          error: '',
        });
      } catch (err) {
        // 接口异常时若有旧码先展示，同时后台重试，避免弹窗反复转圈。
        const cached = qrcodeCache.get(account.id);
        if (cached && !cached.isLogin && cached.qrcode) {
          refreshQrStateInBackground(account);
          return json(res, 200, {
            ready: true,
            isLogin: false,
            isOffline: cached.isOffline,
            qrcode: cached.qrcode,
            phase: cached.phase,
            error: cached.error,
            info: cached.info,
          });
        }
        return json(res, 200, { ready: false, error: err.message, isLogin: false, qrcode: '' });
      }
    }

    if (parts[3] === 'qr' && method === 'POST') {
      if (MOCK) return json(res, 200, { ok: true });
      try {
        account.qrSessionAt = Date.now(); // 扫码窗口：保活不重启进程
        qrEmptyRounds.delete(account.id);
        const qrcode = await napcat.refreshQrcode(account);
        // 主动刷新后旧缓存作废；拿到新码就直接入缓存，下次轮询秒回。
        qrcodeCache.delete(account.id);
        if (qrcode) {
          qrRefreshFails.delete(account.id);
          cacheQrState(account.id, { qrcode, isLogin: false });
          return json(res, 200, { ok: true, qrcode });
        }
        // 主动刷新也拿不到码：连续失败两次、且确认未登录，才重置登录态。
        return handleQrRefreshFailure(account, res, '二维码为空');
      } catch (err) {
        // 取码超时先重试；连续失败两次才按票据失效处理。
        return handleQrRefreshFailure(account, res, err.message);
      }
    }

    if (parts[3] === 'groups' && method === 'GET') {
      try {
        const groups = await engine.clientFor(account).getGroupList();
        return json(res, 200, {
          groups: (groups || []).map((group) => ({
            id: group.group_id,
            name: group.group_name,
            count: group.member_count,
          })),
        });
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
    }

    if (parts[3] === 'logs' && method === 'GET') {
      const logs = napcat.getAccountLogs(account, 120);
      return json(res, 200, { logs: logs || '暂无日志' });
    }

    if (parts[3] === 'tasks' && method === 'PATCH') {
      const body = await readBody(req);
      const patches = body.tasks && typeof body.tasks === 'object' ? body.tasks : { [body.task]: body.patch || {} };
      for (const [key, patch] of Object.entries(patches)) {
        const sanitized = sanitizeTaskPatch(key, patch || {});
        account.tasks[key] = { ...account.tasks[key], ...sanitized };
      }
      store.save();
      logger.info('任务配置已更新', { accountId: account.id, account: account.alias });
      return json(res, 200, { tasks: account.tasks });
    }

    if (parts[3] === 'run' && method === 'POST') {
      const body = await readBody(req);
      const result = await engine.runManual(account, body.task);
      return json(res, 200, { result });
    }
  }

  if (url.pathname === '/api/logs' && method === 'GET') {
    const after = Number(url.searchParams.get('after') || 0);
    const accountId = url.searchParams.get('accountId') || '';
    if (accountId) {
      const account = store.find(accountId);
      if (!account || !owns(user, account)) return json(res, 404, { error: '账号不存在' });
      return json(res, 200, { logs: logger.list({ after, accountId, limit: 400 }) });
    }
    // 全量日志按归属过滤：全局条目共享，账号条目只给归属人看。
    const ownedIds = new Set(store.accounts.filter((a) => owns(user, a)).map((a) => a.id));
    const logs = logger
      .list({ after, accountId: '', limit: 400 })
      .filter((entry) => !entry.accountId || ownedIds.has(entry.accountId));
    return json(res, 200, { logs });
  }

  return json(res, 404, { error: '接口不存在' });
}

/* ------------------------------ 静态资源 ------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * 兼容飞牛把应用挂在子路径下、且反代没有剥离前缀的情况：
 * /app/qqnas/styles.css 会依次尝试 /app/qqnas/styles.css、/qqnas/styles.css、/styles.css。
 */
function resolveStaticPath(pathname) {
  const candidates = [];
  if (pathname === '/') candidates.push('/index.html');
  else if (pathname.endsWith('/')) candidates.push(`${pathname}index.html`);
  else if (!/\.[a-z0-9]+$/i.test(pathname)) candidates.push(`${pathname}/index.html`);

  const wantsIndex = !/\.[a-z0-9]+$/i.test(pathname);
  const segments = pathname.split('/').filter(Boolean);
  if (pathname.endsWith('/')) segments.push('index.html');
  for (let i = 0; i <= segments.length; i += 1) {
    const rest = segments.slice(i).join('/');
    if (rest) candidates.push(`/${rest}`);
    if (wantsIndex) candidates.push(rest ? `/${rest}/index.html` : '/index.html');
  }

  for (const candidate of candidates) {
    const resolved = path.resolve(PUBLIC_DIR, `.${candidate}`);
    if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) continue;
    try {
      if (fs.statSync(resolved).isFile()) return resolved;
    } catch (_e) {
      /* 继续尝试下一个候选路径 */
    }
  }
  return '';
}

let inlineCache = null;

/** 把 CSS/JS 全部内联，彻底消除反代或子路径下子资源加载失败的问题。 */
function buildInlineHtml() {
  const indexFile = path.join(PUBLIC_DIR, 'index.html');
  const stat = fs.statSync(indexFile);
  if (inlineCache && inlineCache.mtime === stat.mtimeMs) return inlineCache.html;

  const read = (name) => fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
  const escapeScript = (code) => code.replace(/<\/script/gi, '<\\/script');
  const css = read('styles.css');
  const qrcode = escapeScript(read('vendor/qrcode.js'));
  const app = escapeScript(read('app.js'));

  let html = read('index.html');
  // 注意：替换内容里可能含有 $&、$'、$` 等字符序列，字符串形式会被当成替换模式展开，
  // 导致内联结果被破坏（旧的应用内联失败就是因此产生）；必须使用函数形式原样插入。
  html = html.replace(/<link[^>]+href=["']styles\.css["'][^>]*>/i, () => `<style>\n${css}\n</style>`);
  html = html.replace(
    /<script[^>]+src=["']vendor\/qrcode\.js["'][^>]*><\/script>/i,
    () => `<script>\n${qrcode}\n</script>`
  );
  html = html.replace(
    /<script[^>]+src=["']app\.js["'][^>]*><\/script>/i,
    () => `<script>\n${app}\n</script>`
  );
  inlineCache = { mtime: stat.mtimeMs, html };
  return html;
}

function serveStatic(req, res, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (_e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  const filePath = resolveStaticPath(pathname);
  if (!filePath) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }

  if (path.basename(filePath).toLowerCase() === 'index.html') {
    const html = buildInlineHtml();
    const body = Buffer.from(html, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': fs.statSync(filePath).size,
    'Cache-Control': 'public, max-age=3600',
  });
  fs.createReadStream(filePath).pipe(res);
}

/* ------------------------------ HTTP 服务 ------------------------------ */

/** 飞牛反代如果保留子路径前缀（/app/qqnas/api/...），这里把前缀去掉。 */
function stripProxyPrefix(url) {
  for (const marker of ['/api/', '/onebot/']) {
    const index = url.pathname.indexOf(marker);
    if (index > 0) {
      url.pathname = url.pathname.slice(index);
      return;
    }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  stripProxyPrefix(url);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }

    const eventMatch = /^\/onebot\/event\/([a-f0-9]+)$/.exec(url.pathname);
    if (eventMatch) {
      const account = store.find(eventMatch[1]);
      if (!account || !safeEqual(url.searchParams.get('secret') || '', account.hookSecret)) {
        res.writeHead(204);
        res.end();
        return;
      }
      let event = {};
      try {
        event = await readBody(req, 4 * 1024 * 1024);
      } catch (_e) {
        event = {};
      }
      res.writeHead(204);
      res.end();
      engine.handleEvent(account, event).catch((err) => {
        logger.warn(`处理事件失败：${err.message}`, { accountId: account.id, account: account.alias });
      });
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res, url);
      return;
    }
    res.writeHead(405);
    res.end();
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) {
      logger.error(`${req.method} ${url.pathname} 失败：${err.message}`);
    }
    if (!res.headersSent) json(res, status, { error: err.message || '服务器错误' });
    else res.end();
  }
});

/* ------------------------------ 后台巡检 ------------------------------ */

let supervising = false;

async function supervise() {
  if (supervising) return;
  supervising = true;
  try {
    const state = napcat.getRuntimeState();
    let changed = await ensureAccountPorts();

    for (const account of store.accounts) {
      if (account.containerId === 'mock') continue;
      if (account.desiredState === undefined) {
        account.desiredState = account.containerState === 'running' ? 'running' : 'stopped';
        changed = true;
      }
      if (!napcat.isRuntimeReady()) continue;
      const status = await napcat.statusAccount(account);
      if (account.desiredState === 'running' && !status.running && !starting.has(account.id)) {
        if (!napcat.canAutoRestart(account)) {
          // 暂停/退避状态已由保活和启动失败路径记录，避免每 8 秒重复刷日志。
          continue;
        }
        const guard = napcat.noteRestartAttempt(account);
        changed = true;
        // 反复起不来时暂停自动重启，避免 30 秒一轮的重启风暴把账号拖死。
        if (guard.attempts > MAX_AUTO_RESTARTS) {
          guard.suspended = true;
          account.lastError = '进程反复退出，已暂停自动重启，请查看账号日志';
          logger.warn(`NapCat 连续 ${guard.attempts} 次未能稳定运行，已暂停自动重启`, {
            accountId: account.id,
            account: account.alias,
          });
          continue;
        }
        logger.warn(`NapCat 未运行，自动重启（第 ${guard.attempts}/${MAX_AUTO_RESTARTS} 次）`, {
          accountId: account.id,
          account: account.alias,
        });
        startAccountInBackground(account, { auto: true });
      }
    }

    if (!state.ready && store.accounts.some((account) => account.desiredState === 'running')) {
      napcat.ensureRuntimeInBackground();
    }
    if (changed) store.save();
  } catch (err) {
    logger.warn(`后台巡检失败：${err.message}`);
  } finally {
    supervising = false;
  }
}

let supervisorTimer = null;

async function bootstrap() {
  engine.start();
  server.listen(PORT, HOST, () => {
    logger.info(`管理面板已启动：http://${HOST}:${PORT}（Node ${process.version}）`);
    logger.info(`QQ 运行环境：${napcat.isRuntimeReady() ? '已就绪' : '未安装'}`);
  });

  if (MOCK) {
    logger.info('已启用演示模式（QQNAS_MOCK=1）');
    if (!store.accounts.length) {
      const demo = createAccountRecord('演示账号');
      demo.containerId = 'mock';
      demo.containerState = 'running';
      demo.desiredState = 'running';
      demo.webuiPort = 6099;
      demo.onebotPort = 3000;
      store.add(demo);
    }
    return;
  }

  supervisorTimer = setInterval(supervise, 8000);
  setTimeout(supervise, 2500);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

let fatalExitScheduled = false;

process.on('uncaughtException', (err) => {
  try {
    logger.error(`未捕获异常：${err && err.stack ? err.stack : err}`);
  } catch (_e) {
    /* ignore */
  }
  try {
    store.saveNow();
  } catch (_e) {
    /* ignore */
  }
  if (fatalExitScheduled) return;
  fatalExitScheduled = true;
  // 受控退出，交给应用中心/守护进程重新拉起；避免异常状态下继续服务。
  setTimeout(() => process.exit(1), 300);
});

process.on('unhandledRejection', (reason) => {
  const message = reason && reason.stack ? reason.stack : String(reason);
  try {
    logger.error(`未处理的 Promise 拒绝：${message}`);
  } catch (_e) {
    /* ignore */
  }
  // 单个异步任务失败不应拖垮整个管理端；记录后继续运行。
});

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('正在关闭服务');
  engine.stop();
  if (supervisorTimer) clearInterval(supervisorTimer);
  store.saveNow();
  if (!MOCK) {
    await Promise.allSettled(
      store.accounts.map((account) => napcat.stopAccount(account, { preserveDesired: true }))
    );
  }
  store.saveNow();
  server.close(() => process.exit(0));
  // 停止账号时要等 QQ 优雅退出并完成登录快照，留足时间（cmd/main 会给 25 秒）。
  setTimeout(() => process.exit(0), 20000);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
