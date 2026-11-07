'use strict';

const { parseArgs, resolveContext, splitIds, sleep, fail } = require('./lib/context.cjs');

async function main() {
  const flags = parseArgs();
  if (flags.help) {
    console.log(
      '用法：node broadcast.cjs --account 备注 --targets 123456,987654 --text "消息内容" [--scope group|friend] [--interval 1.2]'
    );
    return;
  }
  const { client } = resolveContext(flags);
  const targets = splitIds(flags.targets);
  const text = String(flags.text || '').trim();
  const scope = flags.scope === 'friend' ? 'friend' : 'group';
  if (!targets.length) throw new Error('请通过 --targets 指定目标，多个用逗号分隔');
  if (!text) throw new Error('请通过 --text 指定要发送的内容');
  const interval = Math.min(10, Math.max(1, Number(flags.interval) || 1.2)) * 1000;

  let ok = 0;
  for (const target of targets) {
    try {
      if (scope === 'friend') await client.sendPrivateMsg(target, text);
      else await client.sendGroupMsg(target, text);
      ok += 1;
      console.log(`已发送：${scope === 'friend' ? 'QQ' : '群'} ${target}`);
    } catch (error) {
      console.error(`发送失败：${target} - ${error.message}`);
    }
    await sleep(interval);
  }
  console.log(`完成：${ok}/${targets.length}`);
  if (!ok) process.exitCode = 2;
}

main().catch(fail);
