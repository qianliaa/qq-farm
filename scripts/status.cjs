'use strict';

const { parseArgs, resolveContext, fail } = require('./lib/context.cjs');

async function main() {
  const flags = parseArgs();
  if (flags.help) {
    console.log('用法：node status.cjs [--account 备注|QQ号|id] [--url http://host:3000 --token xxx]');
    return;
  }
  const { client, account } = resolveContext(flags);
  const status = await client.getStatus();
  const info = await client.getLoginInfo();
  console.log(`账号：${account ? account.alias : '自定义连接'}`);
  console.log(`QQ：${info.user_id}（${info.nickname}）`);
  console.log(`在线：${status.online ? '是' : '否'}`);
  console.log(`状态：${status.status}`);
  console.log(`消息接收：${status.good ? '正常' : '异常'}`);
  const reason = account && account.offlineReason;
  if (reason) {
    console.log(`掉线原因：${reason.categoryLabel} · ${reason.title}`);
    console.log(`处理建议：${reason.advice}`);
  } else if (account && account.lastOfflineReason && status.online) {
    const last = account.lastOfflineReason;
    console.log(`上次掉线：${last.categoryLabel} · ${last.title}`);
  }
}

main().catch(fail);
