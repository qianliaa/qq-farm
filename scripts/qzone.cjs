'use strict';

const fs = require('node:fs');
const { parseArgs, resolveContext, splitIds, fail } = require('./lib/context.cjs');

async function main() {
  const flags = parseArgs();
  if (flags.help) {
    console.log(
      '用法：node qzone.cjs --account 备注 --content "今天天气不错" [--images url1,url2] [--right 1]\n' +
        '      node qzone.cjs --account 备注 --file contents.txt   # 每行一条，随机选一条发布\n' +
        '      node qzone.cjs --account 备注 --delete-after 60 --content "..."  # 发布后 60 秒删除\n' +
        '      node qzone.cjs --account 备注 --delete-tid <tid>      # 手动删除一条说说\n' +
        '权限：1 所有人 / 4 好友 / 16 部分好友 / 64 仅自己 / 128 部分好友不可见\n' +
        '说明：调用 NapCat 的 send_qzone_msg / delete_qzone_msg 接口，需要较新的运行环境。'
    );
    return;
  }

  const { client } = resolveContext(flags);

  if (flags['delete-tid']) {
    const tid = String(flags['delete-tid']);
    await client.deleteQzoneMsg(tid);
    console.log(`已删除 tid：${tid}`);
    return;
  }

  let contents = [];
  if (flags.file) {
    contents = fs
      .readFileSync(String(flags.file), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }
  if (flags.content) contents.unshift(String(flags.content));
  if (!contents.length) throw new Error('请通过 --content 或 --file 指定说说内容');

  const content = contents[Math.floor(Math.random() * contents.length)];
  const images = splitIds(flags.images);
  const ugcRight = [1, 4, 16, 64, 128].includes(Number(flags.right)) ? Number(flags.right) : 1;

  const data = await client.sendQzoneMsg(content, { images, ugcRight });
  const tid = data && data.tid ? String(data.tid) : '';
  console.log(`已发布：${content}`);
  if (tid) console.log(`tid：${tid}`);
  if (images.length) console.log(`配图：${images.length} 张`);

  if (flags['delete-after'] !== undefined) {
    if (!tid) throw new Error('接口未返回 tid，无法自动删除');
    const seconds = Math.min(86400, Math.max(0, Math.round(Number(flags['delete-after']) || 0)));
    console.log(`${seconds} 秒后删除…`);
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    await client.deleteQzoneMsg(tid);
    console.log('已删除该条说说');
  }
}

main().catch(fail);
