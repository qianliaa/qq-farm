'use strict';

/* 通知渠道：企业微信 / 钉钉 / 飞书 群机器人 Webhook，Server酱、Bark 推送。 */

const http = require('http');
const https = require('https');

const CHANNELS = {
  wecom: { name: '企业微信', hint: '群机器人 Webhook 地址' },
  dingtalk: { name: '钉钉', hint: '群机器人 Webhook 地址（安全设置用关键词，如：QQ）' },
  feishu: { name: '飞书', hint: '群机器人 Webhook 地址' },
  serverchan: { name: 'Server酱', hint: 'SendKey（sct.ftqq.com）' },
  bark: { name: 'Bark', hint: '推送地址或 Key（api.day.app）' },
};

function request(urlString, { method = 'POST', body = null, form = false, timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const transport = url.protocol === 'http:' ? http : https;
    const req = transport.request(
      {
        method,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + url.search,
        headers: body
          ? { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' }
          : {},
        timeout,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('通知请求超时')));
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

/** 发送通知。cfg: { type, target }；target 为 Webhook 完整地址或 Key。 */
async function send(cfg, title, text) {
  if (!cfg || !cfg.type || !cfg.target) throw new Error('通知未配置');
  const content = `${title}\n${text}`;
  let url = String(cfg.target).trim();

  switch (cfg.type) {
    case 'wecom':
      return request(url, { body: { msgtype: 'text', text: { content } } });
    case 'dingtalk':
      return request(url, { body: { msgtype: 'text', text: { content } } });
    case 'feishu':
      return request(url, { body: { msg_type: 'text', content: { text: content } } });
    case 'serverchan': {
      if (!/^https?:\/\//.test(url)) url = `https://sctapi.ftqq.com/${url}.send`;
      const body = `title=${encodeURIComponent(title)}&desp=${encodeURIComponent(text)}`;
      return request(url, { method: 'POST', body, form: true });
    }
    case 'bark': {
      if (!/^https?:\/\//.test(url)) url = `https://api.day.app/${url}`;
      url = `${url.replace(/\/+$/, '')}/${encodeURIComponent(title)}/${encodeURIComponent(text)}`;
      return request(url, { method: 'GET' });
    }
    default:
      throw new Error(`未知通知渠道：${cfg.type}`);
  }
}

module.exports = { CHANNELS, send };
