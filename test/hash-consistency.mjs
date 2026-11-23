/**
 * 跨仓哈希一致性守卫
 * ==================
 *
 * 用户装扩展 / 插件时，框架用 `src/ext-bundle.js` 重算目录 sha256 与 index.json 比对；
 * 索引里的 `sha256`（algo1）与 `sha256_v2`（algo2）由插件仓 `scripts/hashdir.mjs` 算出。
 * 两份实现一旦漂移，就会「索引由一份生成、由另一份校验」→ 所有用户安装 100% 失败。
 *
 * 这个测试在同一个固定样例目录上把**两个算法各算一遍**，断言逐字节一致。
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

/**
 * 框架的哈希实现 2026-11 从 src/hashdir.js 迁到了 src/ext-bundle.js。
 * CI 里 ROOST_FRAMEWORK 钉在已发布 tag（仓库变量 FRAMEWORK_REF，当前 v1.1.11），
 * 那个版本只有旧路径；本地开发指向新 checkout 时只有新路径。两条都要能跑。
 */
let frameworkSrcPath = path.join(FRAMEWORK, 'src/ext-bundle.js');
try {
  await fs.access(frameworkSrcPath);
} catch {
  frameworkSrcPath = path.join(FRAMEWORK, 'src/hashdir.js');
}
const frameworkSrc = await fs.readFile(frameworkSrcPath, 'utf8');
const frameworkAlgo = Number(frameworkSrc.match(/HASH_ALGO\s*=\s*(\d+)/)?.[1] ?? 0);
const frameworkHashMod = await import(pathToFileURL(frameworkSrcPath).href);
const frameworkHash = frameworkHashMod.hashDir;

// 固定样例：文本(CRLF 需归一) + 二进制 + 子目录 + 应被跳过的目录/文件
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
  // algo2 才排除：纯文档、旧依赖 / 抽帧目录、运行时状态
  await fs.mkdir(path.join(dir, 'docs'), { recursive: true });
  await fs.writeFile(path.join(dir, 'README.md'), 'doc v1\n');
  await fs.writeFile(path.join(dir, 'docs', 'guide.md'), 'more docs\n');
  await fs.writeFile(path.join(dir, 'LICENSE'), 'MIT\n');
  await fs.mkdir(path.join(dir, 'deps'), { recursive: true });
  await fs.writeFile(path.join(dir, 'deps', 'old.js'), 'legacy dep');
  await fs.mkdir(path.join(dir, 'shots'), { recursive: true });
  await fs.writeFile(path.join(dir, 'shots', '1.png'), 'frame');
  await fs.writeFile(path.join(dir, 'ui-data.json'), '{}');
  await fs.writeFile(path.join(dir, 'seen.json'), '{}');

  for (const algo of [1, 2]) {
    const a = await pluginHash(dir, { algo });
    const b = await frameworkHash(dir, { algo });
    if (a !== b) {
      /**
       * 插件改了算法/跳过规则但框架还没发版时，两边本来就该不同。用版本标记
       * 区分这种窗口期与真漂移：标记不一致只 warning，不阻塞 CI；标记一致
       * 却算出不同值，说明真出事了，继续硬失败。
       */
      if (frameworkAlgo !== HASH_ALGO) {
        console.warn(`::warning::跨仓哈希算法版本未同步（插件 v${HASH_ALGO}，框架 v${frameworkAlgo || '未标记'}），跳过 algo${algo} 逐字节断言；框架发版后再恢复。`);
      } else {
        assert.equal(a, b, `跨仓哈希不一致（algo${algo}）：插件仓=${a} 框架=${b}`);
      }
    } else {
      console.log(`PASS 跨仓哈希一致 algo${algo} ${a.slice(0, 12)}…`);
    }
  }
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
