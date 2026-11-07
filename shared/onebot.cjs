'use strict';

/**
 * 极简 OneBot 11 HTTP 客户端（零依赖）。
 * 管理端与独立脚本共用，避免两份实现漂移。
 */

const http = require('node:http');
const https = require('node:https');

class OneBotError extends Error {
  constructor(message, retcode, payload) {
    super(message);
    this.name = 'OneBotError';
    this.retcode = retcode;
    this.payload = payload;
  }
}

function normalizeBase(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

function postJson(baseUrl, action, params, token, timeout) {
  const url = new URL(normalizeBase(baseUrl) + '/' + action);
  const body = Buffer.from(JSON.stringify(params || {}), 'utf8');
  const client = url.protocol === 'https:' ? https : http;
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': body.length,
    'User-Agent': 'qq-nas-manager/1.0',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers,
        timeout: timeout || 15000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = text ? JSON.parse(text) : {};
          } catch (_e) {
            reject(new OneBotError(`返回内容不是 JSON：${text.slice(0, 200)}`, -1, text));
            return;
          }
          if (res.statusCode >= 400) {
            reject(new OneBotError(`HTTP ${res.statusCode}`, res.statusCode, json));
            return;
          }
          if (json.retcode !== undefined && json.retcode !== 0) {
            reject(new OneBotError(json.message || json.wording || `retcode=${json.retcode}`, json.retcode, json));
            return;
          }
          if (json.status === 'failed') {
            reject(new OneBotError(json.message || json.wording || 'OneBot 返回失败', json.retcode, json));
            return;
          }
          resolve(json.data);
        });
      }
    );
    req.on('timeout', () => req.destroy(new OneBotError('请求超时', -2)));
    req.on('error', (err) => reject(err instanceof OneBotError ? err : new OneBotError(err.message, -3)));
    req.write(body);
    req.end();
  });
}

class OneBot {
  constructor({ baseUrl, token = '', timeout = 15000 }) {
    this.baseUrl = normalizeBase(baseUrl);
    this.token = token;
    this.timeout = timeout;
  }

  call(action, params = {}) {
    return postJson(this.baseUrl, action, params, this.token, this.timeout);
  }

  getStatus() {
    return this.call('get_status');
  }

  getLoginInfo() {
    return this.call('get_login_info');
  }

  getVersionInfo() {
    return this.call('get_version_info');
  }

  getGroupList() {
    return this.call('get_group_list');
  }

  getFriendList() {
    return this.call('get_friend_list');
  }

  getGroupMemberList(groupId) {
    return this.call('get_group_member_list', { group_id: Number(groupId) });
  }

  sendGroupMsg(groupId, message) {
    return this.call('send_group_msg', { group_id: Number(groupId), message });
  }

  sendPrivateMsg(userId, message) {
    return this.call('send_private_msg', { user_id: Number(userId), message });
  }

  sendLike(userId, times = 1) {
    return this.call('send_like', { user_id: Number(userId), times: Number(times) || 1 });
  }

  /** QQ 官方群签到（NapCat native 接口），不是普通群消息。 */
  setGroupSign(groupId) {
    return this.call('set_group_sign', { group_id: String(groupId) });
  }

  /** 在 QQ 空间发表说说（NapCat 扩展接口），返回 { tid, time }。 */
  sendQzoneMsg(content, { images = [], ugcRight = 1, targetUins = [] } = {}) {
    return this.call('send_qzone_msg', {
      content: String(content),
      images: Array.isArray(images) ? images : [],
      ugc_right: Number(ugcRight) || 1,
      target_uins: Array.isArray(targetUins) ? targetUins : [],
    });
  }

  /** 按 tid 删除 QQ 空间说说（NapCat 扩展接口）。 */
  deleteQzoneMsg(tid) {
    return this.call('delete_qzone_msg', { tid: String(tid) });
  }
}

module.exports = { OneBot, OneBotError, postJson, normalizeBase };
