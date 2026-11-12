/* QQ 多开挂机 · 管理面板前端（原生 JS，无依赖） */
'use strict';

const $ = (s) => document.querySelector(s);
let STATE = null;
let SETUP_MODE = false;
let REFRESH_TIMER = null;
let MODAL_ON_MOUNT = null;

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function api(path, opts = {}) {
  const init = {
    method: opts.method || 'GET',
    credentials: 'same-origin',
    headers: { 'X-QQFarm': '1' },
  };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, init);
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
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 250); }, 4200);
}

/* ---------------- 弹窗 ---------------- */

function showModal({ title, body, foot = '', wide = false, onMount = null }) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body;
  $('#modal-foot').innerHTML = foot;
  $('.modal').classList.toggle('wide', wide);
  $('#modal-root').classList.remove('hidden');
  MODAL_ON_MOUNT = onMount;
  if (onMount) onMount($('#modal-body'), $('#modal-foot'));
}

function closeModal() {
  $('#modal-root').classList.add('hidden');
  $('#modal-body').innerHTML = '';
  $('#modal-foot').innerHTML = '';
  MODAL_ON_MOUNT = null;
}

function confirmBox(title, message, { okText = '确认', danger = false, extra = '' } = {}) {
  return new Promise((resolve) => {
    const cls = danger ? 'btn danger' : 'btn primary';
    showModal({
      title,
      body: `<p class="small">${message}</p>${extra}`,
      foot: `<button class="btn ghost" data-mc="0">取消</button><button class="${cls}" data-mc="1">${esc(okText)}</button>`,
      onMount: (_b, foot) => {
        foot.querySelectorAll('[data-mc]').forEach((btn) => {
          btn.onclick = () => {
            const val = btn.dataset.mc === '1';
            const purge = $('#confirm-purge') ? $('#confirm-purge').checked : false;
            closeModal();
            resolve(val ? { ok: true, purge } : { ok: false });
          };
        });
      },
    });
  });
}

/* ---------------- 鉴权界面 ---------------- */

function showAuth(isSetup, notice = '') {
  SETUP_MODE = !!isSetup;
  $('#auth-screen').classList.remove('hidden');
  $('#main-screen').classList.add('hidden');
  $('#auth-title').textContent = isSetup ? '初始化管理面板' : '登录';
  $('#auth-desc').textContent = isSetup
    ? '首次使用，请设置一个管理密码（至少 8 位）'
    : '请输入管理密码';
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
  }, 15000);
}

async function boot() {
  let info;
  try { info = await api('/api/bootstrap'); }
  catch (e) {
    document.body.innerHTML = `<div style="padding:40px;color:#f87171">无法连接管理面板：${esc(e.message)}</div>`;
    return;
  }
  if (!info.configured) {
    showAuth(true, info.docker_ok ? '' : `注意：Docker 连接异常（${info.docker_error}），安装后请检查 docker.sock 是否挂载。`);
    return;
  }
  const dockerTip = info.docker_ok ? '' : `Docker 连接异常：${info.docker_error}`;
  try {
    STATE = await api('/api/state');
    enterMain();
  } catch (e) {
    if (e.status === 401) showAuth(false, dockerTip);
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
  } catch (err) {
    toast(err.message, 'err');
  } finally { btn.disabled = false; }
});

/* ---------------- 主界面渲染 ---------------- */

function statusText(s) {
  return ({ running: '运行中', exited: '已停止', created: '已创建', paused: '已暂停',
    restarting: '重启中', dead: '异常', missing: '容器缺失' })[s] || s;
}

function accById(id) { return (STATE.accounts || []).find((a) => a.id === id); }

function desktopUrl(acc) {
  return `http://${location.hostname}:${acc.port}/`;
}

function render() {
  if (!STATE) return;
  const s = STATE.summary || { total: 0, running: 0, stopped: 0, missing: 0 };
  $('#stat-total').textContent = s.total;
  $('#stat-running').textContent = s.running;
  $('#stat-stopped').textContent = s.stopped;
  $('#stat-missing').textContent = s.missing;

  const d = STATE.docker || {};
  const badge = $('#docker-badge');
  badge.textContent = d.ok ? `Docker 正常 · ${esc(d.arch || '')}` : 'Docker 异常';
  badge.className = 'badge ' + (d.ok ? 'ok' : 'bad');
  $('#header-sub').textContent = `面板 v${esc(STATE.panel_version || '')} · 架构 ${esc(d.arch || '-')}`;

  const img = STATE.image || {};
  const banner = $('#image-banner');
  if (!d.ok || !img.present) {
    banner.classList.remove('hidden');
    $('#image-title').textContent = d.ok ? '首次使用需要拉取 QQ 客户端镜像' : 'Docker 服务不可用';
    $('#image-desc').textContent = d.ok
      ? `镜像 ${img.ref}（约 800MB，首次拉取需要几分钟）。也可在「设置」里换成国内加速地址。`
      : d.error;
    $('#btn-pull').disabled = !d.ok;
  } else {
    banner.classList.add('hidden');
  }
  if (!d.ok) {
    $('#alert').classList.remove('hidden');
    $('#alert').textContent = `Docker 连接失败：${d.error}。请在飞牛 Docker 设置中确认 /var/run/docker.sock 可用，然后重启本应用。`;
  } else $('#alert').classList.add('hidden');

  const st = STATE.settings || {};
  $('#port-hint').textContent = `网页桌面端口范围：${st.port_start} - ${st.port_end} · 每个账号占用 1 个端口`;

  const list = STATE.accounts || [];
  $('#empty').classList.toggle('hidden', list.length > 0);
  $('#accounts').innerHTML = list.map(cardHtml).join('');
}

