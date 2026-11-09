'use strict';

/**
 * 掉线原因判定。
 *
 * 目的：把「QQ 官方侧 / 账号会话问题」与「本软件 / 本地程序问题」明确分开，
 * 避免用户看到「离线」却不知道该重新扫码、该重启应用，还是该检查 NAS 网络。
 *
 * 判定依据按可信度排序：
 *   1. 进程是否存在（statusAccount）——进程不在一定是本地软件问题；
 *   2. 外网连通性（仅接口不可读时探测）——断网属于环境问题；
 *   3. NapCat 内核日志关键词——「请扫码 / Login Error」是官方要求重新授权的最强证据；
 *   4. WebUI 是否明确返回 isLogin=false——确认离线说明本机链路是通的，问题在会话/官方侧；
 *   5. 接口是否可读、端口是否通——读不到才是软件侧问题。
 *
 * 本模块只做纯逻辑与轻量网络探测，不依赖管理端其它模块，便于单独测试。
 */

const net = require('node:net');

const CATEGORIES = Object.freeze({
  official: { label: '官方问题', short: '官方', color: 'amber', hint: 'QQ 服务端 / 账号会话 / 风控' },
  software: { label: '软件问题', short: '软件', color: 'purple', hint: 'NapCat / 管理端 / 本地接口' },
  environment: { label: '环境问题', short: '环境', color: 'blue', hint: 'NAS 网络 / 系统资源' },
  unknown: { label: '原因待判定', short: '待判定', color: 'muted', hint: '证据不足，请查看账号日志' },
});

const CODES = Object.freeze({
  need_scan: {
    category: 'official',
    title: 'QQ 会话失效，需要重新扫码',
    detail: 'QQ 服务端已作废当前登录会话，NapCat 内核进入扫码登录阶段。本地登录票据文件还在，但已无法通过快速登录恢复，快照也替代不了人工授权。',
    advice: '打开面板「扫码登录」重新扫码；确认没有在手机或其他电脑同时登录同一账号。',
  },
  kicked: {
    category: 'official',
    title: '账号被他地登录挤下线',
    detail: '内核日志出现被踢 / 异地登录相关事件，属于 QQ 官方的会话互斥机制，不是本程序的错误。',
    advice: '重新扫码登录，并避免同一账号在多个设备同时在线。',
  },
  risk_control: {
    category: 'official',
    title: '疑似触发 QQ 风控或安全验证',
    detail: 'WebUI 登录阶段或内核日志包含风控 / 安全限制信息，服务端拒绝了本次登录。',
    advice: '暂停自动重启与高频任务，先在手机 QQ 确认账号状态，再手动扫码；必要时降低任务频率。',
  },
  session_expired: {
    category: 'official',
    title: '登录会话已失效',
    detail: 'WebUI 明确返回未登录，且 NapCat 进程与本机接口都正常，说明问题出在 QQ 会话本身，而非管理端。',
    advice: '先用面板「扫码登录」重新授权；连续多次失效时检查是否被风控或他地登录。',
  },
  server_flap: {
    category: 'official',
    title: 'QQ 服务端连接波动',
    detail: '内核报告账号离线并自动重建登录服务，本机进程与配置均未变化。',
    advice: '通常会自动恢复；若持续离线，重新扫码并观察 NAS 网络。',
  },
  process_exited: {
    category: 'software',
    title: 'NapCat / QQ 进程已退出',
    detail: '账号进程不在运行，属于本地程序问题；管理端的后台巡检会尝试重新拉起。',
    advice: '查看账号日志末尾的崩溃信息；若反复退出，检查运行环境是否完整、端口是否冲突。',
  },
  napcat_stuck: {
    category: 'software',
    title: 'NapCat 进程存活但 WebUI 端口不通',
    detail: '进程还在，WebUI 端口却没有监听，通常是 NapCat 卡死或初始化失败。',
    advice: '在面板点「重启」；若反复出现，查看账号日志中的 LongTask / 内存不足信息。',
  },
  interface_unreachable: {
    category: 'software',
    title: 'OneBot / WebUI 接口暂时读不到',
    detail: '进程与端口都正常，但 OneBot 与 WebUI 同时无响应，属于本地接口问题，不能据此判定 QQ 真的掉线。',
    advice: '先不做重启；等下一轮保活复核。持续出现时重启账号或检查 WebUI 登录凭据。',
  },
  network_unreachable: {
    category: 'environment',
    title: 'NAS 外网疑似不可达',
    detail: '本机对外连通性探测全部失败，且管理端读不到 NapCat 接口，掉线更可能是网络环境导致。',
    advice: '检查 NAS 网络、DNS 与上级路由；网络恢复后账号通常会自动重连。',
  },
  resource_pressure: {
    category: 'environment',
    title: '系统资源紧张',
    detail: '内核日志出现长时间任务卡顿或内存不足迹象，多账号同时挂机时容易相互拖累。',
    advice: '减少同时在线的账号数量、增加内存，或重启 NAS 释放 Swap。',
  },
  unknown: {
    category: 'unknown',
    title: '证据不足，暂无法归类',
    detail: '现有探测结果不足以判断是官方侧还是软件侧问题。',
    advice: '打开「查看运行日志」，把账号日志末尾与登录态诊断一起排查。',
  },
});

