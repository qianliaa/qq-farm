'use strict';

/* ------------------------------- 基础工具 ------------------------------- */

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

/**
 * 飞牛可能把应用挂到子路径下（例如 /app/qqnas/）。
 * 用当前页面路径推导接口前缀，避免绝对路径 /api 打到飞牛主站。
 */
const API_BASE = (() => {
  const pathname = window.location.pathname || '/';
  if (pathname.endsWith('/')) return pathname;
  if (/\.[a-z0-9]+$/i.test(pathname)) return pathname.replace(/[^/]*$/i, '');
  return `${pathname}/`;
})();

function apiUrl(path) {
  return `${API_BASE}${String(path).replace(/^\/+/, '')}`;
}

/**
 * 飞牛 Web UI 用 iframe 打开应用时，跨站 Cookie 可能被浏览器拦截。
 * 登录后把令牌放进 sessionStorage，并通过请求头带给服务端。
 */
const TOKEN_KEY = 'qqnas.token';

function authHeaders() {
  try {
    const token = sessionStorage.getItem(TOKEN_KEY) || '';
    return token ? { 'X-QQNAS-Token': token } : {};
  } catch (_e) {
    return {};
  }
}

/**
 * 飞牛窗口可能是禁用第三方存储的 iframe，直接访问 localStorage 会抛
 * SecurityError 并中断整个脚本。所有本地存储必须走安全包装。
 */