function cardHtml(a) {
  const initial = esc((a.name || 'Q').trim().charAt(0).toUpperCase());
  const mem = a.mem_used_mb != null ? ` (实际 ${a.mem_used_mb} MB)` : '';
  const missing = !a.exists;
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
      <div><span class="k">网页桌面端口</span><div class="v">${esc(a.port)}</div></div>
      <div><span class="k">内存上限</span><div class="v">${esc(a.memory_mb)} MB${mem}</div></div>
      <div style="grid-column:1/-1">
        <span class="k">VNC 密码（打开网页桌面时需要）</span>
        <div class="v secret"><code id="pw-${esc(a.id)}">••••••••••••</code>
          <button class="btn tiny" data-act="reveal" data-id="${esc(a.id)}">显示</button>
          <button class="btn tiny" data-act="copy" data-id="${esc(a.id)}">复制</button>
        </div>
      </div>
      ${a.note ? `<div style="grid-column:1/-1"><span class="k">备注</span><div class="v">${esc(a.note)}</div></div>` : ''}
      ${missing ? `<div style="grid-column:1/-1"><span class="k red">容器丢失，登录数据仍在，点「重建」恢复</span></div>` : ''}
    </div>
    <div class="card-actions">
      <button class="btn primary wide" data-act="open" data-id="${esc(a.id)}">打开网页桌面 · 扫码登录</button>
      <button class="btn" data-act="start" data-id="${esc(a.id)}">启动</button>
      <button class="btn" data-act="stop" data-id="${esc(a.id)}">停止</button>
      <button class="btn" data-act="restart" data-id="${esc(a.id)}">重启</button>
      <button class="btn" data-act="logs" data-id="${esc(a.id)}">日志</button>
      <button class="btn" data-act="recreate" data-id="${esc(a.id)}">重建</button>
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
  const id = btn.dataset.id;
  const act = btn.dataset.act;
  const a = accById(id);
  if (!a) return;

  if (act === 'open') {
    window.open(desktopUrl(a), '_blank', 'noopener');
    return;
  }
  if (act === 'copy') {
    try { await navigator.clipboard.writeText(a.vnc_password); toast('VNC 密码已复制', 'ok'); }
    catch (_) { toast('复制失败，请点「显示」后手动复制', 'err'); }
    return;
  }
  if (act === 'reveal') {
    const el = $(`#pw-${id}`);
    const shown = el.dataset.shown === '1';
    el.textContent = shown ? '••••••••••••' : a.vnc_password;
    el.dataset.shown = shown ? '0' : '1';
    btn.textContent = shown ? '显示' : '隐藏';
    return;
  }
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
  const r = await confirmBox('删除账号', `确定删除「${esc(a.name)}」吗？容器会被移除。`,
    {
      okText: '删除', danger: true,
      extra: `<label class="check"><input type="checkbox" id="confirm-purge"> 同时删除该账号的登录数据卷（不可恢复）</label>`,
    });
  if (!r.ok) return;
  try {
    const res = await api(`/api/accounts/${a.id}?purge=${r.purge ? 1 : 0}`, { method: 'DELETE' });
    toast(res.message || '已删除', 'ok');
    await refresh();
  } catch (e) { toast(e.message, 'err'); }
}

/* ---------------- 新增 / 编辑账号 ---------------- */

