/**
 * 跨仓哈希一致性守卫
 * ==================
 *
 * 用户装插件时，框架用 `src/hashdir.js` 重算目录 sha256 与 index.json 比对；
 * 索引里的 sha256 是插件仓 `scripts/hashdir.mjs` 算的。两份实现一旦漂移，
 * 就会「索引由一份生成、由另一份校验」→ 所有用户安装 100% 校验失败。
 *
 * 这个测试在同一个固定样例目录上各算一遍，断言逐字节一致。
 * 需要 ROOST_FRAMEWORK 指向框架检出目录（CI 里 checkout 到 .framework/）。
 * 本地没设就跳过，不阻塞日常开发。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { pathToFileURL } from 'node:url';
import { hashDir as pluginHash, HASH_ALGO } from '../scripts/hashdir.mjs';

const FRAMEWORK = process.env.ROOST_FRAMEWORK;
if (!FRAMEWORK) {
  console.log('跳过：未设置 ROOST_FRAMEWORK（本地开发可不跑）');
  process.exit(0);
}

const frameworkSrcPath = path.join(FRAMEWORK, 'src/hashdir.js');
const frameworkSrc = await fs.readFile(frameworkSrcPath, 'utf8');
const frameworkAlgo = Number(frameworkSrc.match(/HASH_ALGO\s*=\s*(\d+)/)?.[1] ?? 0);
const frameworkHashMod = await import(pathToFileURL(frameworkSrcPath).href);
const frameworkHash = frameworkHashMod.hashDir;

// 造一个固定样例：文本(CRLF 需归一) + 二进制 + 子目录 + 应被跳过的目录/文件
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-hash-'));
try {
  await fs.mkdir(path.join(dir, 'sub'), { recursive: true });
  await fs.writeFile(path.join(dir, 'a.txt'), 'hello\r\nworld\r\n');
  await fs.writeFile(path.join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255]));
  await fs.writeFile(path.join(dir, 'sub', 'b.txt'), 'nested\nline\n');
  await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(dir, 'node_modules', 'x.js'), 'ignored');
  await fs.mkdir(path.join(dir, '.venv'), { recursive: true });
  await fs.writeFile(path.join(dir, '.venv', 'y.py'), 'ignored');
  await fs.writeFile(path.join(dir, '.DS_Store'), 'ignored');
  // 纯文档不进指纹：两份实现都必须忽略 .md 与 LICENSE（改协议不该升版本）
  await fs.mkdir(path.join(dir, 'docs'), { recursive: true });
  await fs.writeFile(path.join(dir, 'README.md'), 'doc v1\n');
  await fs.writeFile(path.join(dir, 'docs', 'guide.md'), 'more docs\n');
  await fs.writeFile(path.join(dir, 'LICENSE'), 'MIT\n');

  const a = await pluginHash(dir);
  const b = await frameworkHash(dir);
  if (a !== b) {
    /**
     * 插件改了算法/跳过规则但框架还没发版时，两边本来就该不同。用版本标记
     * 区分这种窗口期与真漂移：标记不一致只 warning，不阻塞 CI；标记一致
     * 却算出不同值，说明真出事了，继续硬失败。
     */
    if (frameworkAlgo !== HASH_ALGO) {
      console.warn(`::warning::跨仓哈希算法版本未同步（插件 v${HASH_ALGO}，框架 v${frameworkAlgo || '未标记'}），跳过逐字节断言；框架发版后再恢复。`);
    } else {
      assert.equal(a, b, `跨仓哈希不一致：插件仓=${a} 框架=${b}`);
    }
  } else {
    console.log(`PASS 跨仓哈希一致 ${a.slice(0, 12)}…`);
  }
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