function storageGet(key) {
  try {
    return localStorage.getItem(key) || '';
  } catch (_e) {
    return '';
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (_e) {
    /* 存储不可用时忽略，仅影响记忆上次选中的账号 */
  }
}

const state = {
  accounts: [],
  settings: {},
  taskMeta: {},
  engine: 'checking',
  runtime: {},
  health: null,
  authRequired: false,
  currentId: storageGet('qqnas.current'),
  status: null,
  renderedAccountId: '',
  logs: [],
  lastLogId: 0,
  logFilterAccount: false,
  authResolver: null,
  confirmResolver: null,
  qr: { accountId: '', timer: null, current: '', done: false },
  timers: {},
  creating: false,
};

const ICONS = {
  keepalive: '<svg viewBox="0 0 24 24"><path d="M3 12h4l2.5-6 5 12 2.5-6h4"/></svg>',
  dailyLike: '<svg viewBox="0 0 24 24"><path d="M12 20s-7-4.6-7-9.5A3.9 3.9 0 0 1 12 7a3.9 3.9 0 0 1 7 3.5C19 15.4 12 20 12 20Z"/></svg>',
  groupSign: '<svg viewBox="0 0 24 24"><path d="M4 5h16v14H4z"/><path d="m8 12 2.4 2.4L16 9"/></svg>',
  qzonePost: '<svg viewBox="0 0 24 24"><path d="M4 5h16v14H4z"/><path d="M8 9h8M8 13h5"/><path d="m15 15 3-3 2 2-3 3h-2v-2Z"/></svg>',
  broadcast: '<svg viewBox="0 0 24 24"><path d="m4 11 15-6-2 14-6-4-3 4v-4l-4-4Z"/></svg>',
  randomActive: '<svg viewBox="0 0 24 24"><path d="M4 7h4l8 10h4M4 17h4l2-2.5M16 7h4"/><path d="m18 5 2 2-2 2M18 15l2 2-2 2"/></svg>',
  autoReply: '<svg viewBox="0 0 24 24"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.8-.8L3 21l1.9-4.6A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5Z"/><path d="m8.5 11.5 2 2 4-4"/></svg>',
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
  });
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function fmtClock(ts) {
  const date = new Date(ts);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function fmtDateTime(ts) {
  const date = new Date(ts);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function fmtUptime(seconds) {
  if (!Number.isFinite(Number(seconds))) return '—';
  const total = Math.max(0, Math.floor(Number(seconds)));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days}天${hours}时`;
  if (hours) return `${hours}时${minutes}分`;
  return `${minutes}分`;
}

function currentAccount() {
  return state.accounts.find((account) => account.id === state.currentId) || null;
}

function toast(message, type = 'info', duration = 2600) {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.innerHTML = `<span class="toast-dot"></span><p>${esc(message)}</p>`;
  $('#toasts').appendChild(node);
  requestAnimationFrame(() => node.classList.add('show'));
  setTimeout(() => {
    node.classList.remove('show');
    setTimeout(() => node.remove(), 220);
  }, duration);
}

function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
}
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
}
function closeAllMenus() {
  $('#moreMenu').classList.add('hidden');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_e) {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (_e2) {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

/* --------------------------------- API --------------------------------- */

async function rawApi(path, options = {}) {
  const { timeout = 15000, signal, ...rest } = options;
  const controller = new AbortController();
  const timer = timeout > 0 ? setTimeout(() => controller.abort(), timeout) : null;
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let response;
  try {
    response = await fetch(apiUrl(path), {
      ...rest,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(),
        ...(rest.headers || {}),
      },
    });
  } catch (_error) {
    if (controller.signal.aborted) {
      throw new Error(`请求超时（${Math.round(timeout / 1000)} 秒），管理服务可能未启动或未响应`);
    }
    throw new Error('无法连接管理服务，请确认应用正在运行');
  } finally {
    if (timer) clearTimeout(timer);
  }

  let data = {};
  try {
    data = await response.json();
  } catch (_e) {
    data = {};
  }
  if (!response.ok) {
    const error = new Error(data.error || `请求失败（HTTP ${response.status}）`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function api(path, options = {}, retry = true) {
  try {
    return await rawApi(path, options);
  } catch (error) {
    if (error.status === 401 && retry) {
      await showAuth();
      return api(path, options, false);
    }
    throw error;
  }
}

function showAuth() {
  if (state.authResolver) return new Promise((resolve) => {
    const previous = state.authResolver;
    state.authResolver = (ok) => {
      previous(ok);
      resolve(ok);
    };
  });
  openModal('authModal');
  setTimeout(() => $('#authPassword').focus(), 60);
  return new Promise((resolve) => {
    state.authResolver = resolve;
  });
}

async function submitAuth() {
  const username = ($('#authUsername') && $('#authUsername').value.trim()) || '';
  const password = $('#authPassword').value;
  $('#authError').classList.add('hidden');
  try {
    const data = await rawApi('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    if (data && data.token) {
      try {
        sessionStorage.setItem(TOKEN_KEY, data.token);
      } catch (_e) {
        /* 隐私模式下可能不可写，Cookie 仍可兜底 */
      }
    }
    closeModal('authModal');
    $('#authPassword').value = '';
    const resolver = state.authResolver;
    state.authResolver = null;
    if (resolver) resolver(true);
  } catch (_e) {
    $('#authError').classList.remove('hidden');
  }
}

/* ------------------------------- 数据加载 ------------------------------- */

async function loadBootstrap({ renderTasks = true } = {}) {
  const data = await api('/api/bootstrap');
  applyBootstrap(data, { renderTasks });
}

function applyBootstrap(data, { renderTasks = true } = {}) {
  state.accounts = data.accounts || [];
  state.user = data.user || null;
  state.settings = data.settings || {};
  state.taskMeta = data.taskMeta || {};
  state.engine = data.engine || 'checking';
  state.runtime = data.runtime || {};
  if (!state.currentId || !state.accounts.some((account) => account.id === state.currentId)) {
    state.currentId = state.accounts.length ? state.accounts[0].id : '';
    storageSet('qqnas.current', state.currentId);
    state.renderedAccountId = '';
  }
  renderSidebar();
  renderHeader();
  renderRuntimeBanner();
  renderMain({ renderTasks: renderTasks && state.renderedAccountId !== state.currentId });
  state.renderedAccountId = state.currentId;
}

function runtimeStatusText(status) {
  return {
    ready: '已就绪',
    installing: '安装中',
    missing: '未安装',
    checking: '检测中',
    error: '安装失败',
    mock: '演示模式',
  }[status] || '未就绪';
}

function renderRuntimeBanner() {
  const banner = $('#runtimeBanner');
  if (!banner) return;
  const runtime = state.runtime || {};
  const status = runtime.status || state.engine;
  const ready = runtime.ready === true || status === 'ready' || status === 'mock';
  if (ready) {
    banner.classList.add('hidden');
    return;
  }
  banner.classList.remove('hidden');
  const spinner = $('#runtimeSpinner');
  if (spinner) spinner.style.display = status === 'installing' ? '' : 'none';
  const title = $('#runtimeBannerTitle');
  const text = $('#runtimeBannerText');
  if (status === 'installing') {
    title.textContent = '正在安装 QQ 运行环境';
    text.textContent = runtime.progress || runtime.message || '首次安装 Linux QQ 与 NapCat，约 5–20 分钟';
  } else if (status === 'error') {
    title.textContent = 'QQ 运行环境安装失败';
    text.textContent = runtime.message || '请查看安装日志后重试';
  } else {
    title.textContent = 'QQ 运行环境尚未安装';
    text.textContent = '添加账号后会自动安装，也可以点击右侧「重新安装」立即开始';
  }
  const installButton = $('#btnInstallRuntime');
  if (installButton) {
    installButton.disabled = status === 'installing';
    installButton.textContent = status === 'installing' ? '安装中…' : '重新安装';
  }
}

async function loadRuntime() {
  try {
    const data = await api('/api/runtime');
    state.runtime = data.runtime || {};
    state.engine = state.runtime.status || state.engine;
    renderRuntimeBanner();
    if ($('#settingsModal') && !$('#settingsModal').classList.contains('hidden')) fillSettings();
    if (state.runtime.status === 'ready') {
      const waiting = state.accounts.some(
        (account) => account.desiredState === 'running' && account.containerState !== 'running'
      );
      if (waiting) await loadBootstrap({ renderTasks: false });
    }
  } catch (_e) {
    /* 下一轮重试 */
  }
}

async function installRuntime() {
  const button = $('#btnInstallRuntime');
  if (button) {
    button.disabled = true;
    button.textContent = '正在开始…';
  }
  try {
    const data = await api('/api/runtime/install', { method: 'POST', timeout: 20000 });
    state.runtime = data.runtime || state.runtime;
    renderRuntimeBanner();
    toast('已开始安装 QQ 运行环境，请耐心等待', 'info', 5000);
  } catch (error) {
    toast(`启动安装失败：${error.message}`, 'error');
    if (button) {
      button.disabled = false;
      button.textContent = '重新安装';
    }
  }
}

async function openRuntimeLog() {
  $('#logsTitle').textContent = '运行环境安装日志';
  $('#modalLogs').textContent = '加载中…';
  openModal('logsModal');
  try {
    const data = await api('/api/runtime/log', { timeout: 20000 });
    $('#modalLogs').textContent = data.logs || '暂无安装日志';
  } catch (error) {
    $('#modalLogs').textContent = `读取失败：${error.message}`;
  }
}

async function loadHealth() {
  try {
    state.health = await rawApi('/api/health');
    if (state.health.runtime) {
      state.runtime = { ...state.runtime, ...state.health.runtime };
      state.engine = state.health.engine || state.engine;
      renderRuntimeBanner();
    }
    updateUptime();
    if (!$('#settingsModal').classList.contains('hidden')) fillSettings();
  } catch (_e) {
    /* ignore */
  }
}

async function refreshStatus({ force = false } = {}) {
  const account = currentAccount();
  if (!account) {
    state.status = null;
    return;
  }
  try {
    const data = await api(`/api/accounts/${account.id}/status${force ? '?force=1' : ''}`);
    if (state.currentId !== account.id) return;
    state.status = data.status;
    updateStatusUI();
  } catch (_e) {
    /* 状态接口失败不打断轮询 */
  }
}

/* -------------------------------- 渲染 -------------------------------- */

function setEngineChip(cls, text, title = '') {
  const chip = $('#engineChip');
  chip.className = `engine-chip ${cls}`.trim();
  chip.innerHTML = `<i></i>${esc(text)}`;
  chip.title = title;
}

function renderHeader() {
  const online = state.accounts.filter((account) => {
    if (account.id === state.currentId && state.status) return state.status.online;
    return account.stats && account.stats.online;
  }).length;
  $('#statOnline').textContent = online;
  $('#statTotal').textContent = state.accounts.length;
  $('#accountCount').textContent = state.accounts.length;
  updateUptime();

  const runtimeStatus = (state.runtime && state.runtime.status) || state.engine;
  if (runtimeStatus === 'mock') {
    setEngineChip('mock', '演示模式');
  } else if (runtimeStatus === 'ready') {
    setEngineChip('ok', '运行环境就绪');
  } else if (runtimeStatus === 'installing') {
    setEngineChip('warn', '安装运行环境');
  } else if (runtimeStatus === 'error') {
    setEngineChip('bad', '运行环境异常', state.runtime.message || '请查看安装日志');
  } else if (runtimeStatus === 'checking') {
    setEngineChip('', '连接中', '管理服务正在检查运行环境');
  } else {
    setEngineChip('warn', '运行环境未安装', '添加账号后会自动安装 Linux QQ 与 NapCat');
  }
  if (state.health && state.health.version) $('#versionText').textContent = `v${state.health.version}`;
}

function updateUptime() {
  if (state.health) $('#statUptime').textContent = fmtUptime(state.health.uptime);
}

function renderSidebar() {
  const list = $('#accountList');
  if (!state.accounts.length) {
    list.innerHTML = '<div class="sidebar-empty">暂无账号</div>';
    return;
  }
  list.innerHTML = state.accounts
    .map((account) => {
      const active = account.id === state.currentId;
      const online = account.id === state.currentId && state.status ? state.status.online : account.stats && account.stats.online;
      const name = account.nickname || account.alias || 'QQ 账号';
      return `
        <button class="account-item ${active ? 'active' : ''}" data-id="${esc(account.id)}">
          <span class="avatar tiny">${esc(initials(account))}</span>
          <span class="acc-main">
            <b>${esc(account.alias)}</b>
            <small>${account.qq ? `QQ ${esc(account.qq)}` : '未登录'}</small>
          </span>
          <span class="dot ${online ? 'online' : ''}" title="${online ? '在线' : '离线'}"></span>
        </button>`;
    })
    .join('');
}

function initials(account) {
  const source = account.nickname || account.alias || account.qq || 'Q';
  return source.slice(0, 1).toUpperCase();
}

function renderMain({ renderTasks = true } = {}) {
  const account = currentAccount();
  if (!account) {
    $('#emptyState').classList.remove('hidden');
    $('#accountView').classList.add('hidden');
    state.status = null;
    return;
  }
  $('#emptyState').classList.add('hidden');
  $('#accountView').classList.remove('hidden');
  updateAccountHeader(account);
  if (renderTasks) renderTaskGrid();
  updateStatusUI();
}

function updateAccountHeader(account) {
  $('#avatar').textContent = initials(account);
  $('#accountAlias').textContent = account.alias;
  $('#accountSub').textContent = buildSubtitle(account);
  $('#webuiToken').textContent = account.webuiToken || '—';
}

function buildSubtitle(account) {
  const status = state.status;
  const qq = (status && status.qq) || account.qq;
  const nickname = (status && status.nickname) || account.nickname;
  const container = status ? status.containerState : account.containerState;
  const parts = [qq ? `QQ ${qq}` : '未登录 QQ'];
  if (nickname) parts.push(nickname);
  parts.push(`运行${runtimeText(container)}`);
  return parts.join(' · ');
}

function runtimeText(value) {
  return {
    running: '中',
    exited: '已停止',
    created: '已创建',
    starting: '启动中',
    preparing: '准备中',
    waiting: '等待运行环境',
    restarting: '重启中',
    paused: '已暂停',
    missing: '未安装',
    removed: '已删除',
    error: '异常',
    unknown: '状态未知',
  }[value] || (value || '状态未知');
}

function statusMeta(account) {
  const status = state.status;
  const running = status ? status.running : account.containerState === 'running';
  const online = status ? status.online : account.stats && account.stats.online;
  if (online) return { cls: 'online', text: '在线' };
  if (!running) return { cls: 'off', text: status ? '已停止' : runtimeText(account.containerState) };
  return { cls: 'warn', text: '待登录' };
}

function updateStatusUI() {
  const account = currentAccount();
  if (!account) return;
  const status = state.status || {};
  const meta = statusMeta(account);

  const chip = $('#accountStatus');
  chip.className = `status-chip ${meta.cls}`;
  chip.innerHTML = `<i></i>${meta.text}`;

  $('#accountSub').textContent = buildSubtitle(account);

  const days = status.onlineDayCount !== undefined ? status.onlineDayCount : account.stats.onlineDayCount;
  const streak = status.consecutiveDays !== undefined ? status.consecutiveDays : account.stats.consecutiveDays;
  $('#statDays').textContent = days || 0;
  $('#statStreak').textContent = streak || 0;
  const container = status.containerState || account.containerState;
  $('#statContainer').textContent = runtimeText(container);
  $('#statPort').textContent = (status.webuiPort || account.webuiPort) ? `${status.webuiPort || account.webuiPort}` : '—';

  const running = status.running !== undefined ? status.running : account.containerState === 'running';
  $('#btnStop').textContent = running ? '停止' : '启动';

  const item = document.querySelector(`.account-item[data-id="${account.id}"] .dot`);
  if (item) item.classList.toggle('online', Boolean(status.online));
}

function taskLastNote(key, task) {
  if (key === 'keepalive') return task.enabled ? `每 ${task.intervalMin || 5} 分钟探测` : '未启用';
  if (key === 'autoReply') return task.enabled ? '消息事件实时触发' : '未启用';
  if (key === 'broadcast') {
    const slots = Object.keys(task.lastRunSlots || {});
    const todayKey = localDateKey();
    const todayCount = slots.filter((slot) => slot.startsWith(todayKey)).length;
    return task.enabled ? `今日已发送 ${todayCount} 个时间点` : '未启用';
  }
  if (key === 'randomActive') {
    return task.lastRun ? `上次发送 ${fmtDateTime(task.lastRun)}` : '尚未执行';
  }
  if (key === 'qzonePost') {
    const pending = Array.isArray(task.pendingDeletes) ? task.pendingDeletes.length : 0;
    const base = task.lastRunDate ? `上次执行 ${task.lastRunDate}` : task.enabled ? '等待到点执行' : '未启用';
    return pending ? `${base}，待删除 ${pending} 条` : base;
  }
  if (task.lastRunDate) return `上次执行 ${task.lastRunDate}`;
  return task.enabled ? '等待到点执行' : '未启用';
}

function numberField(label, field, value, min, max, hint) {
  return `
    <label class="task-field">
      <span>${label}</span>
      <input type="number" data-field="${field}" value="${esc(value)}" min="${min}" max="${max}">
      ${hint ? `<small>${hint}</small>` : ''}
    </label>`;
}

function timeField(label, field, value) {
  return `
    <label class="task-field">
      <span>${label}</span>
      <input type="time" data-field="${field}" value="${esc(value || '')}">
    </label>`;
}

function textField(label, field, value, placeholder, hint) {
  return `
    <label class="task-field">
      <span>${label}</span>
      <input type="text" data-field="${field}" value="${esc(value || '')}" placeholder="${esc(placeholder || '')}">
      ${hint ? `<small>${hint}</small>` : ''}
    </label>`;
}

function areaField(label, field, value, placeholder, hint) {
  return `
    <label class="task-field span-2">
      <span>${label}</span>
      <textarea data-field="${field}" rows="3" placeholder="${esc(placeholder || '')}">${esc(value || '')}</textarea>
      ${hint ? `<small>${hint}</small>` : ''}
    </label>`;
}

function selectField(label, field, value, options) {
  return `
    <label class="task-field">
      <span>${label}</span>
      <select data-field="${field}">
        ${options
          .map(([key, text]) => `<option value="${key}" ${value === key ? 'selected' : ''}>${text}</option>`)
          .join('')}
      </select>
    </label>`;
}

function taskBody(key, task) {
  switch (key) {
    case 'keepalive':
      return `
        ${numberField('探测间隔（分钟）', 'intervalMin', task.intervalMin ?? 5, 1, 120)}
        ${numberField('连续失败阈值', 'failThreshold', task.failThreshold ?? 2, 1, 10)}
        <label class="task-field switch-field">
          <span>自动重启 NapCat</span>
          <span class="inline-switch">
            <label class="switch mini">
              <input type="checkbox" data-field="autoRestart" ${task.autoRestart ? 'checked' : ''}>
              <i></i>
            </label>
          </span>
          <small>连续探测失败后自动重启账号进程</small>
        </label>`;
    case 'dailyLike':
      return `
        ${timeField('执行时间', 'time', task.time)}
        ${selectField('点赞来源', 'source', task.source, [['group', '群成员'], ['friend', '好友列表']])}
        ${textField('群号', 'groupId', task.groupId, '来源为「群成员」时必填')}
        ${numberField('点赞人数', 'count', task.count ?? 10, 1, 20)}
        ${numberField('间隔（秒）', 'intervalSec', task.intervalSec ?? 3, 1, 10)}
        <div class="task-field span-2">
          <button type="button" class="link-btn" data-load-groups="dailyLike">读取群列表</button>
          <div class="group-chips hidden"></div>
        </div>`;
    case 'groupSign':
      return `
        ${timeField('执行时间', 'time', task.time)}
        ${textField('群号列表', 'groups', task.groups, '多个群号用逗号分隔')}
        <div class="task-field">
          <span>群列表</span>
          <button type="button" class="link-btn" data-load-groups="groupSign">读取群列表</button>
          <div class="group-chips hidden"></div>
        </div>
        <label class="task-field switch-field">
          <span>签到后发送文字</span>
          <span class="inline-switch">
            <label class="switch mini">
              <input type="checkbox" data-field="sendText" ${task.sendText ? 'checked' : ''}>
              <i></i>
            </label>
          </span>
          <small>关闭时只调用官方群签到接口，不在群里发消息</small>
        </label>
        ${textField('签到文字', 'text', task.text ?? '签到', '开启上一项后发送到群里')}`;
    case 'qzonePost':
      return `
        ${timeField('执行时间', 'time', task.time)}
        ${selectField('可见范围', 'ugcRight', String(task.ugcRight ?? 1), [
          ['1', '所有人可见'],
          ['4', '好友可见'],
          ['64', '仅自己可见'],
        ])}
        ${textField('配图地址', 'images', task.images, '可留空，多个地址用逗号分隔', '支持 http(s)://、base64://、file://')}
        <label class="task-field switch-field">
          <span>发布后自动删除</span>
          <span class="inline-switch">
            <label class="switch mini">
              <input type="checkbox" data-field="autoDelete" ${task.autoDelete !== false ? 'checked' : ''}>
              <i></i>
            </label>
          </span>
          <small>按 tid 删除，避免空间里留下任务痕迹</small>
        </label>
        ${numberField('删除延迟（秒）', 'deleteAfter', task.deleteAfter ?? 60, 0, 86400, '0 为立即删除；建议 60 秒以上，避免影响加速统计')}
        ${areaField('说说内容库', 'contents', task.contents, '每行一条，每天随机选一条', '建议写几条自然、不重复的短句')}`;
    case 'broadcast':
      return `
        ${textField('发送时间点', 'times', task.times, '例如 12:00,20:00', '多个时间用逗号分隔')}
        ${selectField('发送对象', 'scope', task.scope, [['group', '群聊'], ['friend', '私聊']])}
        ${textField('目标 ID', 'targets', task.targets, '群号或 QQ 号，逗号分隔')}
        ${areaField('消息内容', 'text', task.text, '要发送的文字', '留空不会触发发送')}`;
    case 'randomActive':
      return `
        ${timeField('开始时间', 'start', task.start)}
        ${timeField('结束时间', 'end', task.end)}
        ${textField('群号列表', 'groups', task.groups, '多个群号用逗号分隔')}
        ${numberField('最小间隔（分钟）', 'gapMin', task.gapMin ?? 90, 10, 1440)}
        ${areaField('话术库', 'phrases', task.phrases, '每行一句，随机挑选', '建议使用自然、低打扰的短句')}
        <div class="task-field span-2">
          <button type="button" class="link-btn" data-load-groups="randomActive">读取群列表</button>
          <div class="group-chips hidden"></div>
        </div>`;
    case 'autoReply':
      return `
        ${textField('关键词', 'keywords', task.keywords, '多个关键词用逗号分隔')}
        ${numberField('冷却时间（秒）', 'cooldownSec', task.cooldownSec ?? 60, 3, 86400)}
        ${areaField('回复内容', 'reply', task.reply, '收到关键词时自动发送的内容')}`;
    default:
      return '';
  }
}

function renderTaskGrid() {
  const account = currentAccount();
  if (!account) return;
  const online = state.status ? state.status.online : account.stats && account.stats.online;
  const order = ['keepalive', 'dailyLike', 'groupSign', 'qzonePost', 'broadcast', 'randomActive', 'autoReply'];
  const cards = order
    .map((key) => {
      const task = account.tasks[key] || {};
      const meta = state.taskMeta[key] || { name: key, desc: '' };
      return `
        <article class="task-card ${task.enabled ? 'enabled' : ''}" data-task="${key}">
          <header class="task-head">
            <span class="task-icon ${key}">${ICONS[key] || ''}</span>
            <div class="task-info">
              <h4>${esc(meta.name)}</h4>
              <p>${esc(meta.desc)}</p>
            </div>
            <label class="switch" title="启用或关闭任务">
              <input type="checkbox" data-toggle="${key}" ${task.enabled ? 'checked' : ''}>
              <i></i>
            </label>
          </header>
          <div class="task-body">${taskBody(key, task)}</div>
          <footer class="task-foot">
            <span class="task-note">${esc(taskLastNote(key, task))}</span>
            <button type="button" class="ghost-btn small" data-run="${key}">立即执行</button>
          </footer>
        </article>`;
    })
    .join('');

  const hint = online
    ? ''
    : '<div class="offline-hint"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>账号当前未登录，任务配置会保存，登录成功后自动执行。</div>';
  $('#taskGrid').innerHTML = hint + cards;
  $('#taskGrid').classList.toggle('is-offline', !online);
}

/* ------------------------------- 任务操作 ------------------------------- */

async function saveTask(key, patch) {
  const account = currentAccount();
  if (!account) return;
  try {
    const data = await api(`/api/accounts/${account.id}/tasks`, {
      method: 'PATCH',
      body: JSON.stringify({ task: key, patch }),
    });
    account.tasks[key] = data.tasks[key];
    const card = document.querySelector(`.task-card[data-task="${key}"]`);
    if (card) {
      card.classList.add('saved');
      setTimeout(() => card.classList.remove('saved'), 900);
    }
  } catch (error) {
    toast(`保存失败：${error.message}`, 'error');
    throw error;
  }
}

async function runTask(key, button) {
  const account = currentAccount();
  if (!account) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '执行中…';
  try {
    const data = await api(`/api/accounts/${account.id}/run`, {
      method: 'POST',
      body: JSON.stringify({ task: key }),
      timeout: 120000,
    });
    const result = data.result || {};
    toast(result.message || '已执行', result.ok ? 'success' : 'warn');
    await pollLogs();
  } catch (error) {
    toast(`执行失败：${error.message}`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function loadGroups(key, button) {
  const account = currentAccount();
  if (!account) return;
  if (!account.stats.online && !(state.status && state.status.online)) {
    toast('账号未登录，无法读取群列表', 'warn');
    return;
  }
  const card = button.closest('.task-card');
  const box = card.querySelector('.group-chips');
  button.disabled = true;
  button.textContent = '读取中…';
  try {
    const data = await api(`/api/accounts/${account.id}/groups`, { timeout: 30000 });
    const groups = data.groups || [];
    box.classList.remove('hidden');
    if (!groups.length) {
      box.innerHTML = '<span class="group-empty">没有读取到群，账号可能还没有加入群聊</span>';
    } else {
      box.innerHTML =
        `<div class="group-chips-head">共 ${groups.length} 个群，点击群名填入群号</div>` +
        groups
          .map(
            (group) =>
              `<button type="button" class="group-chip" data-group-id="${esc(group.id)}" title="${esc(group.name)}（${esc(group.id)}）">${esc(
                group.name
              )}<i>${esc(group.id)}</i></button>`
          )
          .join('');
    }
  } catch (error) {
    toast(`读取群列表失败：${error.message}`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = '读取群列表';
  }
}

function fillGroupId(chip) {
  const card = chip.closest('.task-card');
  const id = chip.dataset.groupId;
  const key = card.dataset.task;
  const single = card.querySelector('[data-field="groupId"]');
  if (single) {
    single.value = id;
    single.dispatchEvent(new Event('change', { bubbles: true }));
    toast(`已填入群号 ${id}`, 'success', 1500);
    return;
  }
  const input = card.querySelector('[data-field="groups"]');
  if (!input) return;
  const values = input.value.split(/[\s,，;；]+/).filter(Boolean);
  if (!values.includes(id)) values.push(id);
  input.value = values.join(',');
  input.dispatchEvent(new Event('change', { bubbles: true }));
  toast(`已添加群号 ${id}`, 'success', 1500);
}

/* -------------------------------- 日志 -------------------------------- */

async function pollLogs() {
  const params = new URLSearchParams();
  if (state.lastLogId) params.set('after', state.lastLogId);
  if (state.logFilterAccount && state.currentId) params.set('accountId', state.currentId);
  try {
    const data = await api(`/api/logs?${params.toString()}`);
    const logs = data.logs || [];
    if (!logs.length) return;
    for (const log of logs) state.lastLogId = Math.max(state.lastLogId, log.id);
    appendLogs(logs);
  } catch (_e) {
    /* ignore */
  }
}

function appendLogs(logs) {
  const panel = $('#logPanel');
  const empty = panel.querySelector('.log-empty');
  if (empty) empty.remove();
  const atBottom = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 30;
  for (const log of logs) {
    const line = document.createElement('div');
    line.className = `log-line ${log.level}`;
    const levelText = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' }[log.level] || 'LOG';
    line.innerHTML =
      `<span class="log-time">${fmtClock(log.ts)}</span>` +
      `<span class="log-level">${levelText}</span>` +
      (log.account ? `<span class="log-account">${esc(log.account)}</span>` : '') +
      `<span class="log-msg">${esc(log.message)}</span>`;
    panel.appendChild(line);
  }
  while (panel.children.length > 500) panel.removeChild(panel.firstChild);
  if (atBottom) panel.scrollTop = panel.scrollHeight;
}

async function reloadLogs() {
  state.lastLogId = 0;
  const panel = $('#logPanel');
  panel.innerHTML = '';
  await pollLogs();
  if (!panel.children.length) panel.innerHTML = '<div class="log-empty">暂无日志</div>';
}

/* -------------------------------- 扫码 -------------------------------- */

function openLogin(accountId) {
  const account = state.accounts.find((item) => item.id === accountId);
  if (!account) return;
  closeAllMenus();
  $('#loginAlias').textContent = `${account.alias}${account.qq ? ` · QQ ${account.qq}` : ''}`;
  $('#webuiToken').textContent = account.webuiToken || '—';
  const port = account.webuiPort || 6099;
  $('#btnOpenWebui').href = `http://${location.hostname}:${port}/webui`;
  $('#containerLogs').classList.add('hidden');
  $('#containerLogs').textContent = '';
  setQrPlaceholder('正在连接 NapCat…', true);
  $('#qrStatus').textContent = '等待二维码';
  state.qr = { accountId, timer: null, current: '', done: false };
  openModal('loginModal');
  pollQr();
  state.qr.timer = setInterval(() => pollQr(), 3000);
}

function stopQrPolling() {
  if (state.qr.timer) clearInterval(state.qr.timer);
  state.qr.timer = null;
}

function setQrPlaceholder(text, loading) {
  $('#qrFrame').innerHTML = `<div class="qr-placeholder">${loading ? '<div class="spinner"></div>' : ''}<span>${esc(
    text
  )}</span></div>`;
}

async function pollQr() {
  if (!state.qr.accountId || state.qr.done) return;
  const accountId = state.qr.accountId;
  try {
    const data = await api(`/api/accounts/${accountId}/qr`, { timeout: 50000 });
    if (state.qr.accountId !== accountId || state.qr.done) return;
    if (data.isLogin) {
      state.qr.done = true;
      stopQrPolling();
      $('#qrStatus').textContent = '登录成功，正在同步账号信息…';
      setQrPlaceholder('登录成功', false);
      toast('QQ 登录成功', 'success');
      setTimeout(async () => {
        closeModal('loginModal');
        await loadBootstrap({ renderTasks: false });
        await refreshStatus({ force: true });
        renderTaskGrid();
        pollLogs();
      }, 1600);
      return;
    }
    if (!data.ready) {
      $('#qrStatus').textContent =
        data.phase === 'installing' || data.phase === 'missing'
          ? '正在安装 QQ 运行环境'
          : data.phase === 'error'
            ? '运行环境异常'
            : 'NapCat 正在启动';
      setQrPlaceholder(data.error || 'NapCat 启动中，请稍候…', true);
      return;
    }
    const phaseText = {
      qrcode_scanned: '已扫码，请在手机 QQ 上确认',
      initializing: '登录成功，正在启动 OneBot',
      reconnecting: '正在重新连接登录服务…',
    }[data.phase];
    if (phaseText) $('#qrStatus').textContent = phaseText;
    else if (data.qrcode) $('#qrStatus').textContent = '请使用手机 QQ 扫码';
    else $('#qrStatus').textContent = '正在生成二维码…';

    if (data.error) {
      setQrPlaceholder(data.error, false);
      return;
    }
    if (data.qrcode && data.qrcode !== state.qr.current) {
      state.qr.current = data.qrcode;
      renderQr(data.qrcode);
    }
  } catch (error) {
    $('#qrStatus').textContent = '读取登录状态失败';
    setQrPlaceholder(error.message, false);
  }
}

function renderQr(text) {
  try {
    // NapCat 的部分接口直接返回 base64 图片，另一些返回需要编码的二维码 URL。
    if (/^data:image\//i.test(text)) {
      $('#qrFrame').innerHTML = `<img src="${esc(text)}" alt="QQ 登录二维码">`;
      return;
    }
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    $('#qrFrame').innerHTML = qr.createSvgTag(5, 2);
  } catch (_e) {
    setQrPlaceholder('二维码内容解析失败，请打开完整 WebUI', false);
  }
}

async function refreshQr() {
  if (!state.qr.accountId) return;
  try {
    await api(`/api/accounts/${state.qr.accountId}/qr`, { method: 'POST', timeout: 50000 });
    state.qr.current = '';
    toast('正在刷新二维码', 'info', 1400);
    await pollQr();
  } catch (error) {
    toast(`刷新失败：${error.message}`, 'error');
  }
}

/* ------------------------------- 账号操作 ------------------------------- */

async function selectAccount(id) {
  if (state.currentId === id) return;
  state.currentId = id;
  state.status = null;
  storageSet('qqnas.current', id);
  state.renderedAccountId = '';
  renderSidebar();
  renderMain({ renderTasks: true });
  state.renderedAccountId = id;
  await refreshStatus({ force: true });
  if (state.logFilterAccount) await reloadLogs();
}

function askConfirm(title, text, okText = '确认') {
  $('#confirmTitle').textContent = title;
  $('#confirmText').innerHTML = text;
  $('#confirmOk').textContent = okText;
  openModal('confirmModal');
  return new Promise((resolve) => {
    state.confirmResolver = resolve;
  });
}

function resolveConfirm(value) {
  closeModal('confirmModal');
  const resolver = state.confirmResolver;
  state.confirmResolver = null;
  if (resolver) resolver(value);
}

async function accountAction(action, label) {
  const account = currentAccount();
  if (!account) return;
  try {
    await api(`/api/accounts/${account.id}/action`, {
      method: 'POST',
      body: JSON.stringify({ action }),
      timeout: 180000,
    });
    toast(`${label}成功`, 'success');
    await loadBootstrap({ renderTasks: false });
    await refreshStatus({ force: true });
    renderTaskGrid();
    pollLogs();
  } catch (error) {
    toast(`${label}失败：${error.message}`, 'error');
  }
}

async function recreateAccount() {
  const account = currentAccount();
  if (!account) return;
  const ok = await askConfirm(
    '重建运行环境',
    '将停止当前 NapCat，重新复制一份干净的 QQ/NapCat 运行文件，<b>QQ 登录数据会保留</b>。用于修复运行环境损坏。',
    '重建'
  );
  if (!ok) return;
  await accountAction('recreate', '重建运行环境');
}

async function deleteAccount(purge) {
  const account = currentAccount();
  if (!account) return;
  const first = await askConfirm(
    purge ? '删除并清空数据' : '删除账号',
    purge
      ? `将停止 <b>${esc(account.alias)}</b> 的 NapCat，并永久删除该账号的 QQ 登录数据与配置，<b>无法恢复</b>。`
      : `将停止并移除 <b>${esc(account.alias)}</b> 的账号记录，数据目录会保留，重新添加时无法直接复用。`,
    purge ? '继续' : '删除'
  );
  if (!first) return;
  if (purge) {
    const second = await askConfirm(
      '再次确认',
      '删除数据目录后，扫码登录状态、NapCat 配置、插件全部丢失，<b>无法恢复</b>。确定继续吗？',
      '永久删除'
    );
    if (!second) return;
  }
  try {
    await api(`/api/accounts/${account.id}${purge ? '?purge=1' : ''}`, { method: 'DELETE', timeout: 120000 });
    toast(purge ? '账号与数据已删除' : '账号已删除', 'success');
    state.currentId = '';
    state.status = null;
    state.renderedAccountId = '';
    await loadBootstrap({ renderTasks: true });
    await refreshStatus({ force: true });
  } catch (error) {
    toast(`删除失败：${error.message}`, 'error');
  }
}

async function openContainerLogs() {
  const account = currentAccount();
  if (!account) {
    toast('请先选择一个账号', 'warn');
    return;
  }
  $('#logsTitle').textContent = `${account.alias} · 运行日志`;
  $('#modalLogs').textContent = '加载中…';
  openModal('logsModal');
  try {
    const data = await api(`/api/accounts/${account.id}/logs`, { timeout: 20000 });
    $('#modalLogs').textContent = data.logs || '暂无日志';
  } catch (error) {
    $('#modalLogs').textContent = `读取失败：${error.message}`;
  }
}

/* -------------------------------- 创建 -------------------------------- */

function openAdd() {
  const runtimeStatus = (state.runtime && state.runtime.status) || state.engine;
  if (runtimeStatus === 'installing') {
    toast('QQ 运行环境正在安装，创建后会自动启动', 'info', 3200);
  } else if (runtimeStatus !== 'ready' && runtimeStatus !== 'mock') {
    toast('首次添加会自动安装 QQ 运行环境', 'info', 3200);
  }
  $('#addAlias').value = '';
  $('#createProgress').classList.add('hidden');
  $('#btnCreateAccount').disabled = false;
  $('#btnCreateAccount').textContent = '创建并登录';
  openModal('addModal');
  setTimeout(() => $('#addAlias').focus(), 60);
}

function napcatRuntimeReady() {
  const runtime = state.runtime || {};
  return runtime.ready === true || runtime.status === 'ready' || runtime.status === 'mock';
}

async function createAccount() {
  if (state.creating) return;
  state.creating = true;
  const alias = $('#addAlias').value.trim();
  const button = $('#btnCreateAccount');
  button.disabled = true;
  button.textContent = '创建中…';
  $('#createProgress').classList.remove('hidden');
  $('#createProgressTitle').textContent = '正在准备运行环境…';
  $('#createProgressText').textContent = '首次安装 QQ 运行环境可能需要几分钟，请不要关闭页面';

  const progressTimer = setInterval(async () => {
    try {
      const data = await api('/api/runtime');
      const rt = data.runtime || {};
      if (rt.progress) $('#createProgressText').textContent = rt.progress;
      else if (rt.message) $('#createProgressText').textContent = rt.message;
    } catch (_e) {
      /* ignore */
    }
  }, 2500);

  try {
    const data = await api('/api/accounts', {
      method: 'POST',
      body: JSON.stringify({ alias }),
      timeout: 180000,
    });
    closeModal('addModal');
    toast(napcatRuntimeReady() ? '账号已创建' : '账号已创建，正在安装运行环境', 'success', 4000);
    await loadBootstrap({ renderTasks: false });
    state.currentId = data.account.id;
    state.status = null;
    storageSet('qqnas.current', state.currentId);
    state.renderedAccountId = '';
    renderSidebar();
    renderMain({ renderTasks: true });
    state.renderedAccountId = state.currentId;
    await refreshStatus({ force: true });
    openLogin(data.account.id);
  } catch (error) {
    toast(`创建失败：${error.message}`, 'error', 5000);
    $('#createProgressTitle').textContent = '创建失败';
    $('#createProgressText').textContent = error.message;
    button.disabled = false;
    button.textContent = '重新尝试';
  } finally {
    clearInterval(progressTimer);
    state.creating = false;
  }
}

/* -------------------------------- 设置 -------------------------------- */

function fillSettings() {
  const settings = state.settings || {};
  const runtime = state.runtime || {};
  const health = state.health || {};
  $('#setLogLimit').value = settings.logLimit || 800;
  $('#setAutoRestart').checked = settings.autoRestart !== false;
  $('#setRuntime').textContent = runtimeStatusText(runtime.status || state.engine);
  $('#setNode').textContent = health.node || '—';
  $('#setDataDir').textContent = health.dataDir || '—';
  $('#setAuth').textContent = state.authRequired ? '已设置访问密码' : '未设置（仅建议内网使用）';
  $('#setRuntimePath').textContent = runtime.template
    ? `安装位置：${runtime.template}${runtime.installLog ? `；日志：${runtime.installLog}` : ''}`
    : '首次使用需安装 Linux QQ 与 NapCat，安装包与日志保存在数据目录。';
  if ($('#setVersion')) $('#setVersion').textContent = `v${health.version || '2.0.8'}`;
  // 用户管理仅主用户可见可用；普通用户打开设置也只读。
  const isAdmin = Boolean(state.user && state.user.admin);
  const box = $('#userManageBox');
  if (box) box.classList.toggle('hidden', !isAdmin);
  const saveBtn = $('#btnSaveSettings');
  if (saveBtn) saveBtn.classList.toggle('hidden', !isAdmin);
  if (isAdmin) loadUsers();
}

/* ------------------------------- 用户管理 ------------------------------- */

async function loadUsers() {
  const list = $('#userList');
  if (!list) return;
  try {
    const data = await api('/api/users');
    const users = data.users || [];
    if (!users.length) {
      list.innerHTML = '<small style="opacity:.6">还没有额外用户。为其他飞牛用户各建一个账号空间吧。</small>';
      return;
    }
    list.innerHTML = users
      .map(
        (u) => `<div class="runtime-setting-actions" style="align-items:center;margin:6px 0">
          <b style="flex:1;min-width:0">${esc(u.name)}</b>
          <small style="opacity:.7">${u.accounts} 个账号</small>
          <button class="ghost-btn small" data-reset="${esc(u.id)}" data-name="${esc(u.name)}">重置密码</button>
          <button class="ghost-btn small" data-del="${esc(u.id)}" data-name="${esc(u.name)}">删除</button>
        </div>`
      )
      .join('');
  } catch (error) {
    list.innerHTML = `<small style="opacity:.6">加载失败：${esc(error.message)}</small>`;
  }
}

async function addUser() {
  const name = $('#newUserName').value.trim();
  const password = $('#newUserPassword').value;
  if (!name || !password) {
    toast('请填写用户名和初始密码', 'warn');
    return;
  }
  try {
    await api('/api/users', { method: 'POST', body: JSON.stringify({ name, password }) });
    $('#newUserName').value = '';
    $('#newUserPassword').value = '';
    toast(`已创建用户「${name}」`, 'success');
    loadUsers();
  } catch (error) {
    toast(`创建失败：${error.message}`, 'error');
  }
}

/** 复用确认弹窗收集一个新密码（confirmText 支持 HTML）。 */
function askPassword(title) {
  $('#confirmTitle').textContent = title;
  $('#confirmText').innerHTML =
    '<input id="askPasswordInput" type="password" placeholder="新密码（至少 6 位）" style="width:100%;box-sizing:border-box">';
  $('#confirmOk').textContent = '确定';
  openModal('confirmModal');
  return new Promise((resolve) => {
    state.confirmResolver = (ok) => {
      const input = $('#askPasswordInput');
      resolve(ok && input ? input.value : '');
    };
  });
}

async function resetUserPassword(id, name) {
  const password = await askPassword(`重置「${name}」的密码`);
  if (!password) return;
  try {
    await api(`/api/users/${id}/password`, { method: 'POST', body: JSON.stringify({ password }) });
    toast(`已重置「${name}」的密码`, 'success');
  } catch (error) {
    toast(`重置失败：${error.message}`, 'error');
  }
}

async function deleteUser(id, name) {
  const ok = await askConfirm('删除用户', `确定删除用户「${esc(name)}」吗？其名下账号需先删除。`, '删除');
  if (!ok) return;
  try {
    await api(`/api/users/${id}`, { method: 'DELETE' });
    toast(`已删除用户「${name}」`, 'success');
    loadUsers();
  } catch (error) {
    toast(`删除失败：${error.message}`, 'error');
  }
}

async function checkUpdate() {
  const button = $('#btnCheckUpdate');
  const status = $('#updateStatus');
  const link = $('#btnOpenRelease');
  if (!button || !status) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '检测中…';
  status.className = '';
  status.textContent = '正在连接 GitHub…';
  try {
    const data = await api('/api/update/check', { timeout: 20000 });
    if (data.error) {
      status.className = 'error';
      status.textContent = `检测失败：${data.error}`;
      link.classList.add('hidden');
    } else if (data.hasUpdate) {
      status.className = 'warn';
      status.textContent = `发现新版本 v${data.latest}，当前 v${data.current}`;
      link.href = data.url || `https://github.com/${data.repo}/releases`;
      link.classList.remove('hidden');
    } else {
      status.className = 'ok';
      status.textContent = `已是最新版本 v${data.current}`;
      link.classList.add('hidden');
    }
  } catch (error) {
    status.className = 'error';
    status.textContent = `检测失败：${error.message}`;
    link.classList.add('hidden');
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function openSettings() {
  fillSettings();
  openModal('settingsModal');
}

async function saveSettings() {
  try {
    const data = await api('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        logLimit: Number($('#setLogLimit').value),
        autoRestart: $('#setAutoRestart').checked,
      }),
    });
    state.settings = data.settings;
    toast('设置已保存', 'success');
    closeModal('settingsModal');
  } catch (error) {
    toast(`保存失败：${error.message}`, 'error');
  }
}

