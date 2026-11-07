'use strict';

const { OneBot } = require('../../shared/onebot.cjs');
const napcat = require('./napcat.cjs');

const TASK_KEYS = ['keepalive', 'dailyLike', 'groupSign', 'qzonePost', 'broadcast', 'randomActive', 'autoReply'];

/** 进程启动后的保活宽限期：NapCat 初始化与自动重登期间只观察、不计失败。 */
const STARTUP_GRACE_MS = 5 * 60 * 1000;
/** 保活连续自动重启仍未恢复在线的最大次数，超过后暂停自动重启，避免重启循环加剧风控。 */
const MAX_KEEPALIVE_RESTARTS = 3;

const TASK_META = {
  keepalive: { name: '在线保活', desc: '保持电脑 QQ 在线，对应「电脑 QQ 在线 / 连续登录」加速项' },
  dailyLike: { name: '名片点赞', desc: '每天给群成员或好友点赞，维持互动' },
  groupSign: { name: '群签到', desc: '调用 QQ 官方群签到接口，不是发普通消息' },
  qzonePost: { name: '空间说说', desc: '每天自动发一条 QQ 空间说说，对应「发布一条空间说说」加速项' },
  broadcast: { name: '定时喊话', desc: '按设定的时间点向群或好友发送消息' },
  randomActive: { name: '随机活跃', desc: '在活跃时段内随机发一句话，保持账号活跃' },
  autoReply: { name: '关键词自动回复', desc: '收到含关键词的消息时自动回复' },
};

function pad(n) {
  return String(n).padStart(2, '0');
}

