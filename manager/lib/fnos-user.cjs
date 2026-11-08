'use strict';

/**
 * 识别飞牛（fnOS）当前登录用户，用于无访问密码时的自动用户隔离。
 *
 * 飞牛未公开身份接口，这里从反向代理透传的请求头与登录 Cookie 中提取身份：
 * 1. 常见身份请求头（x-trim-uid / x-trim-username / x-forwarded-user 等）
 * 2. Cookie 中的 JWT：解码 payload 取 uid / username（只读，无需密钥）
 * 3. 明文的 uid / user 类 Cookie
 * 识别不到时返回 null，由调用方决定回退策略。
 */

/** 可能携带飞牛身份信息的请求头：[头名, 类型]。类型 name 表示用户名，uid 表示数字身份。 */
const HEADER_CANDIDATES = [
  ['x-trim-uid', 'uid'],
  ['x-trim-user-id', 'uid'],
  ['x-trim-username', 'name'],
  ['x-trim-user', 'name'],
  ['x-trim-user-name', 'name'],
  ['x-fnos-uid', 'uid'],
  ['x-fnos-username', 'name'],
  ['x-forwarded-user', 'name'],
  ['x-remote-user', 'name'],
  ['x-auth-user', 'name'],
  ['x-user-id', 'uid'],
  ['x-username', 'name'],
  ['remote_user', 'name'],
];

/** JWT payload 中可能的用户名字段。 */
const JWT_NAME_KEYS = ['username', 'userName', 'user_name', 'nickname', 'name', 'account'];
/** JWT payload 中可能的用户 id 字段。 */
const JWT_UID_KEYS = ['uid', 'userId', 'user_id', 'id', 'sub'];

function base64UrlDecode(input) {
  const text = String(input).replace(/-/g, '+').replace(/_/g, '/');
  const padded = text + '='.repeat((4 - (text.length % 4)) % 4);
  try {
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch (_error) {
    return '';
  }
}

/** 解码 JWT payload；不是 JWT 或解析失败返回 null。 */
function decodeJwtPayload(value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 3) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
  const raw = base64UrlDecode(parts[1]);
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw);
    return payload && typeof payload === 'object' ? payload : null;
  } catch (_error) {
    return null;
  }
}

function fromJwtPayload(payload) {
  if (!payload) return null;
  let uid = '';
  let name = '';
  for (const key of JWT_UID_KEYS) {
    const value = payload[key];
    if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) {
      uid = String(value);
      break;
    }
  }
  for (const key of JWT_NAME_KEYS) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) {
      name = value.trim();
      break;
    }
  }
  return uid || name ? { uid, name } : null;
}

function parseCookies(header) {
  const result = {};
  for (const item of String(header || '').split(';')) {
    const index = item.indexOf('=');
    if (index <= 0) continue;
    result[item.slice(0, index).trim()] = item.slice(index + 1).trim();
  }
  return result;
}

/**
 * 识别请求中的飞牛用户身份。
 * @returns {{ id: string, uid: string, name: string, source: string } | null}
 */
function detect(req) {
  const headers = req.headers || {};

  // 1. 显式身份请求头
  for (const [header, kind] of HEADER_CANDIDATES) {
    const value = headers[header];
    if (!value) continue;
    const text = String(value).split(',')[0].trim();
    if (!text) continue;
    if (kind === 'uid') {
      if (!/^\d+$/.test(text)) continue;
      return { id: `fnos:${text}`, uid: text, name: '', source: `header:${header}` };
    }
    return { id: `fnos:${text}`, uid: '', name: text, source: `header:${header}` };
  }

  // 2. Cookie 中的 JWT
  const cookies = parseCookies(headers.cookie);
  for (const [key, value] of Object.entries(cookies)) {
    const identity = fromJwtPayload(decodeJwtPayload(value));
    if (!identity) continue;
    const id = identity.uid ? `fnos:${identity.uid}` : `fnos:${identity.name}`;
    return { id, uid: identity.uid, name: identity.name, source: `cookie:${key}` };
  }

  // 3. 明文的 uid Cookie（如 trim-uid=1000）
  for (const [key, value] of Object.entries(cookies)) {
    if (!/uid|user/i.test(key)) continue;
    if (!/^\d+$/.test(value)) continue;
    return { id: `fnos:${value}`, uid: value, name: '', source: `cookie:${key}` };
  }

  return null;
}

/** 排查用：列出请求中与身份相关的线索（值做脱敏）。 */
function inspect(req) {
  const headers = req.headers || {};
  const foundHeaders = {};
  for (const [header] of HEADER_CANDIDATES) {
    if (headers[header]) foundHeaders[header] = String(headers[header]).slice(0, 40);
  }
  const cookies = parseCookies(headers.cookie);
  const foundCookies = {};
  for (const [key, value] of Object.entries(cookies)) {
    const jwt = decodeJwtPayload(value);
    foundCookies[key] = jwt
      ? { jwt: true, keys: Object.keys(jwt) }
      : { jwt: false, length: String(value).length };
  }
  return { headers: foundHeaders, cookies: foundCookies, detected: detect(req) };
}

module.exports = { detect, inspect, decodeJwtPayload };
