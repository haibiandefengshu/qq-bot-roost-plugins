#!/usr/bin/env node
/**
 * fork 投稿索引字段校验
 * =====================
 *
 * pr-guard.yml 只做路径红线（允许 plugins/** + 根 index.json），且不执行 PR
 * 代码；ci.yml 里 build-index.mjs --check 只比「脚本能算出来的字段」
 * （结构字段 + verified + category）。两者都管不到的地方由本脚本守：
 *
 *   1. 顶层 schema / repo / branch 必须与基准一致——否则投稿人能把安装源
 *      指到自己的 fork；
 *   2. contributors / credits / addedAt 是已退役的旧流程字段，投稿人不能
 *      自己塞回来；存量必须与基准一致，新条目必须不存在；
 *   3. author 只是市场搜索用的 GitHub 用户名，不是署名依据：存量条目保持
 *      基准值，新条目取 plugin.json.author（生成器从插件目录读出来的值）；
 *   4. 本次改动到的插件，其 name / description / tags / commands（以及新
 *      条目的 author）必须与「空索引 + 插件目录」重新生成的结果一致，
 *      防止 index.json 说一套、装下来是另一套。
 *
 * 校验方式：把 PR 的 plugins/ + scripts/ + 分级表复制到临时目录，用一份
 * 只有根字段的空 index.json 跑一遍 build-index.mjs，拿到「純生成」的条目
 * 再做对比。基准索引用 git show <CI_BASE_REF>:index.json 读取；基准只用来
 * 认「哪些字段是维护者已写过的」，不参与生成，所以 PR 分支落后于 base 时
 * 也不会把别人新加的插件误判成漂移。
 *
 * 非 fork PR / 没有事件 JSON 时直接跳过（仍给 required check 一个 success）。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASE_REF = process.env.CI_BASE_REF ?? '';

async function isForkPr() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !(awaitExists(eventPath))) return false;
  try {
    const event = JSON.parse(await fs.readFile(eventPath, 'utf8'));
    const head = String(event.pull_request?.head?.repo?.full_name ?? '');
    const base = String(event.repository?.full_name ?? '');
    return Boolean(head && head !== base);
  } catch {
    return false;
  }
}

function awaitExists(p) {
  return fs.access(p).then(() => true, () => false);
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function norm(value) {
  return JSON.stringify(value ?? null);
}

if (!BASE_REF) {
  console.error('check-index-submission: CI_BASE_REF 未设置');
  process.exit(1);
}
if (!(await isForkPr())) {
  console.log('check-index-submission: 非 fork PR，跳过');
  process.exit(0);
}

const baseRaw = git(['show', `${BASE_REF}:index.json`]);
const baseIndex = JSON.parse(baseRaw);
const submitted = JSON.parse(await fs.readFile(path.join(ROOT, 'index.json'), 'utf8'));
const problems = [];

/* ---------- 1. 顶层字段 ---------- */
for (const key of ['schema', 'repo', 'branch']) {
  if (norm(baseIndex[key]) !== norm(submitted[key])) {
    problems.push(`index.json.${key}: 基准=${norm(baseIndex[key])} 提交=${norm(submitted[key])}`);
  }
}
const baseKeys = Object.keys(baseIndex).filter((k) => k !== 'updated').sort();
const subKeys = Object.keys(submitted).filter((k) => k !== 'updated').sort();
if (norm(baseKeys) !== norm(subKeys)) {
  problems.push(`index.json 顶层字段集合变了：基准=${baseKeys.join(',')} 提交=${subKeys.join(',')}`);
}

/* ---------- 2. 本次改到了哪些插件 ---------- */
const changed = new Set();
const diffOut = git(['diff', '--name-only', `${BASE_REF}...HEAD`, '--', 'plugins/']);
for (const line of diffOut.split('\n')) {
  const m = /^plugins\/([^/]+)\//.exec(line.trim());
  if (m) changed.add(m[1]);
}

/* ---------- 3. 用「空索引 + PR 插件目录」生成对照条目 ---------- */
const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-index-check-'));
try {
  for (const dir of ['plugins', 'scripts']) {
    await fs.cp(path.join(ROOT, dir), path.join(stage, dir), { recursive: true });
  }
  for (const file of ['categories.json', 'verified.json']) {
    const src = path.join(ROOT, file);
    if (await awaitExists(src)) await fs.copyFile(src, path.join(stage, file));
  }
  const seed = {};
  for (const key of ['schema', 'repo', 'branch']) {
    if (Object.hasOwn(baseIndex, key)) seed[key] = baseIndex[key];
  }
  seed.plugins = [];
  await fs.writeFile(path.join(stage, 'index.json'), `${JSON.stringify(seed, null, 2)}\n`, 'utf8');
  execFileSync(process.execPath, ['scripts/build-index.mjs'], { cwd: stage, stdio: 'pipe' });
  const generated = JSON.parse(await fs.readFile(path.join(stage, 'index.json'), 'utf8'));
  const generatedById = new Map((generated.plugins ?? []).map((p) => [p.id, p]));

  const baseById = new Map((baseIndex.plugins ?? []).map((p) => [p.id, p]));
  const maintainerOnly = ['contributors', 'credits', 'addedAt'];
  const display = ['name', 'description', 'tags', 'commands'];

  for (const row of submitted.plugins ?? []) {
    const old = baseById.get(row.id);
    const fresh = generatedById.get(row.id);

    for (const key of maintainerOnly) {
      if (old && norm(old[key]) !== norm(row[key])) {
        problems.push(`${row.id}.${key}: 维护者字段被改动（基准=${norm(old[key])} 提交=${norm(row[key])}）`);
      }
      if (!old && Object.hasOwn(row, key)) {
        problems.push(`${row.id}.${key}: 新条目不允许自带维护者字段`);
      }
    }

    // author 不是署名依据：存量保持基准；新条目按插件目录自述（仅搜索用）。
    if (old) {
      if (norm(old.author) !== norm(row.author)) {
        problems.push(`${row.id}.author: 存量条目的 author 不能由投稿改动`);
      }
    } else if (fresh && norm(fresh.author) !== norm(row.author)) {
      problems.push(`${row.id}.author: 新条目的 author 应与 plugin.json 一致（生成=${norm(fresh.author)} 提交=${norm(row.author)}）`);
    }

    if (changed.has(row.id) && fresh) {
      for (const key of display) {
        if (norm(fresh[key]) !== norm(row[key])) {
          problems.push(`${row.id}.${key}: 与插件目录不一致（生成=${norm(fresh[key])} 提交=${norm(row[key])}）`);
        }
      }
    }
  }
} finally {
  await fs.rm(stage, { recursive: true, force: true });
}

if (problems.length) {
  console.error('投稿索引校验失败：');
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('\n请跑 node scripts/build-index.mjs 生成 index.json，不要手改维护者字段。');
  process.exit(1);
}
console.log(`✓ 投稿索引字段校验通过（${changed.size} 个插件有改动）`);
