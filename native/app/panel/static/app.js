/* QQ挂机仓 · 原生版管理面板前端（原生 JS，无依赖） */
'use strict';
// 应用基础路径前缀：飞牛统一网关下为 /app/qqfarm-native，本地开发为空。
const BASE = window.QQBASE || '';
const $ = (s) => document.querySelector(s);
let STATE = null;
let SETUP_MODE = false;
let REFRESH_TIMER = null;
let SETUP_TIMER = null;
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', credentials: 'same-origin', headers: { 'X-QQFarm': '1' } };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(BASE + path, init);
  let data;
  try { data = await res.json(); }
  catch (e) { data = { ok: false, error: `服务器返回异常 (HTTP ${res.status})` }; }
  if (res.status === 401 && !path.startsWith('/api/login') && !path.startsWith('/api/bootstrap')) {
    showAuth(false, '登录已过期，请重新输入管理密码');
  }
  if (!res.ok || data.ok === false) {
    const err = new Error(data.error || `请求失败 (HTTP ${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 250); }, 4500);
}
function showModal({ title, body, foot = '', wide = false, onMount = null }) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body;
  $('#modal-foot').innerHTML = foot;
  $('.modal').classList.toggle('wide', wide);
  $('#modal-root').classList.remove('hidden');
  if (onMount) onMount($('#modal-body'), $('#modal-foot'));
}
function closeModal() {
  if (SETUP_TIMER) { clearInterval(SETUP_TIMER); SETUP_TIMER = null; }
  $('#modal-root').classList.add('hidden');
  $('#modal-body').innerHTML = '';
  $('#modal-foot').innerHTML = '';
}
function confirmBox(title, message, { okText = '确认', danger = false, extra = '' } = {}) {
  return new Promise((resolve) => {
    const cls = danger ? 'btn danger' : 'btn primary';
    showModal({
      title, body: `<p class="small">${message}</p>${extra}`,
      foot: `<button class="btn ghost" data-mc="0">取消</button><button class="${cls}" data-mc="1">${esc(okText)}</button>`,
      onMount: (_b, foot) => {
        foot.querySelectorAll('[data-mc]').forEach((btn) => {
          btn.onclick = () => {
            const ok = btn.dataset.mc === '1';
            const purge = $('#confirm-purge') ? $('#confirm-purge').checked : false;
            closeModal();
            resolve(ok ? { ok: true, purge } : { ok: false });
          };
        });
      },
    });
  });
}
/* ---------------- 鉴权 ---------------- */
function showAuth(isSetup, notice = '') {
  SETUP_MODE = !!isSetup;
  $('#auth-screen').classList.remove('hidden');
  $('#main-screen').classList.add('hidden');
  $('#auth-title').textContent = isSetup ? '初始化管理面板' : '登录';
  $('#auth-desc').textContent = isSetup ? '首次使用，请设置一个管理密码（至少 8 位）' : '请输入管理密码';
  $('#auth-label').textContent = isSetup ? '设置管理密码' : '管理密码';
  $('#auth-submit').textContent = isSetup ? '设置并进入' : '登录';
  $('#auth-confirm-field').classList.toggle('hidden', !isSetup);
  $('#auth-password').value = '';
  $('#auth-confirm').value = '';
  $('#auth-notice').classList.toggle('hidden', !notice);
  $('#auth-notice').textContent = notice;
  stopRefresh();
}
function stopRefresh() {
  if (REFRESH_TIMER) { clearInterval(REFRESH_TIMER); REFRESH_TIMER = null; }
}
function startRefresh() {
  stopRefresh();
  REFRESH_TIMER = setInterval(() => {
    if ($('#auto-refresh').checked && document.visibilityState === 'visible') refresh(true);
  }, 12000);
}
async function boot() {
  let info;
  try { info = await api('/api/bootstrap'); }
  catch (e) {
    document.body.innerHTML = `<div style="padding:40px;color:#f87171">无法连接管理面板：${esc(e.message)}</div>`;
    return;
  }
  if (!info.configured) {
    showAuth(true, info.runtime_ready ? '' : '注意：图形栈尚未就绪，安装后请先在「设置」里查看自检结果。');
    return;
  }
  try {
    STATE = await api('/api/state');
    enterMain();
  } catch (e) {
    if (e.status === 401) showAuth(false);
    else toast(e.message, 'err');
  }
}
function enterMain() {
  $('#auth-screen').classList.add('hidden');
  $('#main-screen').classList.remove('hidden');
  render();
  startRefresh();
}
$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('#auth-password').value;
  const btn = $('#auth-submit');
  btn.disabled = true;
  try {
    if (SETUP_MODE) {
      if (pw !== $('#auth-confirm').value) throw new Error('两次输入的密码不一致');
      await api('/api/setup', { method: 'POST', body: { password: pw } });
    } else {
      await api('/api/login', { method: 'POST', body: { password: pw } });
    }
    STATE = await api('/api/state');
    enterMain();
  } catch (err) { toast(err.message, 'err'); }
  finally { btn.disabled = false; }
});
/* ---------------- 渲染 ---------------- */
function statusText(s) {
  return ({ running: '运行中', stopped: '已停止', partial: '进程异常' })[s] || s;
}
function accById(id) { return (STATE.accounts || []).find((a) => a.id === id); }
function render() {
  if (!STATE) return;
  const s = STATE.summary || { total: 0, running: 0, stopped: 0, missing: 0 };
  $('#stat-total').textContent = s.total;
  $('#stat-running').textContent = s.running;
  $('#stat-stopped').textContent = s.stopped;
  $('#stat-missing').textContent = s.missing;
  const r = STATE.runtime || {};
  const badge = $('#runtime-badge');
  badge.textContent = r.ready ? `图形栈就绪 · ${r.mode === 'bundled' ? '捆绑' : '系统'}` : '图形栈未就绪';
  badge.className = 'badge ' + (r.ready ? 'ok' : 'bad');
  const mem = Number(r.mem_available_mb);
  const memText = mem > 0 ? ` · 可用内存 ${mem} MB` : '';
  $('#header-sub').textContent = `面板 v${esc(STATE.panel_version || '')} · 无 Docker · 网页桌面${memText}`;
  const banner = $('#runtime-banner');
  if (!r.ready) {
    banner.classList.remove('hidden');
    const titleEl = $('#runtime-title');
    titleEl.textContent = r.setup_running ? '环境准备进行中…' : '首次使用：先补齐图形栈与官方 QQ 客户端';
    $('#runtime-desc').textContent = (r.setup_running
      ? '正在解包/下载运行时组件（本地有缓存时不会重新下载），点「立即准备」查看进度；准备完会自动把账号拉起来。'
      : '缺少：' + (r.missing || []).join('、') + '。点右侧按钮，在页面里一键完成，无需 SSH / root / Docker。');
    $('#btn-setup').textContent = r.setup_running ? '查看进度' : '立即准备';
  } else banner.classList.add('hidden');
  if (STATE.error) {
    $('#alert').classList.remove('hidden');
    $('#alert').textContent = STATE.error;
  } else $('#alert').classList.add('hidden');
  const list = STATE.accounts || [];
  $('#empty').classList.toggle('hidden', list.length > 0);
  $('#accounts').innerHTML = list.map(cardHtml).join('');
}
function procDots(procs) {
  const names = { xvfb: '虚拟屏', x11vnc: 'VNC', qq: 'QQ' };
  return Object.entries(names).map(([k, label]) => {
    const on = procs && procs[k];
    return `<span class="tiny ${on ? 'green' : 'muted'}">● ${label}</span>`;
  }).join('　');
}
function exitHtml(a) {
  const e = a.last_exit;
  if (!e) {
    return a.status === 'partial'
      ? '<div style="grid-column:1/-1"><span class="k red">部分进程已退出，点「重启」恢复，登录数据不会丢</span></div>'
      : '';
  }
  const tail = (e.log_tail || [])
    .map((l) => `<div class="tiny muted" style="font-family:ui-monospace,monospace;word-break:break-all">${esc(l)}</div>`)
    .join('');
  return `<div style="grid-column:1/-1"><span class="k red">${esc(e.hint)}</span>
    <span class="tiny muted">（该进程已退出 ${esc(e.uptime)}s，点「重启」可恢复，登录数据不会丢）</span>${tail}</div>`;
}
function cardHtml(a) {
  const initial = esc((a.name || 'Q').trim().charAt(0).toUpperCase());
  return `
  <article class="card">
    <div class="card-head">
      <div class="avatar">${initial}</div>
      <div class="card-title">
        <strong>${esc(a.name)}</strong>
        <span>${a.qq ? 'QQ ' + esc(a.qq) : '未填写 QQ 号'}</span>
      </div>
      <div class="status"><i class="dot ${esc(a.status)}"></i>${esc(statusText(a.status))}</div>
    </div>
    <div class="meta">
      <div><span class="k">虚拟屏幕</span><div class="v">DISPLAY :${esc(a.display)}</div></div>
      <div><span class="k">VNC 内部端口</span><div class="v">127.0.0.1:${esc(a.vnc_port)}</div></div>
      <div style="grid-column:1/-1"><span class="k">进程</span><div class="v">${procDots(a.procs)}</div></div>
      ${a.note ? `<div style="grid-column:1/-1"><span class="k">备注</span><div class="v">${esc(a.note)}</div></div>` : ''}
      ${a.status === 'partial' ? exitHtml(a) : ''}
    </div>
    <div class="card-actions">
      <button class="btn primary wide" data-act="open" data-id="${esc(a.id)}">打开网页桌面 · 扫码登录</button>
      <button class="btn" data-act="start" data-id="${esc(a.id)}">启动</button>
      <button class="btn" data-act="stop" data-id="${esc(a.id)}">停止</button>
      <button class="btn" data-act="restart" data-id="${esc(a.id)}">重启</button>
      <button class="btn" data-act="logs" data-id="${esc(a.id)}">日志</button>
      <button class="btn" data-act="edit" data-id="${esc(a.id)}">编辑</button>
      <button class="btn danger" data-act="delete" data-id="${esc(a.id)}">删除</button>
    </div>
  </article>`;
}
async function refresh(quiet = false) {
  try { STATE = await api('/api/state'); render(); }
  catch (e) { if (!quiet) toast(e.message, 'err'); }
}
/* ---------------- 卡片操作 ---------------- */
$('#accounts').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.dataset.id, act = btn.dataset.act;
  const a = accById(id);
  if (!a) return;
  if (act === 'open') { window.open(BASE + a.desktop_path, '_blank', 'noopener'); return; }
  if (act === 'logs') return showLogs(a);
  if (act === 'edit') return showAccountForm(a);
  if (act === 'delete') return deleteAccount(a);
  btn.disabled = true;
  try {
    const r = await api(`/api/accounts/${id}/${act}`, { method: 'POST', body: {} });
    toast(r.message || '操作完成', 'ok');
    await refresh();
  } catch (err) { toast(err.message, 'err'); btn.disabled = false; }
});
async function deleteAccount(a) {
  const r = await confirmBox('删除账号', `确定删除「${esc(a.name)}」吗？该账号的 QQ 进程会被停止。`, {
    okText: '删除', danger: true,
    extra: '<label class="check"><input type="checkbox" id="confirm-purge"> 同时删除该账号的登录数据（不可恢复）</label>',
  });
  if (!r.ok) return;
  try {
    const res = await api(`/api/accounts/${a.id}?purge=${r.purge ? 1 : 0}`, { method: 'DELETE' });
    toast(res.message || '已删除', 'ok');
    await refresh();
  } catch (e) { toast(e.message, 'err'); }
}
/* ---------------- 表单 ---------------- */
function showAccountForm(a = null) {
  const edit = !!a;
  const body = `
    <form id="acc-form">
      <div class="field-row">
        <label class="field"><span>账号名称 *</span>
          <input name="name" required maxlength="40" placeholder="例如：工作号" value="${esc(a ? a.name : '')}"></label>
        <label class="field"><span>QQ 号（仅备注用）</span>
          <input name="qq" maxlength="20" placeholder="选填" value="${esc(a ? a.qq : '')}"></label>
      </div>
      <label class="field"><span>备注</span>
        <textarea name="note" rows="2" maxlength="200" placeholder="选填">${esc(a ? a.note : '')}</textarea></label>
      <div class="section-title">高级（留空自动分配）</div>
      <div class="field-row">
        <label class="field"><span>DISPLAY 编号</span>
          <input name="display" type="number" min="100" max="9999" placeholder="自动" value="${esc(a ? a.display : '')}"><span class="hint">默认从 :101 开始递增</span></label>
        <label class="field"><span>VNC 内部端口</span>
          <input name="vnc_port" type="number" min="1024" max="65535" placeholder="自动" value="${esc(a ? a.vnc_port : '')}"><span class="hint">仅监听 127.0.0.1，不对外暴露</span></label>
      </div>
      <p class="muted tiny">${edit
        ? '修改 DISPLAY 或端口会自动重启该账号的进程组，登录数据保持不变。'
        : '创建后会立即启动 Xvfb + x11vnc + 官方 QQ，打开「网页桌面」用手机 QQ 扫码登录即可。'}</p>
    </form>`;
  showModal({
    title: edit ? `编辑 · ${a.name}` : '新增 QQ 账号', body,
    foot: `<button class="btn ghost" id="acc-cancel">取消</button><button class="btn primary" id="acc-save">${edit ? '保存' : '创建并启动'}</button>`,
    onMount: (_b, foot) => {
      foot.querySelector('#acc-cancel').onclick = closeModal;
      foot.querySelector('#acc-save').onclick = async () => {
        const form = $('#acc-form');
        if (!form.reportValidity()) return;
        const fd = new FormData(form);
        const payload = {};
        for (const [k, v] of fd.entries()) payload[k] = String(v).trim();
        if (!payload.display) delete payload.display;
        if (!payload.vnc_port) delete payload.vnc_port;
        const btn = foot.querySelector('#acc-save');
        btn.disabled = true; btn.textContent = '处理中…';
        try {
          const r = edit
            ? await api(`/api/accounts/${a.id}/update`, { method: 'POST', body: payload })
            : await api('/api/accounts', { method: 'POST', body: payload });
          closeModal();
          toast(r.message || '已保存', 'ok');
          await refresh();
        } catch (err) {
          toast(err.message, 'err');
          btn.disabled = false; btn.textContent = edit ? '保存' : '创建并启动';
        }
      };
    },
  });
}
/* ---------------- 日志 ---------------- */
async function showLogs(a) {
  showModal({
    title: `进程日志 · ${a.name}`, wide: true, body: '<pre class="logs">读取中…</pre>',
    foot: '<button class="btn ghost" id="logs-close">关闭</button><button class="btn primary" id="logs-refresh">重新读取</button>',
    onMount: (_b, foot) => {
      foot.querySelector('#logs-close').onclick = closeModal;
      foot.querySelector('#logs-refresh').onclick = load;
    },
  });
  async function load() {
    const pre = $('#modal-body .logs');
    if (!pre) return;
    pre.textContent = '读取中…';
    try {
      const r = await api(`/api/accounts/${a.id}/logs?tail=300`);
      if (pre.isConnected) pre.textContent = r.logs || '（暂无日志）';
    } catch (e) { if (pre.isConnected) pre.textContent = '读取失败：' + e.message; }
  }
  load();
}
/* ---------------- 设置 ---------------- */
function showSettings() {
  const s = STATE.settings || {};
  const r = STATE.runtime || {};
  const body = `
    <form id="settings-form">
      <div class="section-title">显示与守护</div>
      <label class="field"><span>虚拟桌面分辨率</span>
        <input name="resolution" maxlength="20" value="${esc(s.resolution)}" placeholder="1024x768"><span class="hint">省资源档 1024x768；若扫码界面显示不全可改回 1280x800。修改后需重启对应账号进程组生效</span></label>
      <label class="field"><span>虚拟桌面色深</span>
        <select name="depth">
          <option value="24" ${Number(s.depth) === 24 ? 'selected' : ''}>24 位 · 兼容（推荐）</option>
          <option value="16" ${Number(s.depth) === 16 ? 'selected' : ''}>16 位 · 更省内存（可能导致 QQ 起不来）</option>
        </select><span class="hint">Chromium/Electron 需要 24/32 位 TrueColor 显示，16 位下部分环境 QQ 会启动即退出（表现为「进程异常」）。若切到 16 位后出现该现象，请改回 24 位。</span></label>
      <label class="check"><input type="checkbox" name="autostart" ${s.autostart ? 'checked' : ''}> 面板启动时自动拉起上次运行中的账号</label>
      <label class="check"><input type="checkbox" name="watchdog" ${s.watchdog ? 'checked' : ''}> 进程意外退出时自动重启（看门狗）</label>
      <label class="field"><span>看门狗检查间隔（秒）</span>
        <input name="watchdog_interval" type="number" min="5" max="120" value="${esc(s.watchdog_interval)}"></label>
    </form>
    <div class="divider"></div>
    <div class="section-title">版本与更新</div>
    <div class="kv"><span>当前版本</span><span>v${esc(STATE.app_version || '-')}</span></div>
    <form id="update-form">
      <label class="field"><span>更新源地址</span>
        <input name="update_url" maxlength="300" value="${esc(s.update_url || '')}" placeholder="https://api.github.com/repos/qianliaa/qq-farm/releases/latest"><span class="hint">检测更新时访问的 GitHub Releases 接口地址；留空则禁用检测更新。改动后点「保存设置」再检测。</span></label>
    </form>
    <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn tiny" id="btn-update">检测更新</button>
      <a class="btn tiny ghost" href="https://github.com/qianliaa/qq-farm/releases" target="_blank" rel="noopener">发布页</a>
    </div>
    <div class="divider"></div>
    <div class="section-title">管理密码</div>
    <div class="field-row">
      <label class="field"><span>原密码</span><input id="pw-old" type="password" autocomplete="current-password"></label>
      <label class="field"><span>新密码（至少 8 位）</span><input id="pw-new" type="password" autocomplete="new-password"></label>
    </div>
    <button class="btn tiny" id="pw-change">修改管理密码</button>
    <div class="divider"></div>
    <div class="section-title">运行环境</div>
    <div class="kv"><span>模式</span><span>${r.mode === 'bundled' ? '捆绑运行时（免 root）' : '系统命令（精简包）'}</span></div>
    <div class="kv"><span>图形栈状态</span><span>${r.ready ? '就绪' : '未就绪：' + esc((r.missing || []).join('、'))}</span></div>
    <div class="kv"><span>可用内存</span><span>${Number(r.mem_available_mb) > 0 ? esc(r.mem_available_mb) + ' MB' : '读取不到'}</span></div>
    <div class="kv"><span>noVNC 页面</span><span>${r.novnc ? '已安装' : '缺失'}</span></div>
    <div class="kv"><span>运行时目录</span><span>${esc(r.runtime_dir || '-')}</span></div>
    <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn tiny" id="btn-export">导出账号配置</button>
      <button class="btn tiny" id="btn-setup2">环境准备</button>
      <button class="btn tiny" id="btn-recheck2">重新自检</button>
    </div>
    <p class="muted tiny" style="margin-top:12px">QQ 登录态保存在应用共享目录 accounts/&lt;ID&gt;/ 下，可在飞牛「文件管理 → 应用文件」里备份；卸载默认保留。</p>`;
  showModal({
    title: '设置', body, wide: true,
    foot: '<button class="btn ghost" id="set-cancel">关闭</button><button class="btn primary" id="set-save">保存设置</button>',
    onMount: (_b, foot) => {
      foot.querySelector('#set-cancel').onclick = closeModal;
      foot.querySelector('#set-save').onclick = async () => {
        const f = $('#settings-form');
        if (!f.reportValidity()) return;
        const fd = new FormData(f);
        const p = {
          resolution: fd.get('resolution'),
          depth: Number(fd.get('depth')),
          watchdog_interval: fd.get('watchdog_interval'),
          autostart: fd.get('autostart') === 'on',
          watchdog: fd.get('watchdog') === 'on',
          update_url: new FormData($('#update-form')).get('update_url') || '',
        };
        try {
          await api('/api/settings', { method: 'POST', body: p });
          toast('设置已保存', 'ok');
          closeModal(); await refresh();
        } catch (e) { toast(e.message, 'err'); }
      };
      $('#pw-change').onclick = async () => {
        try {
          await api('/api/password', { method: 'POST', body: { old: $('#pw-old').value, new: $('#pw-new').value } });
          toast('管理密码已更新', 'ok'); closeModal();
        } catch (e) { toast(e.message, 'err'); }
      };
      $('#btn-export').onclick = () => window.open(BASE + '/api/export', '_blank');
      $('#btn-setup2').onclick = showSetup;
      $('#btn-recheck2').onclick = recheck;
      $('#btn-update').onclick = () => checkUpdate($('#update-form [name=update_url]').value);
    },
  });
}
async function checkUpdate(source) {
  const btn = $('#btn-update');
  if (btn) { btn.disabled = true; btn.textContent = '检测中…'; }
  try {
    const r = await api('/api/update/check', { method: 'POST', body: { source } });
    showUpdateResult(r);
  } catch (e) { toast(e.message, 'err'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '检测更新'; } }
}
function showUpdateResult(r) {
  let body;
  if (r.error) {
    body = `<p class="red">${esc(r.error)}</p>
      <p class="muted tiny">当前版本 v${esc(r.current || '-')}。请确认 NAS 能访问更新源地址（GitHub），或在上方修改更新源后重试。</p>`;
  } else if (r.has_update) {
    body = `<p>发现新版本：<strong>v${esc(r.latest)}</strong>（当前 v${esc(r.current)}）</p>
      ${r.changelog ? `<div class="section-title">更新内容</div><pre class="tiny" style="white-space:pre-wrap;word-break:break-all;max-height:200px;overflow:auto;background:var(--bg,#111);padding:10px;border-radius:8px">${esc(r.changelog)}</pre>` : ''}
      ${r.download && r.download.url ? `<p><a class="btn primary tiny" href="${esc(r.download.url)}" target="_blank" rel="noopener">下载安装包 ${r.download.name || ''}</a></p>
      <p class="muted tiny">下载 .fpk 后，在飞牛应用中心手动安装（会保留账号数据），或先卸载旧版再安装。</p>` : ''}`;
  } else {
    body = `<p>已是最新版本（v${esc(r.current)}）${r.latest ? `，云端版本 v${esc(r.latest)}` : ''}。</p>`;
  }
  showModal({ title: '检测更新', body, foot: '<button class="btn ghost" id="upd-close">关闭</button>',
    onMount: (_b, foot) => { foot.querySelector('#upd-close').onclick = closeModal; } });
}
async function recheck() {
  try { await api('/api/runtime/check', { method: 'POST', body: {} }); toast('自检完成', 'ok'); await refresh(); }
  catch (e) { toast(e.message, 'err'); }
}
function pollSetup() {
  if (SETUP_TIMER) { clearInterval(SETUP_TIMER); SETUP_TIMER = null; }
  const tick = async () => {
    const pre = $('#setup-log');
    if (!pre || !pre.isConnected) {
      if (SETUP_TIMER) { clearInterval(SETUP_TIMER); SETUP_TIMER = null; }
      return;
    }
    try {
      const r = await api('/api/runtime/install/status');
      pre.textContent = (r.lines && r.lines.length) ? r.lines.join('\n') : '尚未开始。填好 QQ deb 来源后点「开始安装」。';
      pre.scrollTop = pre.scrollHeight;
      if (!r.running && SETUP_TIMER) {
        clearInterval(SETUP_TIMER); SETUP_TIMER = null;
        const btn = $('#setup-start');
        if (btn) { btn.disabled = false; btn.textContent = '开始安装'; }
        if (r.finished) {
          try { STATE = await api('/api/state'); render(); } catch (e) { /* ignore */ }
        }
      }
    } catch (e) { /* ignore */ }
  };
  tick();
  SETUP_TIMER = setInterval(tick, 1500);
}
function showSetup() {
  const r = STATE.runtime || {};
  const missing = r.missing || [];
  const body = `
    <p class="small">这一步只往应用自己的目录写文件：<strong>${esc(r.runtime_dir || '')}</strong>。
    不安装系统包、不需要 root、不依赖 Docker、不改动飞牛系统。</p>
    <div class="kv"><span>当前缺失</span><span>${esc(missing.join('、') || '无')}</span></div>
    <div class="kv"><span>应用共享目录</span><span>${esc(r.share_dir || '-')}</span></div>
    <form id="setup-form">
      <div class="section-title" style="margin-top:16px">官方 Linux QQ 安装包（二选一）</div>
      <label class="field"><span>方式 A · deb 下载直链</span>
        <input name="qq_url" placeholder="https://dldir1.qq.com/qqfile/qq/QQNT/Linux/QQ_x.x.x_amd64_01.deb">
        <span class="hint">去 im.qq.com/linuxqq 复制与 NAS 架构一致（amd64 / arm64）的 deb 链接</span></label>
      <label class="field"><span>方式 B · 共享目录里的文件名</span>
        <input name="qq_path" placeholder="QQ_3.2.15_241210_amd64_01.deb">
        <span class="hint">先用飞牛「文件管理」把 deb 上传到应用共享目录 qqfarm/，再填文件名（推荐，不受下载链接失效影响）</span></label>
      <label class="field"><span>noVNC 备用下载地址（可选）</span>
        <input name="novnc_url" placeholder="留空自动从 GitHub 下载 v1.6.0">
        <span class="hint">GitHub 打不开时，可填国内镜像的 noVNC tar.gz 地址</span></label>
    </form>
    <div class="section-title">安装进度</div>
    <pre class="logs" id="setup-log">准备就绪，点「开始安装」。</pre>
    <p class="muted tiny" style="margin-top:10px">Xvfb / VNC 服务及运行库会通过 apt-get download 只下载到应用目录再解包；若 NAS 的 apt 源不可用，页面会提示手动放置路径。</p>`;
  showModal({
    title: '环境准备 · 一键补齐', body, wide: true,
    foot: '<button class="btn ghost" id="setup-close">关闭</button><button class="btn" id="setup-recheck">重新自检</button><button class="btn primary" id="setup-start">开始安装</button>',
    onMount: (_b, foot) => {
      foot.querySelector('#setup-close').onclick = closeModal;
      foot.querySelector('#setup-recheck').onclick = recheck;
      foot.querySelector('#setup-start').onclick = async () => {
        const fd = new FormData($('#setup-form'));
        const payload = {};
        for (const [k, v] of fd.entries()) payload[k] = String(v).trim();
        if (!payload.qq_url && !payload.qq_path && !(r.bins && r.bins.qq)) {
          toast('请填 QQ deb 直链或共享目录文件名', 'err');
          return;
        }
        const btn = foot.querySelector('#setup-start');
        btn.disabled = true; btn.textContent = '安装中…';
        try {
          const res = await api('/api/runtime/install', { method: 'POST', body: payload });
          toast(res.message || '已开始', 'ok');
          pollSetup();
        } catch (e) {
          toast(e.message, 'err');
          btn.disabled = false; btn.textContent = '开始安装';
        }
      };
    },
  });
  pollSetup();
}
$('#btn-add').onclick = () => showAccountForm();
$('#btn-add-empty').onclick = () => showAccountForm();
$('#btn-refresh').onclick = () => refresh();
$('#btn-setup').onclick = () => showSetup();
$('#btn-settings').onclick = () => showSettings();
$('#btn-logout').onclick = async () => {
  try { await api('/api/logout', { method: 'POST', body: {} }); } catch (e) { /* ignore */ }
  STATE = null; showAuth(false);
};
$('#modal-close').onclick = closeModal;
$('#modal-backdrop').onclick = closeModal;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
boot();
