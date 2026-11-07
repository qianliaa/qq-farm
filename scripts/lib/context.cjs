'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { OneBot } = require('../../shared/onebot.cjs');

function parseArgs(argv = process.argv.slice(2)) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith('--')) {
      result._.push(item);
      continue;
    }
    const equal = item.indexOf('=');
    if (equal > -1) {
      result[item.slice(2, equal)] = item.slice(equal + 1);
      continue;
    }
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      result[key] = true;
    } else {
      result[key] = next;
      i += 1;
    }
  }
  return result;
}

function dataDir() {
  return process.env.DATA_DIR || '/app/data';
}

function loadConfig() {
  const file = path.join(dataDir(), 'config.json');
  if (!fs.existsSync(file)) {
    throw new Error(`找不到配置文件 ${file}。请先启动管理面板，或通过 DATA_DIR 指定应用数据目录。`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function pickAccount(config, keyword) {
  const accounts = config.accounts || [];
  if (!accounts.length) throw new Error('还没有托管账号，请先在管理面板添加并登录 QQ。');
  if (!keyword) {
    if (accounts.length === 1) return accounts[0];
    throw new Error(
      `当前有 ${accounts.length} 个账号，请用 --account 指定其中一个：\n` +
        accounts.map((item) => `  ${item.alias}  (id=${item.id}${item.qq ? `, QQ=${item.qq}` : ''})`).join('\n')
    );
  }
  const found = accounts.find(
    (item) => item.id === keyword || item.alias === keyword || String(item.qq) === String(keyword)
  );
  if (!found) throw new Error(`没有找到账号「${keyword}」`);
  return found;
}

function resolveContext(flags) {
  if (flags.url) {
    return {
      account: null,
      client: new OneBot({
        baseUrl: flags.url,
        token: flags.token || process.env.ONEBOT_TOKEN || '',
        timeout: 15000,
      }),
    };
  }
  const config = loadConfig();
  const account = pickAccount(config, flags.account || process.env.QQ_ACCOUNT);
  return {
    account,
    client: new OneBot({
      baseUrl: `http://127.0.0.1:${account.onebotPort || 3000}`,
      token: account.onebotToken,
      timeout: 15000,
    }),
  };
}

function splitIds(value) {
  return String(value || '')
    .split(/[\s,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(error) {
  console.error(`错误：${error.message || error}`);
  process.exit(1);
}

module.exports = { parseArgs, resolveContext, splitIds, sleep, fail, loadConfig };
