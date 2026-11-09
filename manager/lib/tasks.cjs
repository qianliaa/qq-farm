'use strict';

const { OneBot } = require('../../shared/onebot.cjs');
const napcat = require('./napcat.cjs');

const TASK_KEYS = ['keepalive', 'dailyLike', 'groupSign', 'qzonePost', 'broadcast', 'randomActive', 'autoReply'];

/** 进程启动后的保活宽限期：NapCat 初始化与自动重登期间只观察、不计失败。 */
const STARTUP_GRACE_MS = 5 * 60 * 1000;
/** 保活连续自动重启仍未恢复在线的最大次数，超过后暂停自动重启，避免重启循环加剧风控。 */
const MAX_KEEPALIVE_RESTARTS = 3;
/** 扫码窗口：用户打开登录弹窗取码后的一段时间内，保活不重启进程，避免二维码被重启作废。 */
const QR_SESSION_PROTECT_MS = 5 * 60 * 1000;
/** 探测到“明确离线”后隔多久复核一次，避免瞬时报文把在线账号判成掉线。 */
const OFFLINE_RECHECK_DELAY_MS = 12 * 1000;
/** 接口短暂不可读时的复核间隔：比确认离线短，避免把恢复拖慢。 */
const UNREACHABLE_RECHECK_DELAY_MS = 5 * 1000;
/** 接口不可达至少连续这么多轮才考虑重启，且必须先做进程体检。 */
const UNREACHABLE_MIN_FAILS = 3;
/** 进程与端口都正常、只是接口读不到时，累计到这么多轮才允许重启。 */
const UNREACHABLE_RESTART_FAILS = 6;

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

/**
 * 多账号保活错峰：按账号 id 稳定散列出一个 0–45 秒的偏移，
 * 避免所有账号在同一轮 tick 里同时探测、同时判定失败、同时重启。
 */
function keepaliveJitterMs(accountId) {
  let hash = 0;
  for (let i = 0; i < String(accountId).length; i += 1) {
    hash = (hash * 31 + String(accountId).charCodeAt(i)) >>> 0;
  }
  return hash % 45000;
}

class TaskEngine {
  constructor({ store, logger, managerInternalUrl, notify = null }) {
    this.store = store;
    this.logger = logger;
    this.managerInternalUrl = managerInternalUrl;
    this.notify = notify;
    this.timer = null;
    this.locks = new Map();
    this.lastKeepalive = new Map();
    this.lastContainerSync = 0;
    this.lastGoodSnapshot = new Map();
    this.replyCooldowns = new Map();
    this.attempts = new Map();
    this.ticking = false;
    // 已发送掉线通知的账号：恢复在线时补发恢复通知；同一账号掉线通知 30 分钟内不重复。
    this.offlineNotified = new Map();
  }