/* -------------------------------- 事件 -------------------------------- */

function bindEvents() {
  $('#btnAdd').addEventListener('click', openAdd);
  $('#btnAddSide').addEventListener('click', openAdd);
  $('#btnEmptyAdd').addEventListener('click', openAdd);
  $('#btnSettings').addEventListener('click', openSettings);
  $('#btnSaveSettings').addEventListener('click', saveSettings);
  $('#btnCheckUpdate').addEventListener('click', checkUpdate);
  const versionText = $('#versionText');
  if (versionText) {
    versionText.title = '点击检测更新';
    versionText.addEventListener('click', () => {
      openSettings();
      checkUpdate();
    });
  }
  $('#btnCreateAccount').addEventListener('click', createAccount);
  $('#btnAuthLogin').addEventListener('click', submitAuth);
  $('#authPassword').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submitAuth();
  });
  if ($('#authUsername')) {
    $('#authUsername').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submitAuth();
    });
  }
  if ($('#btnAddUser')) $('#btnAddUser').addEventListener('click', addUser);
  if ($('#userList')) {
    $('#userList').addEventListener('click', (event) => {
      const btn = event.target.closest('button');
      if (!btn) return;
      if (btn.dataset.reset) resetUserPassword(btn.dataset.reset, btn.dataset.name || '');
      if (btn.dataset.del) deleteUser(btn.dataset.del, btn.dataset.name || '');
    });
  }

  $('#accountList').addEventListener('click', (event) => {
    const item = event.target.closest('.account-item');
    if (item) selectAccount(item.dataset.id);
  });

  $('#taskGrid').addEventListener('change', async (event) => {
    const target = event.target;
    const card = target.closest('.task-card');
    if (!card) return;
    const key = card.dataset.task;
    if (target.matches('[data-toggle]')) {
      card.classList.toggle('enabled', target.checked);
      try {
        await saveTask(key, { enabled: target.checked });
      } catch (_e) {
        target.checked = !target.checked;
        card.classList.toggle('enabled', target.checked);
      }
    } else if (target.matches('[data-field]')) {
      let value = target.type === 'checkbox' ? target.checked : target.value;
      if (target.type === 'number') value = Number(value);
      try {
        await saveTask(key, { [target.dataset.field]: value });
      } catch (_e) {
        /* 错误已提示 */
      }
    }
  });

  $('#taskGrid').addEventListener('click', (event) => {
    const runButton = event.target.closest('[data-run]');
    if (runButton) {
      runTask(runButton.dataset.run, runButton);
      return;
    }
    const groupButton = event.target.closest('[data-load-groups]');
    if (groupButton) {
      loadGroups(groupButton.dataset.loadGroups, groupButton);
      return;
    }
    const chip = event.target.closest('[data-group-id]');
    if (chip) fillGroupId(chip);
  });

  $('#btnLogin').addEventListener('click', () => openLogin(state.currentId));
  $('#btnRestart').addEventListener('click', () => accountAction('restart', '重启 NapCat'));
  $('#btnStop').addEventListener('click', () => {
    const account = currentAccount();
    if (!account) return;
    const running = state.status ? state.status.running : account.containerState === 'running';
    accountAction(running ? 'stop' : 'start', running ? '停止 NapCat' : '启动 NapCat');
  });

  const installButton = $('#btnInstallRuntime');
  if (installButton) installButton.addEventListener('click', installRuntime);
  const runtimeLogButton = $('#btnRuntimeLog');
  if (runtimeLogButton) runtimeLogButton.addEventListener('click', openRuntimeLog);
  const reinstallButton = $('#btnReinstallRuntime');
  if (reinstallButton) {
    reinstallButton.addEventListener('click', async () => {
      const ok = await askConfirm(
        '重新安装运行环境',
        '将重新下载并安装 Linux QQ 与 NapCat，<b>不会删除账号数据</b>。安装期间已登录账号会短暂离线。',
        '开始安装'
      );
      if (!ok) return;
      try {
        await api('/api/runtime/install?force=1', { method: 'POST', timeout: 20000 });
        toast('已开始重新安装运行环境', 'info', 4000);
        await loadRuntime();
      } catch (error) {
        toast(`启动安装失败：${error.message}`, 'error');
      }
    });
  }
  const showRuntimeLogButton = $('#btnShowRuntimeLog');
  if (showRuntimeLogButton) showRuntimeLogButton.addEventListener('click', openRuntimeLog);

  $('#btnMore').addEventListener('click', (event) => {
    event.stopPropagation();
    $('#moreMenu').classList.toggle('hidden');
  });
  document.addEventListener('click', closeAllMenus);

  $('#moreMenu').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-menu]');
    if (!button) return;
    const action = button.dataset.menu;
    const account = currentAccount();
    if (!account) return;
    closeAllMenus();
    if (action === 'webui') {
      const port = account.webuiPort || 6099;
      window.open(`http://${location.hostname}:${port}/webui`, '_blank', 'noopener');
    }
    if (action === 'token') {
      const ok = await copyText(account.webuiToken || '');
      toast(ok ? 'Token 已复制' : '复制失败，请手动选择', ok ? 'success' : 'warn');
    }
    if (action === 'logs') openContainerLogs();
    if (action === 'recreate') recreateAccount();
    if (action === 'delete') deleteAccount(false);
    if (action === 'purge') deleteAccount(true);
  });

  $('#btnRefreshQr').addEventListener('click', refreshQr);
  $('#btnCopyToken').addEventListener('click', async () => {
    const account = state.accounts.find((item) => item.id === state.qr.accountId);
    const ok = await copyText(account ? account.webuiToken || '' : '');
    toast(ok ? 'Token 已复制' : '复制失败', ok ? 'success' : 'warn');
  });
  $('#btnShowContainerLogs').addEventListener('click', async () => {
    const box = $('#containerLogs');
    if (!box.classList.contains('hidden')) {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    box.textContent = '加载中…';
    try {
      const data = await api(`/api/accounts/${state.qr.accountId}/logs`, { timeout: 20000 });
      box.textContent = data.logs || '暂无日志';
    } catch (error) {
      box.textContent = `读取失败：${error.message}`;
    }
  });

  $('#logOnlyThis').addEventListener('change', (event) => {
    state.logFilterAccount = event.target.checked;
    reloadLogs();
  });
  $('#btnClearLog').addEventListener('click', () => {
    $('#logPanel').innerHTML = '<div class="log-empty">暂无日志</div>';
  });

  $$('[data-close]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.close;
      closeModal(id);
      if (id === 'loginModal') stopQrPolling();
      if (id === 'confirmModal') resolveConfirm(false);
    });
  });

  $$('.modal-mask').forEach((mask) => {
    mask.addEventListener('click', (event) => {
      if (event.target !== mask) return;
      if (mask.id === 'authModal') return;
      mask.classList.add('hidden');
      if (mask.id === 'loginModal') stopQrPolling();
      if (mask.id === 'confirmModal') resolveConfirm(false);
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const visible = $$('.modal-mask').find((mask) => !mask.classList.contains('hidden'));
    if (visible && visible.id !== 'authModal') {
      visible.classList.add('hidden');
      if (visible.id === 'loginModal') stopQrPolling();
      if (visible.id === 'confirmModal') resolveConfirm(false);
    }
    closeAllMenus();
  });

  $('#confirmOk').addEventListener('click', () => resolveConfirm(true));
}

/* -------------------------------- 启动 -------------------------------- */

function startPolling() {
  state.timers.bootstrap = setInterval(async () => {
    try {
      await loadBootstrap({ renderTasks: false });
    } catch (_e) {
      /* 下一轮自动重试 */
    }
  }, 10000);

  state.timers.status = setInterval(() => {
    if (document.hidden) return;
    refreshStatus();
  }, 5000);

  state.timers.logs = setInterval(() => {
    if (document.hidden) return;
    pollLogs();
  }, 4000);

  state.timers.health = setInterval(loadHealth, 30000);

  state.timers.runtime = setInterval(() => {
    if (!document.hidden) loadRuntime();
  }, 5000);
}

async function init() {
  bindEvents();

  try {
    const session = await rawApi('/api/session', { timeout: 10000 });
    state.authRequired = Boolean(session.authRequired);
    if (session.authRequired && !session.authed) await showAuth();
  } catch (_e) {
    /* 会话接口异常时仍然继续尝试加载，下面会给出明确提示 */
  }

  try {
    await loadHealth();
  } catch (_e) {
    /* 运行时长不是关键数据 */
  }

  try {
    await loadBootstrap({ renderTasks: true });
  } catch (error) {
    setEngineChip('bad', '服务未响应', error.message);
    toast(`连接管理服务失败：${error.message}`, 'error', 8000);
  }

  await loadRuntime();

  try {
    await refreshStatus({ force: true });
  } catch (_e) {
    /* ignore */
  }
  try {
    renderTaskGrid();
    await pollLogs();
  } catch (_e) {
    /* ignore */
  }

  if (!state.accounts.length) $('#emptyState').classList.remove('hidden');
  startPolling();
}

document.addEventListener('DOMContentLoaded', () => {
  init().catch((error) => {
    console.error(error);
    toast(`初始化失败：${error.message}`, 'error', 6000);
  });
});
