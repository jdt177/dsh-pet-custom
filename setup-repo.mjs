#!/usr/bin/env node
/**
 * 把仓库里的 <GITHUB_USER> / <REPO> 占位符替换成你的真实信息。
 *
 * 用法：
 *   node setup-repo.mjs --user yourname
 *   node setup-repo.mjs --user yourname --repo dsh-pet-custom
 *   node setup-repo.mjs --user yourname --check    只看还有哪些占位符，不改
 *
 * 会改到：package.json（homepage / repository / bugs / companionPlugin.install）与 README.md。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const argv = process.argv.slice(2);
const getArg = (f, d = null) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const CHECK = argv.includes('--check');
const USER = getArg('--user');
const REPO = getArg('--repo', 'dsh-pet-custom');

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};
const say = (...a) => console.log(...a);
const files = ['package.json', 'README.md'];

say('');
say(C.bold('仓库信息设置'));
say('');

if (CHECK || !USER) {
  let total = 0;
  for (const name of files) {
    const p = join(here, name);
    if (!existsSync(p)) continue;
    const hits = [...readFileSync(p, 'utf8').matchAll(/<(?:GITHUB_USER|REPO)>/g)];
    if (hits.length) {
      say(`  ${name}: ${hits.length} 处占位符`);
      total += hits.length;
    }
  }
  if (total === 0) {
    say(C.ok('  ✓ 没有占位符了，仓库信息已填好'));
  } else if (!USER) {
    say('');
    say(C.warn('  用法: node setup-repo.mjs --user 你的GitHub用户名'));
    say(C.dim('  可加 --repo <仓库名>（默认 dsh-pet-custom）'));
  }
  say('');
  process.exit(0);
}

let changed = 0;
for (const name of files) {
  const p = join(here, name);
  if (!existsSync(p)) continue;
  const before = readFileSync(p, 'utf8');
  const after = before.replaceAll('<GITHUB_USER>', USER).replaceAll('<REPO>', REPO);
  if (after !== before) {
    writeFileSync(p, after, 'utf8');
    const n = [...before.matchAll(/<(?:GITHUB_USER|REPO)>/g)].length;
    say(C.ok(`  ✓ ${name}（替换 ${n} 处）`));
    changed++;
  } else {
    say(C.dim(`  · ${name}（无占位符）`));
  }
}

say('');
say(`  仓库地址将是： ${C.bold(`https://github.com/${USER}/${REPO}`)}`);
say('');
say(C.bold('  下一步'));
say('    1) git init && git add -A && git commit -m "..."');
say(`    2) 在 GitHub 建空仓库 ${USER}/${REPO}（不要勾选初始化 README）`);
say('    3) git remote add origin <地址> && git push -u origin main');
say('    4) 打 tag 并在 Releases 里附上 npm pack 出来的 tgz（可选，见 PUBLISH.md）');
say('');
if (changed === 0) say(C.dim('  （没有文件被修改）'));
say('');