function showAccountForm(a = null) {
  const edit = !!a;
  const st = STATE.settings || {};
  const body = `
    <form id="acc-form">
      <div class="field-row">
        <label class="field"><span>账号名称 *</span>
          <input name="name" required maxlength="40" placeholder="例如：工作号" value="${esc(a ? a.name : '')}"></label>
        <label class="field"><span>QQ 号（仅备注用）</span>
          <input name="qq" maxlength="20" placeholder="选填" value="${esc(a ? a.qq : '')}"></label>
      </div>
      <div class="field-row">
        <label class="field"><span>网页桌面端口</span>
          <input name="port" type="number" min="1" max="65535" placeholder="留空自动分配 (${esc(st.port_start)}-${esc(st.port_end)})" value="${esc(a ? a.port : '')}"><span class="hint">每个账号一个端口，不能与其他服务冲突</span></label>
        <label class="field"><span>VNC 密码</span>
          <input name="vnc_password" maxlength="64" placeholder="${edit ? '留空保持原密码' : '留空自动生成'}" value=""><span class="hint">打开网页桌面时输入；仅限字母、数字、_ 和 -</span></label>
      </div>
      <div class="field-row">
        <label class="field"><span>内存上限 (MB)</span>
          <input name="memory_mb" type="number" min="256" max="16384" value="${esc(a ? a.memory_mb : st.default_memory_mb || 1536)}"><span class="hint">官方 QQ 客户端建议不低于 1024 MB</span></label>
        <label class="field"><span>镜像（高级）</span>
          <input name="image" maxlength="200" placeholder="${esc(STATE.docker.auto_image || '留空使用默认镜像')}" value="${esc(a ? a.image : '')}"><span class="hint">留空使用全局默认镜像；可换国内加速地址</span></label>
      </div>
      <label class="field"><span>备注</span>
        <textarea name="note" rows="2" maxlength="200" placeholder="选填">${esc(a ? a.note : '')}</textarea></label>
      ${edit ? '<p class="muted tiny">保存后会自动重建容器，登录数据卷保持不变；若 QQ 版本要求重新登录，请重新扫码。</p>'
             : '<p class="muted tiny">创建后会立即启动容器。打开「网页桌面」用手机 QQ 扫码登录，之后即可关闭浏览器常驻在线。</p>'}
    </form>`;
  showModal({
    title: edit ? `编辑 · ${a.name}` : '新增 QQ 账号',
    body,
    foot: `<button class="btn ghost" id="acc-cancel">取消</button><button class="btn primary" id="acc-save">${edit ? '保存并重建' : '创建并启动'}</button>`,
    onMount: (_b, foot) => {
      foot.querySelector('#acc-cancel').onclick = closeModal;
      foot.querySelector('#acc-save').onclick = async () => {
        const form = $('#acc-form');
        if (!form.reportValidity()) return;
        const fd = new FormData(form);
        const payload = {};
        for (const [k, v] of fd.entries()) payload[k] = String(v).trim();
        if (!payload.port) delete payload.port;
        if (!payload.vnc_password) delete payload.vnc_password;
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
          btn.disabled = false; btn.textContent = edit ? '保存并重建' : '创建并启动';
        }
      };
    },
  });
}

/* ---------------- 日志 ---------------- */

