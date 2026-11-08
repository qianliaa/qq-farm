'use strict';

/**
 * 识别发起请求的飞牛用户。
 *
 * 应用由飞牛 Web UI 以内嵌页面打开，网关可能用三种方式把登录身份传下来：
 * 1. 身份请求头（网关注入 uid / username）；
 * 2. 网关下发的 JWT Cookie，payload 里带 uid、username；
 * 3. 明文 uid Cookie。
 * 三种都认不出来时返回 null，调用方按普通用户处理。
 */

const HEADER_PAIRS = [
  ['x-trim-uid', 'x-trim-username'],
  ['x-fnos-uid', 'x-fnos-username'],
  ['x-forwarded-uid', 'x-forwarded-user'],
  ['x-user-id', 'x-user-name'],
  ['x-auth-uid', 'x-auth-user'],
];

const UID_KEYS = ['uid', 'userId', 'user_id', 'userid', 'id', 'sub'];
const NAME_KEYS = ['username', 'userName', 'user_name', 'name', 'nickname', 'nickName', 'displayName', 'account'];

const JWT_COOKIES = ['fnos-token', 'fnos_token', 'trim-token', 'token', 'authorization'];
const UID_COOKIES = ['fnos_uid', 'trim_uid', 'uid'];

/** 飞牛超级管理员的 UID 固定为 1000。 */
const ADMIN_UID = '1000';

function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  const result = {};
  for (const item of header.split(';')) {
    const index = item.indexOf('=');
    if (index < 0) continue;
    const key = item.slice(0, index).trim();
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(item.slice(index + 1).trim());
    } catch (_e) {
      result[key] = item.slice(index + 1).trim();
    }
  }
  return result;
}

function decodeJwtPayload(token) {
  const raw = String(token || '').replace(/^Bearer\s+/i, '');
  const parts = raw.split('.');
  if (parts.length < 2) return null;
  try {
    const base = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = base.length % 4 ? '='.repeat(4 - (base.length % 4)) : '';
    return JSON.parse(Buffer.from(base + pad, 'base64').toString('utf8'));
  } catch (_e) {
    return null;
  }
}

function pick(source, keys) {
  if (!source || typeof source !== 'object') return '';
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== '') return String(value);
  }
  return '';
}

function fromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const uid = pick(payload, UID_KEYS);
  const name = pick(payload, NAME_KEYS);
  if (!uid && !name) return null;
  return { uid, name };
}

/** 解析请求里的飞牛身份，识别不到返回 null。 */
function detect(req) {
  for (const [uidHeader, nameHeader] of HEADER_PAIRS) {
    const uid = String(req.headers[uidHeader] || '').trim();
    const name = String(req.headers[nameHeader] || '').trim();
    if (uid || name) return normalize({ uid, name });
  }

  const cookies = parseCookies(req);
  for (const key of JWT_COOKIES) {
    const identity = fromPayload(decodeJwtPayload(cookies[key]));
    if (identity) return normalize(identity);
  }
  for (const key of UID_COOKIES) {
    if (cookies[key]) return normalize({ uid: cookies[key], name: '' });
  }
  return null;
}

function normalize(identity) {
  const uid = String(identity.uid || '').trim();
  const name = String(identity.name || '').trim();
  return { uid, name, admin: uid === ADMIN_UID };
}

/** 是否是飞牛主账号（超级管理员）。 */
function isAdmin(identity) {
  return Boolean(identity && identity.admin);
}

module.exports = { detect, isAdmin, decodeJwtPayload, ADMIN_UID };
