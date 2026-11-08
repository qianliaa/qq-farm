'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DEFAULT_SETTINGS = {
  logLimit: 800,
  autoRestart: true,
};

function defaultTasks() {
  return {
    keepalive: {
      enabled: true,
      intervalMin: 5,
      autoRestart: true,
      failThreshold: 2,
    },
    dailyLike: {
      enabled: false,
      time: '08:30',
      source: 'group',
      groupId: '',
      count: 10,
      intervalSec: 3,
      lastRunDate: '',
    },
    groupSign: {
      enabled: false,
      time: '07:30',
      groups: '',
      sendText: false,
      text: '签到',
      lastRunDate: '',
    },
    qzonePost: {
      enabled: false,
      time: '09:10',
      contents: '今天也要元气满满~\n记录一下今天的小确幸',
      images: '',
      ugcRight: 1,
      autoDelete: true,
      deleteAfter: 60,
      pendingDeletes: [],
      lastRunDate: '',
    },
    broadcast: {
      enabled: false,
      times: '12:00,20:00',
      scope: 'group',
      targets: '',
      text: '',
      lastRunSlots: {},
    },
    randomActive: {
      enabled: false,
      start: '09:30',
      end: '22:00',
      groups: '',
      gapMin: 90,
      phrases: '冒个泡~\n有人在吗',
      lastRun: 0,
    },
    autoReply: {
      enabled: false,
      keywords: '在吗,你好',
      reply: '在的，稍后回复你~',
      cooldownSec: 60,
    },
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const DEFAULT_RESTART_GUARD = {
  suspended: false,
  failures: 0,
  attempts: 0,
  nextRetryAt: 0,
  lastAttemptAt: 0,
  updatedAt: 0,
};

const DEFAULT_LOGIN_RECOVERY = {
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
  restoreAttempted: false,
  restoreAction: '',
  restoreResult: '',
  webuiIsLogin: null,
  lastRestoredGoodAt: 0,
  lastRestoredSnapshotAt: 0,
  error: '',
};

function createAccountRecord(alias) {
  const id = crypto.randomBytes(4).toString('hex');
  return {
    id,
    alias: String(alias || '').trim() || 'QQ 账号',
    qq: '',
    nickname: '',
    createdAt: new Date().toISOString(),
    containerId: '',
    containerName: `qqnas-${id}`,
    desiredState: 'stopped',
    pid: 0,
    webuiPort: null,
    onebotPort: null,
    webuiToken: crypto.randomBytes(12).toString('hex'),
    onebotToken: crypto.randomBytes(16).toString('hex'),
    hookSecret: crypto.randomBytes(16).toString('hex'),
    autoRestartGuard: { ...DEFAULT_RESTART_GUARD },
    loginRecovery: { ...DEFAULT_LOGIN_RECOVERY },
    tasks: defaultTasks(),
    stats: {
      onlineDays: [],
      lastSeen: 0,
      lastLoginAt: 0,
      online: false,
    },
  };
}

class Store {
  constructor() {
    this.data = {
      version: 1,
      settings: clone(DEFAULT_SETTINGS),
      accounts: [],
      users: [],
      notify: {},
    };
    this.saveTimer = null;
    this.load();
  }

  load() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(CONFIG_FILE)) {
      this.saveNow();
      return;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      this.data = {
        version: 1,
        settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
        accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
        users: Array.isArray(raw.users) ? raw.users : [],
        notify: raw.notify && typeof raw.notify === 'object' ? raw.notify : {},
      };
      for (const account of this.data.accounts) {
        account.tasks = { ...defaultTasks(), ...(account.tasks || {}) };
        account.stats = { onlineDays: [], lastSeen: 0, lastLoginAt: 0, online: false, ...(account.stats || {}) };
        // 旧 config.json 没有这两个字段，补齐后保持向前兼容。
        account.autoRestartGuard = { ...DEFAULT_RESTART_GUARD, ...(account.autoRestartGuard || {}) };
        account.loginRecovery = { ...DEFAULT_LOGIN_RECOVERY, ...(account.loginRecovery || {}) };
      }
    } catch (err) {
      const backup = `${CONFIG_FILE}.broken-${Date.now()}`;
      try {
        fs.copyFileSync(CONFIG_FILE, backup);
      } catch (_e) {
        /* ignore */
      }
      console.error(`[store] 配置解析失败，已备份到 ${backup}：${err.message}`);
    }
  }

  save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 300);
  }

  saveNow() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${CONFIG_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, CONFIG_FILE);
  }

  get settings() {
    return this.data.settings;
  }

  get accounts() {
    return this.data.accounts;
  }

  find(id) {
    return this.data.accounts.find((a) => a.id === id);
  }

  add(account) {
    this.data.accounts.push(account);
    this.saveNow();
    return account;
  }

  remove(id) {
    const index = this.data.accounts.findIndex((a) => a.id === id);
    if (index < 0) return null;
    const [removed] = this.data.accounts.splice(index, 1);
    this.saveNow();
    return removed;
  }

  updateSettings(patch) {
    const next = { ...this.data.settings };
    if (Number.isFinite(Number(patch.logLimit))) next.logLimit = Math.min(3000, Math.max(100, Number(patch.logLimit)));
    if (typeof patch.autoRestart === 'boolean') next.autoRestart = patch.autoRestart;
    this.data.settings = next;
    this.saveNow();
    return next;
  }

  /* 额外用户（飞牛用户间隔离）：主用户不落表，使用安装向导的访问密码。 */

  get users() {
    return this.data.users;
  }

  findUserByName(name) {
    return this.data.users.find((u) => u.name === name) || null;
  }

  findUser(id) {
    return this.data.users.find((u) => u.id === id) || null;
  }

  addUser(user) {
    this.data.users.push(user);
    this.saveNow();
    return user;
  }

  removeUser(id) {
    const index = this.data.users.findIndex((u) => u.id === id);
    if (index < 0) return null;
    const [removed] = this.data.users.splice(index, 1);
    // 顺手清理该用户的通知配置
    if (this.data.notify && this.data.notify[id]) delete this.data.notify[id];
    this.saveNow();
    return removed;
  }

  /* 通知配置：按用户隔离，各自配置自己的掉线/恢复通知。 */

  getNotify(userId) {
    return (this.data.notify && this.data.notify[userId]) || null;
  }

  setNotify(userId, config) {
    this.data.notify[userId] = config;
    this.saveNow();
    return config;
  }

  recordOnline(account, userId, nickname) {
    const now = Date.now();
    account.stats.online = true;
    account.stats.lastSeen = now;
    if (userId) account.qq = String(userId);
    if (nickname) account.nickname = nickname;
    const day = formatDate(new Date());
    if (!account.stats.onlineDays.includes(day)) {
      account.stats.onlineDays.push(day);
      if (account.stats.onlineDays.length > 400) account.stats.onlineDays.shift();
      this.save();
    }
  }

  recordOffline(account) {
    if (account.stats.online) {
      account.stats.online = false;
      this.save();
    }
  }
}

function formatDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

module.exports = {
  Store,
  DATA_DIR,
  CONFIG_FILE,
  DEFAULT_SETTINGS,
  defaultTasks,
  createAccountRecord,
  formatDate,
  clone,
};
