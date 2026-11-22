// Explicit, opt-in platform probe. Does not connect to QQ or call delivery().
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createEngineHost } from '../engine-host.js';
import { flattenPlan } from '../delivery.js';
import { validateLocalFile } from '../files.js';

if (process.env.MEDIA_PARSER_ONLINE_PROBE !== '1') {
  throw new Error('Set MEDIA_PARSER_ONLINE_PROBE=1 to run this network probe explicitly');
}
const pluginDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-media-online-'));
const server = net.createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const config = {
  engineMode: 'managed', engineUrl: `http://127.0.0.1:${port}`,
  pythonPath: process.env.MEDIA_PARSER_TEST_PYTHON || '',
  ffmpegPath: process.env.MEDIA_PARSER_TEST_FFMPEG || '',
  maxLinks: 3, cacheSeconds: 60, maxFileMiB: 12, timeoutSeconds: 45,
  hotComments: 0, translation: false,
};
const host = createEngineHost({
  ctx: { dataDir, state: {}, logger: { info() {}, warn: (message) => console.warn(message) } },
  config: () => config,
});
const targets = [
  { id: 'bilibili-video', platform: 'bilibili', url: 'https://www.bilibili.com/video/BV1GJ411x7h7' },
  { id: 'bilibili-short', platform: 'bilibili', url: 'https://b23.tv/BV1GJ411x7h7' },
  { id: 'douyin-album', platform: 'douyin', url: 'https://www.douyin.com/note/7442267945523301672' },
  { id: 'netease-full-audio', platform: 'netease', url: 'https://music.163.com/song?id=186016' },
  { id: 'ximalaya-audio-candidate', platform: 'ximalaya', url: 'https://www.ximalaya.com/sound/48780743' },
  { id: 'github-article', platform: 'github', url: 'https://github.com/python/cpython' },
];
const report = {
  date: new Date().toISOString(),
  scope: 'Authenticated real engine; public samples; no credentials, no proxy, no QQ sending',
  limits: { maxFileMiB: 12, timeoutSeconds: 45 },
  prepared: false, sourceTamperRecovered: false, translation: null, results: [],
};
try {
  assert.equal(await host.ensure(), true, host.status().lastError);
  report.prepared = true;
  // Damage only this probe's generated copy, then verify a safe rebuild.
  await host.stop();
  const record = JSON.parse(fs.readFileSync(path.join(dataDir, 'engine-instance.json'), 'utf8'));
  const runtimeEntry = path.join(record.engineDir, 'run_engine.py');
  const original = fs.readFileSync(runtimeEntry);
  fs.appendFileSync(runtimeEntry, '\n# generated-copy-integrity-probe\n');
  assert.equal(await host.ensure(), true, host.status().lastError);
  assert.deepEqual(fs.readFileSync(runtimeEntry), original);
  report.sourceTamperRecovered = true;
  const health = await host.health();
  report.translation = health.translation;
  report.platformCount = health.platforms;
  console.log(JSON.stringify({ prepared: true, sourceTamperRecovered: true, translation: health.translation, platforms: health.platforms }));
  for (const target of targets) {
    console.log(`Probing ${target.id}`);
    const started = Date.now();
    const result = { ...target, elapsedMs: 0 };
    try {
      const outcome = await host.parse({
        text: target.url, userKey: `local-probe:${target.id}`, senderName: '本地解析预览',
        senderId: 'probe', quoteFirstText: false,
      }, { deadlineAt: Date.now() + 45000 });
      const { items: nodes } = flattenPlan(outcome);
      result.ok = outcome.ok === true;
      result.items = (outcome.items || []).map((item) => ({
        platform: item.platform, title: item.title, error: item.error,
        videoCount: item.videoCount, imageCount: item.imageCount, audioCount: item.audioCount,
        hasValidMedia: item.hasValidMedia, translated: item.translated,
        videoSkipReasons: item.videoSkipReasons, imageSkipReasons: item.imageSkipReasons,
        audioSkipReasons: item.audioSkipReasons,
      }));
      result.blocked = outcome.blocked || [];
      result.skipped = outcome.skipped || [];
      result.nodes = {};
      result.localFiles = [];
      for (const node of nodes) {
        result.nodes[node.type] = (result.nodes[node.type] || 0) + 1;
        if (node.type === 'text') continue;
        const reference = node.reference;
        if (!reference) continue;
        try {
          const file = await validateLocalFile(reference, { cacheRoot: host.cacheRoot, maxBytes: 12 * 1024 * 1024 });
          result.localFiles.push({ type: node.type, bytes: file.size });
        } catch (error) {
          result.localFiles.push({ type: node.type, error: error.message.slice(0, 250) });
        }
      }
      if (outcome.leasedFiles?.length) await host.releaseFiles(outcome.leasedFiles);
    } catch (error) {
      result.ok = false;
      result.code = error.code || '';
      result.error = String(error.message).slice(0, 600);
    }
    result.elapsedMs = Date.now() - started;
    report.results.push(result);
    console.log(JSON.stringify(result));
  }
} catch (error) {
  report.fatal = { code: error.code || '', error: String(error.message).slice(0, 600) };
  process.exitCode = 1;
} finally {
  await host.stop().catch(() => {});
  fs.writeFileSync(path.join(pluginDir, 'test', 'PLATFORM-ONLINE-RESULTS.json'), JSON.stringify(report, null, 2) + '\n');
  const absolute = fs.realpathSync(dataDir);
  assert.ok(absolute.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
  fs.rmSync(absolute, { recursive: true, force: true });
}