  /** 触发用户通知（异步不阻塞保活）；kind: 'offline' | 'online'。 */
  fireNotify(account, kind) {
    if (typeof this.notify !== 'function') return;
    if (kind === 'offline') {
      const last = this.offlineNotified.get(account.id) || 0;
      if (Date.now() - last < 30 * 60 * 1000) return;
      this.offlineNotified.set(account.id, Date.now());
    }
    Promise.resolve()
      .then(() => this.notify(account, kind))
      .catch((err) => this.logger.warn(`通知发送失败：${err.message}`, this.meta(account)));
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
            if (!napcat.canAutoRestart(account)) {
              const guard = napcat.ensureRestartGuard(account);
              this.logger.info(
                guard.suspended ? '账号自动重启已暂停' : '账号自动重启退避中',
                this.meta(account)
              );
              continue;
            }
            const guard = napcat.noteRestartAttempt(account);
            this.store.save();
            this.logger.warn(`NapCat 未运行，尝试启动（第 ${guard.attempts} 次）`, this.meta(account));
            try {
              await napcat.startAccount(account);
            } catch (err) {
              const failed = napcat.noteRestartFailure(account);
              if (guard.attempts > MAX_KEEPALIVE_RESTARTS) failed.suspended = true;
              this.store.save();
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
    // lastKeepalive 存的是「下次允许探测的时间」，不是上次探测时间。
    const next = this.lastKeepalive.get(account.id);
    if (next === undefined) {
      // 首次只登记错峰偏移，下一轮 tick（10 秒）再按时间触发。
      this.lastKeepalive.set(account.id, Date.now() + keepaliveJitterMs(account.id));
      return;
    }
    if (Date.now() < next) return;
    this.lastKeepalive.set(account.id, Date.now() + intervalMs);
    await this.withLock(account, 'keepalive', () => this.runKeepalive(account, task));
  }

  /**
   * 探测账号真实在线状态。
   *
   * 判定优先级（避免误判掉线）：
   * 1. OneBot get_status.online===true 且能取到 user_id：最强正向证据，直接判在线，
   *    不让 WebUI 滞后的 isLogin=false 覆盖它；
   * 2. WebUI isLogin=true：判在线；
   * 3. WebUI 明确返回 isLogin=false（字段存在）：才可能是真掉线；
   * 4. 接口不可达 / 字段缺失：一律算“未确认”，不能当掉线。
   *
   * 只读探测，绝不生成二维码或 RefreshQRcode，否则探测本身会打断快速登录。
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
      webui = await napcat.getWebuiLoginStateQuiet(account);
    } catch (_e) {
      webui = null;
    }

    if (onebotOnline) {
      return {
        online: true,
        info,
        source: 'onebot',
        webuiConfirmed: Boolean(webui && webui.isLogin),
        webuiOffline: Boolean(webui && webui.hasLoginFlag && webui.isLogin === false),
      };
    }

    if (webui && webui.isLogin) {
      const uin = webui.info && (webui.info.uin || webui.info.user_id);
      if (!info || !info.user_id) {
        info = { user_id: uin, nickname: webui.info && (webui.info.nickname || webui.info.nick) };
      }
      return { online: true, info, source: 'webui', webuiConfirmed: true, webuiOffline: false };
    }

    // 必须 WebUI 明确给出 isLogin=false；字段缺失（老版本/异常响应）不算离线。
    if (webui && webui.hasLoginFlag && webui.isLogin === false) {
      return {
        online: false,
        confirmed: true,
        source: 'webui',
        webuiConfirmed: false,
        webuiOffline: true,
        isOfflineFlag: Boolean(webui.isOffline),
        phase: webui.phase || '',
        loginError: webui.error || '',
      };
    }

    return {
      online: false,
      confirmed: false,
      error: onebotError,
      source: 'unreachable',
      webuiConfirmed: false,
      webuiOffline: Boolean(webui && webui.isLogin === false),
    };
  }

  async runKeepalive(account, task) {
    if (account.desiredState !== 'running') {
      return { ok: false, message: '账号已停止，跳过保活' };
    }
    const client = this.clientFor(account);
    let probe = await this.probeOnline(account, client);

    if (probe.online) {
      const wasOnline = account.stats.online;
      this.store.recordOnline(account, probe.info && probe.info.user_id, probe.info && probe.info.nickname);
      napcat.resetRestartGuard(account);
      account.containerState = 'running';
      // 常态在线不需要每次写诊断行，避免每 5 分钟刷一条日志。
      napcat.noteRecovery(account, {
        phase: 'keepalive',
        webuiIsLogin: probe.webuiConfirmed ? true : null,
        decision: probe.source === 'onebot' ? 'onebot-online' : 'webui-online',
        webuiOfflineHint: Boolean(probe.webuiOffline),
        error: '',
        silent: wasOnline,
      });
      if (probe.webuiOffline) {
        this.logger.info('OneBot 已确认在线，忽略 WebUI 的滞后 isLogin=false', this.meta(account));
      }
      // 只有 WebUI 权威确认 isLogin=true 时才允许刷新完整登录快照。
      const lastSnap = this.lastGoodSnapshot.get(account.id) || 0;
      if (probe.webuiConfirmed && Date.now() - lastSnap > 6 * 60 * 60 * 1000) {
        this.lastGoodSnapshot.set(account.id, Date.now());
        napcat
          .snapshotGoodLogin(account, { verified: true, uin: probe.info && probe.info.user_id })
          .catch((err) => this.logger.error(`生成登录快照失败：${err.message}`, this.meta(account)));
      }
      if (!wasOnline) {
        this.logger.info(`账号已在线：${probe.info && probe.info.nickname ? probe.info.nickname : account.qq || ''}`, this.meta(account));
        // 掉线通知后恢复在线：补一条恢复通知。
        if (this.offlineNotified && this.offlineNotified.has(account.id)) {
          this.offlineNotified.delete(account.id);
          this.fireNotify(account, 'online');
        }
      }
      return { ok: true, message: '在线' };
    }

    // 进程刚启动，NapCat 还在初始化或自动重登，宽限期内只观察不计失败。
    const startedAt = Number(account.startedAt) || 0;
    if (startedAt && Date.now() - startedAt < STARTUP_GRACE_MS) {
      napcat.noteRecovery(account, {
        phase: 'keepalive',
        webuiIsLogin: probe.source === 'webui' ? false : null,
        decision: 'startup-grace',
        error: '启动宽限期内',
      });
      return { ok: false, message: '启动宽限期内，暂不判定' };
    }

    // 所有「没探测到在线」的情况都复核一次：NapCat 重连/读盘瞬间会返回一次
    // isLogin=false，或 OneBot 与 WebUI 同时短暂不可读；单次采样就动作，
    // 会把仍在线的账号自己重启掉线。
    const recheckDelay = probe.confirmed ? OFFLINE_RECHECK_DELAY_MS : UNREACHABLE_RECHECK_DELAY_MS;
    this.logger.info(
      probe.confirmed
        ? `保活探测报告离线${probe.isOfflineFlag ? '（isOffline）' : ''}，${recheckDelay / 1000} 秒后复核`
        : `保活探测接口暂不可读，${recheckDelay / 1000} 秒后复核`,
      this.meta(account)
    );
    await sleep(recheckDelay);
    const again = await this.probeOnline(account, this.clientFor(account));
    if (again.online) {
      this.logger.info('复核后已在线，本轮不判定掉线', this.meta(account));
      probe = again;
    } else if (again.confirmed) {
      probe = again;
    } else {
      // 复核仍读不到状态：降级为未确认，不通知、不当成「确认掉线」处理。
      probe = { ...again, confirmed: false, error: again.error || new Error('复核时登录状态不可读') };
    }

    if (probe.online) {
      const wasOnline = account.stats.online;
      this.store.recordOnline(account, probe.info && probe.info.user_id, probe.info && probe.info.nickname);
      napcat.resetRestartGuard(account);
      account.containerState = 'running';
      napcat.noteRecovery(account, {
        phase: 'keepalive',
        webuiIsLogin: probe.webuiConfirmed ? true : null,
        decision: 'recheck-online',
        error: '',
        silent: wasOnline,
      });
      if (this.offlineNotified && this.offlineNotified.has(account.id)) {
        this.offlineNotified.delete(account.id);
        this.fireNotify(account, 'online');
      }
      return { ok: true, message: '复核后在线' };
    }

    const confirmed = Boolean(probe.confirmed);
    const reason = confirmed
      ? `QQ 当前不在线${probe.phase ? `（阶段 ${probe.phase}）` : ''}${probe.loginError ? `：${probe.loginError}` : ''}`
      : `OneBot 与 WebUI 均无响应${probe.error ? `：${probe.error.message}` : ''}`;
    const guard = napcat.ensureRestartGuard(account);
    // 两类失败分开计数：只有「确认离线」才触发快照恢复/重启；
    // 接口不可读说明探测链路本身有问题，急着重启只会制造一次真实掉线。
    if (confirmed) {
      guard.failures = Number(guard.failures || 0) + 1;
      guard.unreachable = 0;
      this.store.recordOffline(account);
      this.fireNotify(account, 'offline');
    } else {
      guard.unreachable = Number(guard.unreachable || 0) + 1;
    }
    guard.updatedAt = Date.now();
    const fails = confirmed ? guard.failures : guard.unreachable;
    const threshold = confirmed
      ? Math.max(1, Number(task.failThreshold) || 2)
      : Math.max(UNREACHABLE_MIN_FAILS, Number(task.failThreshold) || 2);
    napcat.noteRecovery(account, {
      phase: 'keepalive',
      webuiIsLogin: confirmed ? false : null,
      decision: confirmed ? 'offline-confirmed' : 'probe-unreachable',
      probeSource: probe.source,
      webuiPhase: probe.phase || '',
      loginError: probe.loginError || '',
      error: reason,
    });
    this.store.save();
    if (fails === 1) {
      this.logger.warn(`保活探测失败：${reason}`, this.meta(account));
    }
    if (fails < threshold || !task.autoRestart) {
      return { ok: false, message: reason };
    }
    if (!confirmed) {
      // 接口不可读时先体检：进程还活着、WebUI 端口也通，说明只是接口暂时
      // 无响应；进程已退出则交给后台巡检拉起，避免两条路径重复重启。
      const health = await napcat.statusAccount(account);
      if (!health.running) {
        this.logger.info('进程已退出，交给后台巡检拉起，避免重复重启', this.meta(account));
        return { ok: false, message: '进程未运行，等待自动拉起' };
      }
      if (health.webuiReady && guard.unreachable < UNREACHABLE_RESTART_FAILS) {
        this.logger.info('进程与 WebUI 端口正常，仅接口暂不可读，暂不重启', this.meta(account));
        return { ok: false, message: '接口暂时不可读，进程正常，暂不重启' };
      }
      this.logger.warn('接口长期不可读，准备重启 NapCat', this.meta(account));
    }
    guard.failures = 0;
    guard.unreachable = 0;
    guard.updatedAt = Date.now();
    this.store.recordOffline(account);

    // 未完成首次登录的账号没有会话可恢复，重启只会打断正在进行的扫码登录。
    if (!account.qq) {
      this.logger.warn('账号尚未完成首次登录，跳过自动重启，等待扫码', this.meta(account));
      this.store.save();
      return { ok: false, message: '账号未登录，等待扫码' };
    }
    // 用户正在弹窗里扫码重登：重启进程会作废刚生成的二维码、打断登录。
    if (account.qrSessionAt && Date.now() - Number(account.qrSessionAt) < QR_SESSION_PROTECT_MS) {
      this.logger.info('扫码登录进行中，暂停自动重启', this.meta(account));
      this.store.save();
      return { ok: false, message: '扫码登录进行中，暂停自动重启' };
    }
    if (!napcat.canAutoRestart(account)) {
      const wait = Number(guard.nextRetryAt || 0) - Date.now();
      this.logger.info(
        guard.suspended
          ? '账号已暂停自动重启，等待人工处理'
          : `自动重启退避中，约 ${Math.max(0, Math.ceil(wait / 1000))} 秒后再试`,
        this.meta(account)
      );
      this.store.save();
      return { ok: false, message: guard.suspended ? '自动重启已暂停' : '自动重启退避中' };
    }

    // 快速登录失效（票据损坏/被清理）时，用登录成功后的完整快照覆盖并重启。
    // 30 分钟内只尝试一次，避免死循环。
    // 只有“明确离线”才走快照覆盖：接口不可达时用旧快照覆盖当前数据，
    // 可能把仍然有效的票据换成过期票据，属于自己把账号搞掉线。
    const lastRestore = Number(account.loginRestoreAt) || 0;
    if (napcat.hasGoodLogin(account) && probe.confirmed && Date.now() - lastRestore > 30 * 60 * 1000) {
      const restoreGuard = napcat.noteRestartAttempt(account);
      if (restoreGuard.attempts > MAX_KEEPALIVE_RESTARTS) {
        restoreGuard.suspended = true;
        account.lastError = '连续尝试登录快照恢复仍未在线，可能需要重新扫码或账号被风控';
        this.store.save();
        this.logger.warn('登录快照恢复次数已达上限，已暂停自动重启', this.meta(account));
        return { ok: false, message: '登录快照恢复次数已达上限，已暂停自动重启' };
      }
      account.loginRestoreAt = Date.now();
      this.store.save();
      try {
        const restored = await napcat.restoreGoodLogin(account);
        if (!restored) throw new Error('没有可用的登录快照');
        const current = napcat.ensureRestartGuard(account);
        current.failures = 0;
        current.nextRetryAt = Date.now() + 45000;
        current.updatedAt = Date.now();
        this.store.save();
        this.lastKeepalive.set(account.id, Date.now() + 45000);
        this.logger.warn('快速登录失效，已用登录快照恢复，正在自动重新登录', this.meta(account));
        return { ok: false, message: '已用登录快照恢复，正在自动重新登录' };
      } catch (e) {
        napcat.noteRestartFailure(account);
        this.logger.error(`用登录快照恢复失败：${e.message}`, this.meta(account));
        this.store.save();
        return { ok: false, message: `登录快照恢复失败，退避后重试：${e.message}` };
      }
    }

    // 重启退避：连续多次重启仍不在线，说明会话无法自愈（多为风控或需重扫码），
    // 继续重启只会加剧风控，暂停自动重启并提示人工处理。
    const attempts = napcat.noteRestartAttempt(account);
    if (attempts.attempts > MAX_KEEPALIVE_RESTARTS) {
      attempts.suspended = true;
      account.lastError = '连续重启后仍未恢复在线，可能需要重新扫码或账号被风控';
      this.store.save();
      this.logger.warn('连续重启仍未恢复在线，已暂停自动重启，请检查账号状态', this.meta(account));
      return { ok: false, message: '连续重启未恢复，已暂停自动重启' };
    }
    this.store.save();
    this.logger.warn(`连续探测失败，正在重启 NapCat（第 ${attempts.attempts}/${MAX_KEEPALIVE_RESTARTS} 次）`, this.meta(account));
    try {
      await napcat.restartAccount(account);
      napcat.noteRecovery(account, {
        phase: 'restart',
        restoreAction: 'restart-napcat',
        restoreResult: 'success',
        webuiIsLogin: null,
        error: '',
      });
      this.lastKeepalive.set(account.id, Date.now() + 30000);
      return { ok: false, message: '探测失败，已重启 NapCat（登录态已快照保留）' };
    } catch (e) {
      const failed = napcat.noteRestartFailure(account);
      if (attempts.attempts > MAX_KEEPALIVE_RESTARTS) failed.suspended = true;
      this.store.save();
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
