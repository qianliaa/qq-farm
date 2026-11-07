'use strict';

const { parseArgs, resolveContext, splitIds, sleep, fail } = require('./lib/context.cjs');

async function main() {
  const flags = parseArgs();
  if (flags.help) {
    console.log(
      '用法：node sign.cjs --account 备注 --groups 123456,987654 [--text 签到] [--interval 1.2]\n' +
        '说明：默认调用 QQ 官方群签到接口（set_group_sign）；带 --text 时签到后再发送一条群消息。'
    );
    return;
  }
  const { client } = resolveContext(flags);
  const groups = splitIds(flags.groups);
  if (!groups.length) throw new Error('请通过 --groups 指定至少一个群号，多个用逗号分隔');
  const text = String(flags.text || '').trim();
  const interval = Math.min(10, Math.max(1, Number(flags.interval) || 1.2)) * 1000;

  let ok = 0;
  for (const groupId of groups) {
    try {
      await client.setGroupSign(groupId);
      ok += 1;
      console.log(`签到成功：群 ${groupId}`);
    } catch (error) {
      console.error(`签到失败：群 ${groupId} - ${error.message}`);
      continue;
    }
    if (text) {
      try {
        await client.sendGroupMsg(groupId, text);
        console.log(`签到文字已发送：群 ${groupId}`);
      } catch (error) {
        console.error(`签到文字发送失败：群 ${groupId} - ${error.message}`);
      }
      await sleep(interval);
    }
  }
  console.log(`完成：${ok}/${groups.length}`);
  if (!ok) process.exitCode = 2;
}

main().catch(fail);
