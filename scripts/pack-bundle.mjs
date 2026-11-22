#!/usr/bin/env node
/**
 * 把一个 npm 包的**整棵生产依赖树**打进 `deps/<名字>/`，并更新清单。
 *
 * 为什么需要这个：`ws` / `silk-wasm` 是零依赖，一个 tarball 就够；
 * `qrcode` 这种带传递依赖的（29 个包）没法靠「解一个包」装上——必须把整棵树
 * 平铺进 `node_modules/`，那正是 npm 的 hoisted 布局。
 *
 * 版本解析**交给 npm**（`--package-lock-only` 生成 lockfile），不自己实现
 * semver；下载后逐个核对 lock 里的 `integrity`（sha512）——市场仓里的字节
 * 必须与 npm 官方 tarball 一致。清单里只写名字/版本/文件名，sha256 由
 * `build-index.mjs` 现算。
 *
 * 用法：
 *   node scripts/pack-bundle.mjs qrcode@1.5.4
 *   node scripts/pack-bundle.mjs qrcode@1.5.4 --why "生成二维码（扫码登录）"
 *
 * 产出：
 *   deps/qrcode/<name>-<version>.tgz
 *   deps/manifest.json 的 bundles[] 里对应条目（没有就新建）
 */
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DEPS = path.join(ROOT, 'deps');
const MANIFEST = path.join(DEPS, 'manifest.json');

const args = process.argv.slice(2);
const spec = args.find((a) => !a.startsWith('--') && /^(@?[^@]+)@\d/.test(a));
const whyIdx = args.indexOf('--why');
const whyArg = whyIdx >= 0 ? String(args[whyIdx + 1] ?? '') : '';

if (!spec) {
  console.error('用法：node scripts/pack-bundle.mjs <包名>@<版本> [--why "用途"]');
  process.exit(1);
}
const at = spec.lastIndexOf('@');
const name = spec.slice(0, at);
const version = spec.slice(at + 1);
if (!name || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`解析失败：${spec}`);
  process.exit(1);
}

/** npm 在 Windows 上必须是 `npm.cmd` 且过 shell（Node 20 起直接 spawn 批处理会 EINVAL） */
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

async function resolveTree() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-bundle-'));
  try {
    execFileSync(
      npmCmd,
      [
        'install', `${name}@${version}`,
        '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund',
        /** 版本与 integrity 以官方 registry 为准；用镜像源会拿到被改过的 integrity */
        '--registry=https://registry.npmjs.org',
      ],
      { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', timeout: 180_000 },
    );
    const lock = JSON.parse(await fs.readFile(path.join(tmp, 'package-lock.json'), 'utf8'));
    return Object.entries(lock.packages ?? {})
      .filter(([k, v]) => k && v?.version && v?.resolved && !v.dev && !v.link)
      .map(([k, v]) => ({
        name: k.replace(/^.*node_modules\//, ''),
        version: v.version,
        resolved: v.resolved,
        integrity: v.integrity,
      }));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

const tree = await resolveTree();
if (!tree.length) throw new Error('lockfile 里没有任何生产依赖，检查包名/版本');

const dir = path.join(DEPS, name);
await fs.mkdir(dir, { recursive: true });
/** 先清掉旧的 tgz：上一次的版本留在目录里，`--check` 不会发现，但它会被一起发布 */
for (const f of await fs.readdir(dir)) {
  if (f.endsWith('.tgz')) await fs.rm(path.join(dir, f), { force: true });
}

const packages = [];
let total = 0;
for (const it of tree) {
  const res = await fetch(it.resolved, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${it.name}@${it.version} 下载失败：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const sri = `sha512-${createHash('sha512').update(buf).digest('base64')}`;
  if (sri !== it.integrity) {
    throw new Error(`${it.name}@${it.version} integrity 不符\n  期望 ${it.integrity}\n  实际 ${sri}`);
  }
  const file = `${it.name.replace('/', '__')}-${it.version}.tgz`;
  await fs.writeFile(path.join(dir, file), buf);
  packages.push({ name: it.name, version: it.version, file });
  total += buf.length;
}
packages.sort((a, b) => a.name.localeCompare(b.name));

const manifest = JSON.parse(await fs.readFile(MANIFEST, 'utf8'));
manifest.bundles = Array.isArray(manifest.bundles) ? manifest.bundles : [];
const prev = manifest.bundles.find((b) => b?.name === name);
const entry = {
  name,
  version,
  license: prev?.license ?? '',
  why: whyArg || prev?.why || '',
  dir: name,
  packages: packages.map(({ name: n, version: v, file }) => ({ name: n, version: v, file })),
};
manifest.bundles = [...manifest.bundles.filter((b) => b?.name !== name), entry]
  .sort((a, b) => String(a.name).localeCompare(String(b.name)));

await fs.writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`${name}@${version}：${packages.length} 个包 / ${(total / 1024).toFixed(0)} KB`);
console.log(`  → ${path.relative(ROOT, dir)}/`);
console.log('  下一步：node scripts/build-index.mjs 重算索引');
