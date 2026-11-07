'use strict';

const { parseArgs, resolveContext, sleep, fail } = require('./lib/context.cjs');

async function main() {
  const flags = parseArgs();
  if (flags.help) {
    console.log(
      '用法：node like.cjs --account 备注 [--source group --group 123456789] [--count 10] [--interval 3]\n' +
        '      --source friend 时不需要 --group。'
    );
    return;
  }
  const { client, account } = resolveContext(flags);
  const source = flags.source === 'friend' ? 'friend' : 'group';
  const count = Math.min(20, Math.max(1, Number(flags.count) || 10));
  const interval = Math.min(10, Math.max(1, Number(flags.interval) || 3)) * 1000;
  const self = account ? String(account.qq) : '';

  let users;
  if (source === 'friend') {
    const friends = await client.getFriendList();
    users = (friends || []).map((friend) => ({ id: friend.user_id, name: friend.nickname || friend.remark || '' }));
  } else {
    if (!flags.group) throw new Error('群成员点赞需要通过 --group 指定群号');
    if (!/^\d+$/.test(String(flags.group))) throw new Error('群号必须是纯数字');
    const members = await client.getGroupMemberList(flags.group);
    users = (members || []).map((member) => ({ id: member.user_id, name: member.card || member.nickname || '' }));
  }

  users = users.filter((user) => String(user.id) !== self).slice(0, count);
  if (!users.length) {
    console.log('没有可点赞的对象。');
    return;
  }

  let ok = 0;
  for (const user of users) {
    try {
      await client.sendLike(user.id, 1);
      ok += 1;
      console.log(`已点赞：${user.name || user.id}`);
    } catch (error) {
      console.error(`点赞失败：${user.name || user.id} - ${error.message}`);
    }
    await sleep(interval);
  }
  console.log(`完成：${ok}/${users.length}`);
  if (!ok) process.exitCode = 2;
}

main().catch(fail);