// 同时探测公共 DNS 与 QQ 官方 HTTPS：只封了出站 TCP 53 的 NAS 不该被误判成断网。
const NETWORK_TARGETS = Object.freeze([
  ['223.5.5.5', 53, 1500],
  ['119.29.29.29', 53, 1500],
  ['114.114.114.114', 53, 1500],
  ['www.qq.com', 443, 2500],
]);

function probeTcp(host, port, timeout = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.connect({ host, port });
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/** 外网连通性探测；返回 null 表示已通过环境变量关闭该检查。 */
async function probeNetworkReachable() {
  if (process.env.QQNAS_NETWORK_CHECK === '0') return null;
  const results = await Promise.all(
    NETWORK_TARGETS.map(([host, port, timeout]) => probeTcp(host, port, timeout))
  );
  return results.some(Boolean);
}

/** 从日志里摘出最近几条关键行，作为判定依据展示给用户。 */
function collectEvidence(text, patterns, limit = 3) {
  const lines = String(text || '').split(/\r?\n/).filter((line) => /[\u4e00-\u9fa5]|Login|Error|kick|LongTask|WebUI|OneBot/i.test(line));
  const hits = [];
  for (let index = lines.length - 1; index >= 0 && hits.length < limit; index -= 1) {
    const line = lines[index].replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trim();
    if (line && patterns.some((pattern) => pattern.test(line))) hits.unshift(line.slice(0, 160));
  }
  return hits;
}

const KERNEL = {
  needScan: /请扫描|Login Error|没有 -q 指令指定快速登录|二维码已保存/i,
  kicked: /被踢|挤下线|异地登录|其他设备登录|forced offline|kicked/i,
  risk: /风控|安全验证|限制登录|账号异常|risk control/i,
  network: /网络.{0,6}(断开|异常|不可达)|ECONNRESET|ETIMEDOUT|ENETUNREACH|network.*(error|fail)/i,
  serverFlap: /账号已离线，正在重启 Worker|账号状态变更为离线|重新创建 QQ 登录服务/i,
  resource: /LongTask\([^)]*\): duration=(\d+)ms|out of memory|内存不足|OOM/i,
  localError: /WebUI 返回非 JSON|WebUI 未授权|请求超时|ECONNREFUSED|WebUI 无响应/i,
};

function makeReason(code, evidence = [], extra = {}) {
  const def = CODES[code] || CODES.unknown;
  const category = CATEGORIES[def.category] || CATEGORIES.unknown;
  return {
    at: Date.now(),
    category: def.category,
    categoryLabel: category.label,
    categoryShort: category.short,
    color: category.color,
    scopeHint: category.hint,
    code,
    title: def.title,
    summary: `${category.label} · ${def.title}`,
    detail: def.detail,
    advice: def.advice,
    evidence,
    provisional: false,
    ...extra,
  };
}

/**
 * @param {object} input
 * @param {object} input.probe      probeOnline 的结果（confirmed / source / error / phase / loginError ...）
 * @param {object} input.health     napcat.statusAccount 的结果（running / webuiReady ...）
 * @param {string} input.kernelLog  账号日志尾部文本
 * @param {boolean|null} input.networkOk 外网连通性；null 表示未探测
 */