async function showLogs(a) {
  showModal({ title: `容器日志 · ${a.name}`, wide: true, body: '<pre class="logs">读取中…</pre>',
    foot: '<button class="btn ghost" id="logs-close">关闭</button><button class="btn primary" id="logs-refresh">重新读取</button>',
    onMount: (_b, foot) => {
      foot.querySelector('#logs-close').onclick = closeModal;
      foot.querySelector('#logs-refresh').onclick = load;
    } });
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
  const d = STATE.docker || {};
  const body = `
    <form id="settings-form">
      <div class="section-title">实例默认值</div>
      <div class="field-row">
        <label class="field"><span>端口范围起始</span><input name="port_start" type="number" min="1" max="65535" value="${esc(s.port_start)}"></label>
        <label class="field"><span>端口范围结束</span><input name="port_end" type="number" min="1" max="65535" value="${esc(s.port_end)}"></label>
      </div>
      <label class="field"><span>默认 QQ 镜像</span>
        <input name="default_image" maxlength="200" placeholder="留空自动选择：${esc(d.auto_image || '')}" value="${esc(s.default_image)}">
        <span class="hint">当前架构 ${esc(d.arch || '-')}。拉不动 Docker Hub 时可填 ghcr.io/libzonda/linux-qq-release:latest-${esc(d.arch === 'arm64' || d.arch === 'aarch64' ? 'arm64' : 'amd64')} 或国内加速地址</span></label>
      <div class="field-row">
        <label class="field"><span>默认内存上限 (MB)</span><input name="default_memory_mb" type="number" min="256" max="16384" value="${esc(s.default_memory_mb)}"></label>
        <label class="field"><span>/dev/shm 大小 (MB)</span><input name="shm_mb" type="number" min="64" max="4096" value="${esc(s.shm_mb)}"><span class="hint">QQ 是 Electron 应用，太小会闪退</span></label>
      </div>
      <label class="field"><span>时区</span><input name="timezone" maxlength="64" value="${esc(s.timezone)}"></label>
      <label class="check"><input type="checkbox" name="auto_restart" ${s.auto_restart ? 'checked' : ''}> 容器异常退出后自动重启</label>
      <label class="check"><input type="checkbox" name="keep_app_running" ${s.keep_app_running ? 'checked' : ''}> QQ 客户端崩溃后自动拉起 (KEEP_APP_RUNNING)</label>
      <label class="check"><input type="checkbox" name="enable_taskbar" ${s.enable_taskbar ? 'checked' : ''}> 显示桌面任务栏 (ENABLE_TASKBAR)</label>
      <p class="muted tiny">修改设置后，已存在的账号需逐个点「重建」才会应用新参数。</p>
    </form>
    <div class="divider"></div>
    <div class="section-title">管理密码</div>
    <div class="field-row">
      <label class="field"><span>原密码</span><input id="pw-old" type="password" autocomplete="current-password"></label>
      <label class="field"><span>新密码（至少 8 位）</span><input id="pw-new" type="password" autocomplete="new-password"></label>
    </div>
    <button class="btn tiny" id="pw-change">修改管理密码</button>
    <div class="divider"></div>
    <div class="section-title">配置与数据</div>
    <div class="kv"><span>当前镜像</span><span>${esc((STATE.image || {}).ref || '-')} ${(STATE.image || {}).present ? '· 已就绪' : '· 未拉取'}</span></div>
    <div class="kv"><span>Docker 架构</span><span>${esc(d.arch || '-')}</span></div>
    <div class="kv"><span>数据卷命名</span><span>qqfarm-acc-&lt;ID&gt;-config</span></div>
    <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn tiny" id="btn-export">导出账号配置</button>
      <button class="btn tiny" id="btn-pull2">重新拉取镜像</button>
    </div>
    <p class="muted tiny" style="margin-top:12px">QQ 登录态保存在 Docker 命名卷里，卸载应用不会自动删除；如需彻底清除，请在删除账号时勾选「同时删除登录数据卷」。</p>`;
  showModal({
    title: '设置', body, wide: true,
    foot: '<button class="btn ghost" id="set-cancel">关闭</button><button class="btn primary" id="set-save">保存设置</button>',
    onMount: (_b, foot) => {
      foot.querySelector('#set-cancel').onclick = closeModal;
      foot.querySelector('#set-save').onclick = async () => {
        const f = $('#settings-form');
        if (!f.reportValidity()) return;
        const fd = new FormData(f);
        const p = {};
        for (const k of ['port_start','port_end','default_image','default_memory_mb','shm_mb','timezone']) p[k] = fd.get(k);
        for (const k of ['auto_restart','keep_app_running','enable_taskbar']) p[k] = fd.get(k) === 'on';
        try {
          await api('/api/settings', { method: 'POST', body: p });
          toast('设置已保存', 'ok');
          closeModal(); await refresh();
        } catch (e) { toast(e.message, 'err'); }
      };
      $('#pw-change').onclick = async () => {
        try {
          await api('/api/password', { method: 'POST',
            body: { old: $('#pw-old').value, new: $('#pw-new').value } });
          toast('管理密码已更新', 'ok'); closeModal();
        } catch (e) { toast(e.message, 'err'); }
      };
      $('#btn-export').onclick = () => window.open('/api/export', '_blank');
      $('#btn-pull2').onclick = () => pullImage();
    },
  });
}

async function pullImage() {
  const label = '拉取镜像';
  const buttons = [$('#btn-pull2'), $('#btn-pull')].filter(Boolean);
  buttons.forEach((b) => { b.disabled = true; b.textContent = '拉取中…'; });
  toast('开始拉取镜像，约 800MB，请耐心等待（期间请勿关闭页面）');
  try {
    const r = await api('/api/image/pull', { method: 'POST', body: {} });
    toast(r.message || '镜像拉取完成', 'ok');
    closeModal();
    await refresh();
  } catch (e) { toast(e.message, 'err'); }
  finally {
    [$('#btn-pull2'), $('#btn-pull')].filter(Boolean)
      .forEach((b) => { b.disabled = false; if (b.id === 'btn-pull') b.textContent = label; else b.textContent = '重新拉取镜像'; });
  }
}

/* ---------------- 顶部按钮 ---------------- */

$('#btn-add').onclick = () => showAccountForm();
$('#btn-add-empty').onclick = () => showAccountForm();
$('#btn-refresh').onclick = () => refresh();
$('#btn-pull').onclick = () => pullImage();
$('#btn-settings').onclick = () => showSettings();
$('#btn-logout').onclick = async () => {
  try { await api('/api/logout', { method: 'POST', body: {} }); } catch (e) { /* ignore */ }
  STATE = null;
  showAuth(false);
};
$('#modal-close').onclick = closeModal;
$('#modal-backdrop').onclick = closeModal;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

boot();