function today(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function nowMinutes(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes();
}

function parseMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function parseIdList(value) {
  return String(value || '')
    .split(/[\s,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseMessageText(event) {
  const message = event.message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) {
    return message
      .map((segment) => (segment && segment.type === 'text' && segment.data ? segment.data.text || '' : ''))
      .join('');
  }
  return String(event.raw_message || '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class TaskEngine {
  constructor({ store, logger, managerInternalUrl }) {
    this.store = store;
    this.logger = logger;
    this.managerInternalUrl = managerInternalUrl;
    this.timer = null;
    this.locks = new Map();
    this.lastKeepalive = new Map();
    this.lastContainerSync = 0;
    this.keepaliveFails = new Map();
    this.restartAttempts = new Map();
    this.replyCooldowns = new Map();
    this.attempts = new Map();
    this.ticking = false;
  }

  clientFor(account) {
    return new OneBot({
      baseUrl: `http://127.0.0.1:${Number(account.onebotPort) || 3000}`,
      token: account.onebotToken,
      timeout: 12000,
    });
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.logger.error(`调度循环异常：${err.message}`));
    }, 10000);
    setTimeout(() => this.tick().catch(() => {}), 1500);
    this.logger.info('任务调度器已启动（10 秒轮询）');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      if (now - this.lastContainerSync > 30000) {
        this.lastContainerSync = now;
        for (const account of this.store.accounts) {
          if (account.containerId === 'mock') continue;
          const status = await napcat.statusAccount(account);
          if (status.running) continue;
          const autoRestart = this.store.settings.autoRestart !== false;
          if (account.desiredState === 'running' && autoRestart && napcat.isRuntimeReady()) {
            this.logger.warn('NapCat 未运行，尝试启动', this.meta(account));
            try {
              await napcat.startAccount(account);
            } catch (err) {
              this.logger.error(`自动启动 NapCat 失败：${err.message}`, this.meta(account));
            }
          }
        }
        this.store.save();
      }

      await Promise.allSettled(
        this.store.accounts.map(async (account) => {
          if (account.containerId === 'mock') return;
          const tasks = account.tasks || {};
          await this.maybeKeepalive(account, tasks.keepalive);
          if (!account.stats.online) return;
          await this.maybeDaily(account, 'dailyLike', tasks.dailyLike, () => this.runDailyLike(account, tasks.dailyLike));
          await this.maybeDaily(account, 'groupSign', tasks.groupSign, () => this.runGroupSign(account, tasks.groupSign));
          await this.maybeDaily(account, 'qzonePost', tasks.qzonePost, () => this.runQzonePost(account, tasks.qzonePost));
          await this.maybeDeleteQzone(account, tasks.qzonePost);
          await this.maybeBroadcast(account, tasks.broadcast);
          await this.maybeRandomActive(account, tasks.randomActive);
        })
      );
    } finally {
      this.ticking = false;
    }
  }

  meta(account) {
    return { accountId: account.id, account: account.alias };
  }

  async withLock(account, key, fn) {
    const lockKey = `${account.id}:${key}`;
    if (this.locks.has(lockKey)) {
      return { ok: false, message: '任务正在执行中，请稍候' };
    }
    this.locks.set(lockKey, Date.now());
    try {
      return await fn();
    } finally {
      this.locks.delete(lockKey);
    }
  }

  async maybeKeepalive(account, task) {
    if (!task || !task.enabled) return;
    const intervalMs = Math.max(1, Number(task.intervalMin) || 5) * 60 * 1000;
    const last = this.lastKeepalive.get(account.id) || 0;
    if (Date.now() - last < intervalMs) return;
    this.lastKeepalive.set(account.id, Date.now());
    await this.withLock(account, 'keepalive', () => this.runKeepalive(account, task));
  }

  /**
   * 探测账号真实在线状态。
   * OneBot get_status 的 online 可能是 true / false / null（null 表示查询不到），
   * 且 QQ 被踢下线后 NapCat 上报给 OneBot 的状态可能滞后，导致旧逻辑漏判。
   * 因此以 NapCat WebUI 的 CheckLoginStatus（isLogin）为权威依据：
   * WebUI 可达时以它为准，不可达时回退到 OneBot 的严格判定。
   */
  async probeOnline(account, client) {
    let onebotOnline = false;
    let onebotError = null;
    let info = null;
    try {
      const status = await client.getStatus();
      try {
        info = await client.getLoginInfo();
      } catch (_e) {
        info = null;
      }
      onebotOnline = Boolean(status && status.online === true && info && info.user_id);
    } catch (err) {
      onebotError = err;
    }

    let webui = null;
    try {
      webui = await napcat.getWebuiLoginState(account);
    } catch (_e) {
      webui = null;
    }

    if (webui) {
      if (!webui.isLogin) return { online: false, confirmed: true, source: 'webui' };
      if (!info || !info.user_id) {
        const uin = webui.info && (webui.info.uin || webui.info.user_id);
        info = { user_id: uin, nickname: webui.info && (webui.info.nickname || webui.info.nick) };
      }
      return { online: true, info, source: onebotOnline ? 'onebot' : 'webui' };
    }
    if (onebotOnline) return { online: true, info, source: 'onebot' };
    return { online: false, confirmed: false, error: onebotError, source: 'unreachable' };
  }

  async runKeepalive(account, task) {
    const client = this.clientFor(account);
    const probe = await this.probeOnline(account, client);

    if (probe.online) {
      const wasOnline = account.stats.online;
      this.store.recordOnline(account, probe.info && probe.info.user_id, probe.info && probe.info.nickname);
      this.keepaliveFails.set(account.id, 0);
      this.restartAttempts.set(account.id, 0);
      account.containerState = 'running';
      if (!wasOnline) {
        this.logger.info(`账号已在线：${probe.info && probe.info.nickname ? probe.info.nickname : account.qq || ''}`, this.meta(account));
      }
      return { ok: true, message: '在线' };
    }

    // 进程刚启动，NapCat 还在初始化或自动重登，宽限期内只观察不计失败。
    const startedAt = Number(account.startedAt) || 0;
    if (startedAt && Date.now() - startedAt < STARTUP_GRACE_MS) {
      return { ok: false, message: '启动宽限期内，暂不判定' };
    }

    const reason = probe.confirmed
      ? 'QQ 当前不在线'
      : `OneBot 与 WebUI 均无响应${probe.error ? `：${probe.error.message}` : ''}`;
    // 已确认离线时立刻标记，面板第一时间显示离线；接口异常则等达到阈值再标记。
    if (probe.confirmed) this.store.recordOffline(account);
    const fails = (this.keepaliveFails.get(account.id) || 0) + 1;
    this.keepaliveFails.set(account.id, fails);
    if (fails === 1) {
      this.logger.warn(`保活探测失败：${reason}`, this.meta(account));
    }
    if (fails < Math.max(1, Number(task.failThreshold) || 2) || !task.autoRestart) {
      return { ok: false, message: reason };
    }
    this.keepaliveFails.set(account.id, 0);
    this.store.recordOffline(account);

    // 未完成首次登录的账号没有会话可恢复，重启只会打断正在进行的扫码登录。
    if (!account.qq) {
      this.logger.warn('账号尚未完成首次登录，跳过自动重启，等待扫码', this.meta(account));
      return { ok: false, message: '账号未登录，等待扫码' };
    }
    // 重启退避：连续多次重启仍不在线，说明会话无法自愈（多为风控或需重扫码），
    // 继续重启只会加剧风控，暂停自动重启并提示人工处理。
    const attempts = (this.restartAttempts.get(account.id) || 0) + 1;
    this.restartAttempts.set(account.id, attempts);
    if (attempts > MAX_KEEPALIVE_RESTARTS) {
      account.lastError = '连续重启后仍未恢复在线，可能需要重新扫码或账号被风控';
      this.store.save();
      this.logger.warn('连续重启仍未恢复在线，已暂停自动重启，请检查账号状态', this.meta(account));
      return { ok: false, message: '连续重启未恢复，已暂停自动重启' };
    }
    this.logger.warn(`连续探测失败，正在重启 NapCat（第 ${attempts}/${MAX_KEEPALIVE_RESTARTS} 次）`, this.meta(account));
    try {
      await napcat.restartAccount(account);
      this.lastKeepalive.set(account.id, Date.now() + 30000);
      return { ok: false, message: '探测失败，已重启 NapCat' };
    } catch (e) {
      this.logger.error(`重启 NapCat 失败：${e.message}`, this.meta(account));
      return { ok: false, message: `探测失败，重启也失败：${e.message}` };
    }
  }

  async maybeDaily(account, key, task, runner) {
    if (!task || !task.enabled) return;
    const target = parseMinutes(task.time);
    if (target === null) return;
    if (nowMinutes() < target) return;
    if (task.lastRunDate === today()) return;
    const attemptKey = `${account.id}:${key}`;
    if (Date.now() - (this.attempts.get(attemptKey) || 0) < 5 * 60 * 1000) return;
    await this.withLock(account, key, async () => {
      this.attempts.set(attemptKey, Date.now());
      const result = await runner();
      if (result && result.ok) {
        task.lastRunDate = today();
        this.store.save();
      }
    });
  }

  async maybeBroadcast(account, task) {
    if (!task || !task.enabled) return;
    const slots = String(task.times || '')
      .split(/[\s,，;；]+/)
      .map((item) => item.trim())
      .filter((item) => parseMinutes(item) !== null);
    if (!slots.length) return;
    const day = today();
    task.lastRunSlots = task.lastRunSlots || {};
    for (const [key, value] of Object.entries(task.lastRunSlots)) {
      if (!key.startsWith(day)) delete task.lastRunSlots[key];
    }
    const current = nowMinutes();
    for (const slot of slots) {
      const target = parseMinutes(slot);
      if (current < target) continue;
      const slotKey = `${day}|${slot}`;
      if (task.lastRunSlots[slotKey]) continue;
      const attemptKey = `${account.id}:broadcast:${slotKey}`;
      if (Date.now() - (this.attempts.get(attemptKey) || 0) < 5 * 60 * 1000) continue;
      const result = await this.withLock(account, `broadcast:${slot}`, async () => {
        this.attempts.set(attemptKey, Date.now());
        return this.runBroadcast(account, task);
      });
      if (result && result.ok) {
        task.lastRunSlots[slotKey] = true;
        this.store.save();
      }
    }
  }

  async maybeRandomActive(account, task) {
    if (!task || !task.enabled) return;
    const start = parseMinutes(task.start);
    const end = parseMinutes(task.end);
    if (start === null || end === null) return;
    const current = nowMinutes();
    if (start <= end) {
      if (current < start || current > end) return;
    } else if (current < start && current > end) {
      return;
    }
    const gapMs = Math.max(10, Number(task.gapMin) || 90) * 60 * 1000;
    if (Date.now() - (Number(task.lastRun) || 0) < gapMs) return;
    const attemptKey = `${account.id}:randomActive`;
    if (Date.now() - (this.attempts.get(attemptKey) || 0) < 5 * 60 * 1000) return;
    await this.withLock(account, 'randomActive', async () => {
      this.attempts.set(attemptKey, Date.now());
      const result = await this.runRandomActive(account, task);
      if (result && result.ok) {
        task.lastRun = Date.now();
        this.store.save();
      }
    });
  }

  async resolveTargets(account, task, scope) {
    if (scope === 'friend') {
      if (task.targets) return parseIdList(task.targets);
      const friends = await this.clientFor(account).getFriendList();
      return (friends || []).map((friend) => friend.user_id);
    }
    return parseIdList(task.targets || task.groups || task.groupId);
  }

  async runDailyLike(account, task) {
    const client = this.clientFor(account);
    const count = Math.min(20, Math.max(1, Number(task.count) || 10));
    const interval = Math.min(10, Math.max(1, Number(task.intervalSec) || 3)) * 1000;
    let users = [];
    if (task.source === 'friend') {
      const friends = await client.getFriendList();
      users = (friends || []).map((friend) => ({ user_id: friend.user_id, nickname: friend.nickname || friend.remark }));
    } else {
      if (!task.groupId) {
        this.logger.warn('名片点赞未配置群号，已跳过', this.meta(account));
        return { ok: false, message: '未配置群号' };
      }
      const members = await client.getGroupMemberList(task.groupId);
      users = (members || []).map((member) => ({ user_id: member.user_id, nickname: member.card || member.nickname }));
    }
    users = users.filter((user) => String(user.user_id) !== String(account.qq)).slice(0, count);
    if (!users.length) {
      this.logger.warn('名片点赞没有可操作对象', this.meta(account));
      return { ok: true, message: '无对象' };
    }
    let ok = 0;
    for (const user of users) {
      try {
        await client.sendLike(user.user_id, 1);
        ok += 1;
      } catch (err) {
        this.logger.warn(`给 ${user.user_id} 点赞失败：${err.message}`, this.meta(account));
      }
      await sleep(interval);
    }
    this.logger.info(`名片点赞完成：成功 ${ok}/${users.length}`, this.meta(account));
    return { ok: ok > 0, message: `成功 ${ok}/${users.length}` };
  }

  async runGroupSign(account, task) {
    const groups = parseIdList(task.groups);
    if (!groups.length) {
      this.logger.warn('群签到未配置群号，已跳过', this.meta(account));
      return { ok: false, message: '未配置群号' };
    }
    const client = this.clientFor(account);
    const text = String(task.text || '').trim();
    const withText = task.sendText === true && Boolean(text);
    let signed = 0;
    let textSent = 0;
    let unsupported = 0;

    for (const groupId of groups) {
      try {
        await client.setGroupSign(groupId);
        signed += 1;
      } catch (err) {
        if (/404|not\s*found|unsupported|不支持/i.test(String(err.message))) unsupported += 1;
        this.logger.warn(`群 ${groupId} 签到失败：${err.message}`, this.meta(account));
      }
      if (withText) {
        try {
          await client.sendGroupMsg(groupId, text);
          textSent += 1;
        } catch (err) {
          this.logger.warn(`群 ${groupId} 签到文字发送失败：${err.message}`, this.meta(account));
        }
        await sleep(1200);
      }
      await sleep(800);
    }

    const message = withText
      ? `签到成功 ${signed}/${groups.length}，文字 ${textSent}/${groups.length}`
      : `签到成功 ${signed}/${groups.length}`;
    this.logger.info(`群签到完成：${message}`, this.meta(account));
    if (signed === 0 && unsupported > 0) {
      return { ok: false, message: '当前 NapCat 不支持群签到接口，请升级运行环境' };
    }
    return { ok: signed > 0, message };
  }

  async runQzonePost(account, task) {
    const contents = String(task.contents || task.text || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (!contents.length) {
      this.logger.warn('空间说说未配置内容，已跳过', this.meta(account));
      return { ok: false, message: '未配置说说内容' };
    }
    const content = contents[Math.floor(Math.random() * contents.length)];
    const images = parseIdList(task.images);
    const ugcRight = [1, 4, 16, 64, 128].includes(Number(task.ugcRight)) ? Number(task.ugcRight) : 1;
    try {
      const data = await this.clientFor(account).sendQzoneMsg(content, { images, ugcRight });
      const tid = data && data.tid ? String(data.tid) : '';
      const tidText = tid ? `，tid=${tid}` : '';
      this.logger.info(`空间说说已发布：${content.slice(0, 30)}${tidText}`, this.meta(account));

      // 默认发布后删除，避免空间里留下任务痕迹；deleteAfter 单位为秒。
      if (tid && task.autoDelete !== false) {
        const seconds = Number.isFinite(Number(task.deleteAfter))
          ? Math.min(86400, Math.max(0, Math.round(Number(task.deleteAfter))))
          : 60;
        task.pendingDeletes = Array.isArray(task.pendingDeletes) ? task.pendingDeletes : [];
        task.pendingDeletes.push({ tid, at: Date.now() + seconds * 1000, tries: 0 });
        if (task.pendingDeletes.length > 20) task.pendingDeletes.shift();
        this.store.save();
        this.logger.info(`已安排 ${seconds} 秒后删除该说说`, this.meta(account));
        return { ok: true, message: `已发布，${seconds} 秒后自动删除` };
      }
      if (tid && task.autoDelete === false) return { ok: true, message: '已发布，保留不删除' };
      return { ok: true, message: '已发布（未返回 tid，无法自动删除）' };
    } catch (err) {
      this.logger.warn(`空间说说发布失败：${err.message}`, this.meta(account));
      return { ok: false, message: err.message };
    }
  }

  /** 到期后删除自动发布的说说；失败最多重试 3 次，避免无限重试。 */
  async maybeDeleteQzone(account, task) {
    if (!task || !Array.isArray(task.pendingDeletes) || !task.pendingDeletes.length) return;
    const now = Date.now();
    const due = task.pendingDeletes.filter((item) => item && item.tid && now >= Number(item.at || 0));
    if (!due.length) return;
    await this.withLock(account, 'qzoneDelete', async () => {
      const client = this.clientFor(account);
      for (const pending of due) {
        try {
          await client.deleteQzoneMsg(pending.tid);
          task.pendingDeletes = (task.pendingDeletes || []).filter((item) => item !== pending);
          this.logger.info(`空间说说已删除（tid=${pending.tid}）`, this.meta(account));
        } catch (err) {
          pending.tries = (pending.tries || 0) + 1;
          if (pending.tries >= 3) {
            task.pendingDeletes = (task.pendingDeletes || []).filter((item) => item !== pending);
            this.logger.warn(`空间说说删除失败，已停止重试：${err.message}`, this.meta(account));
          } else {
            pending.at = Date.now() + 60 * 1000;
            this.logger.warn(`空间说说删除失败，1 分钟后重试：${err.message}`, this.meta(account));
          }
        }
      }
      this.store.save();
    });
  }

  async runBroadcast(account, task) {
    const targets = await this.resolveTargets(account, task, task.scope);
    const text = String(task.text || '').trim();
    if (!targets.length || !text) {
      this.logger.warn('定时喊话缺少目标或内容，已跳过', this.meta(account));
      return { ok: false, message: '缺少目标或内容' };
    }
    const client = this.clientFor(account);
    let ok = 0;
    for (const target of targets) {
      try {
        if (task.scope === 'friend') await client.sendPrivateMsg(target, text);
        else await client.sendGroupMsg(target, text);
        ok += 1;
      } catch (err) {
        this.logger.warn(`向 ${target} 发送消息失败：${err.message}`, this.meta(account));
      }
      await sleep(1200);
    }
    this.logger.info(`定时喊话完成：成功 ${ok}/${targets.length}`, this.meta(account));
    return { ok: ok > 0, message: `成功 ${ok}/${targets.length}` };
  }

  async runRandomActive(account, task) {
    const groups = parseIdList(task.groups);
    const phrases = String(task.phrases || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (!groups.length || !phrases.length) {
      this.logger.warn('随机活跃缺少群号或话术，已跳过', this.meta(account));
      return { ok: false, message: '缺少群号或话术' };
    }
    const groupId = groups[Math.floor(Math.random() * groups.length)];
    const text = phrases[Math.floor(Math.random() * phrases.length)];
    await this.clientFor(account).sendGroupMsg(groupId, text);
    this.logger.info(`随机活跃：已在群 ${groupId} 发送「${text}」`, this.meta(account));
    return { ok: true, message: '已发送' };
  }

  async handleEvent(account, event) {
    const task = account.tasks && account.tasks.autoReply;
    if (!task || !task.enabled) return;
    if (!event || event.post_type !== 'message') return;
    if (!['group', 'private'].includes(event.message_type)) return;
    const selfId = String(event.self_id || account.qq || '');
    if (String(event.user_id) === selfId) return;

    const text = parseMessageText(event).trim();
    if (!text) return;
    const keywords = parseIdList(task.keywords);
    if (!keywords.some((keyword) => text.includes(keyword))) return;

    const conversation = `${event.message_type}:${event.group_id || event.user_id}`;
    const cooldownMs = Math.max(3, Number(task.cooldownSec) || 60) * 1000;
    const cooldownKey = `${account.id}:${conversation}`;
    const last = this.replyCooldowns.get(cooldownKey) || 0;
    if (Date.now() - last < cooldownMs) return;
    this.replyCooldowns.set(cooldownKey, Date.now());

    const reply = String(task.reply || '').trim();
    if (!reply) return;
    try {
      const client = this.clientFor(account);
      if (event.message_type === 'group') await client.sendGroupMsg(event.group_id, reply);
      else await client.sendPrivateMsg(event.user_id, reply);
      this.logger.info(`自动回复已发送：${text.slice(0, 40)}`, this.meta(account));
    } catch (err) {
      this.logger.warn(`自动回复发送失败：${err.message}`, this.meta(account));
    }
  }

  async runManual(account, key) {
    const task = account.tasks && account.tasks[key];
    if (!task) throw new Error('任务不存在');
    const runners = {
      keepalive: () => this.runKeepalive(account, task),
      dailyLike: () => this.runDailyLike(account, task),
      groupSign: () => this.runGroupSign(account, task),
      qzonePost: () => this.runQzonePost(account, task),
      broadcast: () => this.runBroadcast(account, task),
      randomActive: () => this.runRandomActive(account, task),
      autoReply: () => ({ ok: true, message: '自动回复为事件触发，无需手动执行' }),
    };
    return this.withLock(account, key, runners[key]);
  }
}

module.exports = { TaskEngine, TASK_KEYS, TASK_META, parseIdList, parseMinutes };