function classifyOffline(input = {}) {
  const probe = input.probe || {};
  const health = input.health || {};
  const kernel = String(input.kernelLog || '');
  const networkOk = input.networkOk === undefined ? null : input.networkOk;
  const evidence = [];
  const confirmed = Boolean(probe.confirmed);
  const flag = (text) => {
    if (text && evidence.indexOf(text) === -1) evidence.push(text);
  };

  if (confirmed) flag('NapCat WebUI 明确返回 isLogin=false（确认离线）');
  if (probe.source === 'onebot' || probe.onebotOnline) flag('OneBot 明确在线');
  if (probe.phase) flag(`内核登录阶段：${String(probe.phase).slice(0, 80)}`);
  if (probe.loginError) flag(`内核登录错误：${String(probe.loginError).slice(0, 100)}`);
  if (probe.error && probe.error.message) flag(`接口错误：${String(probe.error.message).slice(0, 100)}`);

  const scanHits = collectEvidence(kernel, [KERNEL.needScan]);
  const kickHits = collectEvidence(kernel, [KERNEL.kicked]);
  const riskHits = collectEvidence(kernel, [KERNEL.risk]);
  const netHits = collectEvidence(kernel, [KERNEL.network]);
  const flapHits = collectEvidence(kernel, [KERNEL.serverFlap]);
  const resourceHits = collectEvidence(kernel, [KERNEL.resource]);
  const localHits = collectEvidence(kernel, [KERNEL.localError]);

  // 0. 完全没有可用证据时不要硬猜一个分类。
  if (
    !confirmed && !probe.error && !probe.source && !kernel.trim() &&
    networkOk === null && health.running === undefined && health.webuiReady === undefined
  ) {
    return makeReason('unknown', ['探测结果为空，无法归类']);
  }

  // 1. 进程都没了，一定是本地软件侧问题。
  if (health.running === false) {
    flag('账号进程未运行（napcat.pid 不存在或进程已退出）');
    return makeReason('process_exited', evidence);
  }

  // 2. 接口读不到时，先排除 NAS 外网问题；WebUI 明确返回未登录时不适用
  //    （能返回明确状态说明本机到 NapCat 的链路是通的）。
  if (!confirmed && networkOk === false) {
    flag('外网连通性探测：4 个目标（含 QQ 官方 HTTPS）均不可达');
    netHits.forEach(flag);
    return makeReason('network_unreachable', evidence);
  }

  // 3. 内核要求扫码 / 登录报错，是官方侧最强证据。
  if (KERNEL.needScan.test(kernel)) {
    flag('内核日志出现「请扫描二维码 / Login Error」，服务端要求重新授权');
    scanHits.forEach(flag);
    return makeReason('need_scan', evidence);
  }
  if (KERNEL.kicked.test(kernel)) {
    kickHits.forEach(flag);
    return makeReason('kicked', evidence);
  }
  if (KERNEL.risk.test(kernel) || /风控|安全验证|限制登录/i.test(String(probe.loginError || '') + String(probe.phase || ''))) {
    riskHits.forEach(flag);
    return makeReason('risk_control', evidence);
  }

  // 4. WebUI 明确离线但内核没走到扫码：会话本身失效，仍属官方侧。
  if (confirmed) {
    flapHits.forEach(flag);
    return makeReason('session_expired', evidence);
  }

  // 5. 到这里说明只是「读不到」，属于软件侧，不能算 QQ 掉线。
  if (KERNEL.resource.test(kernel)) {
    resourceHits.forEach(flag);
    return makeReason('resource_pressure', evidence, { provisional: true });
  }
  if (health.webuiReady === false) {
    flag('WebUI 端口未监听（进程仍在）');
    localHits.forEach(flag);
    return makeReason('napcat_stuck', evidence, { provisional: true });
  }
  localHits.forEach(flag);
  return makeReason('interface_unreachable', evidence, { provisional: true, noRestart: true });
}

/** 一行文本，用于管理端日志与推送通知。 */
function describeReason(reason) {
  if (!reason) return '掉线原因待判定';
  const parts = [reason.summary];
  if (reason.evidence && reason.evidence.length) parts.push(`依据：${reason.evidence.slice(0, 3).join('；')}`);
  if (reason.advice) parts.push(`建议：${reason.advice}`);
  return parts.join('\n');
}

module.exports = {
  CATEGORIES,
  CODES,
  classifyOffline,
  describeReason,
  probeNetworkReachable,
};
