import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createEngineHost } from '../engine-host.js';

const enabled = process.env.MEDIA_PARSER_TEST_REAL_ENGINE === '1';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('clean managed install, partial dependencies, hot reload, leases and authenticated restart', {
  skip: !enabled,
  timeout: 900000,
}, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-media-real-test-'));
  const state = {};
  const cfg = {
    engineMode: 'managed', engineUrl: `http://127.0.0.1:${await freePort()}`,
    pythonPath: process.env.MEDIA_PARSER_TEST_PYTHON || '',
    ffmpegPath: process.env.MEDIA_PARSER_TEST_FFMPEG || '',
    maxLinks: 2, cacheSeconds: 120, maxFileMiB: 16, translation: false,
  };
  const context = { dataDir, state, logger: { info() {}, warn(message) { process.stderr.write(message + '\n'); } } };
  let host = createEngineHost({ ctx: context, config: () => cfg });
  try {
    // A half-created venv directory must not be considered ready.
    fs.mkdirSync(path.join(dataDir, 'python', 'venv'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'engine-settings.json'), JSON.stringify({
      download: { max_video_size_mb: 8 }, translation: { enable: true },
    }));
    assert.equal(fs.existsSync(path.join(dataDir, 'engine-ready.json')), false);
    const originalNoIndex = process.env.PIP_NO_INDEX;
    try {
      process.env.PIP_NO_INDEX = '1';
      assert.equal(await host.ensure(), false);
      assert.equal(host.status().ready, false);
      assert.equal(fs.existsSync(path.join(dataDir, 'engine-ready.json')), false);
    } finally {
      if (originalNoIndex === undefined) delete process.env.PIP_NO_INDEX;
      else process.env.PIP_NO_INDEX = originalNoIndex;
    }
    assert.equal(await host.ensure(), true, JSON.stringify(host.status()));
    const effective = JSON.parse(fs.readFileSync(path.join(dataDir, 'engine-config.json')));
    assert.equal(effective.qq.maxLinksPerMessage, 2);
    assert.equal(effective.qq.cacheTtlSeconds, 120);
    assert.equal(effective.download.max_video_size_mb, 8);
    assert.equal(effective.translation.enable, false);
    assert.equal(effective.message.text_metadata.show_original_link, false);
    const first = await host.health();
    assert.equal(first.platforms, 31);
    assert.equal(host.status().dependencies.aiohttp.startsWith('3.'), true);
    assert.ok(Number(host.status().dependencies.pillow.split('.')[0]) >= 10);
    assert.equal(fs.existsSync(path.join(dataDir, 'engine-ready.json')), true);
    assert.equal((await host.platforms()).length, 31);
    const pid = first.pid;
    const instanceId = first.instanceId;
    host = createEngineHost({ ctx: { ...context, state: {} }, config: () => cfg });
    assert.equal(await host.ensure(), true);
    assert.equal((await host.health()).pid, pid);
    assert.equal(host.status().instanceId, instanceId);

    const media = path.join(host.cacheRoot, 'sending.mp4');
    fs.writeFileSync(media, 'test-media');
    await host.holdFiles([media]);
    assert.equal((await host.clean()).stats.files, 0);
    assert.equal(fs.existsSync(media), true);
    assert.equal((await host.cleanupFiles([media])).stats.files, 0);
    await host.releaseFiles([media]);
    assert.equal((await host.cleanupFiles([media])).stats.files, 1);

    assert.equal(await host.stop(), true);
    assert.equal(host.status().ready, false);
    // Remove a package while keeping python.exe: recovery must actually reinstall.
    const packageDir = process.platform === 'win32'
      ? path.join(dataDir, 'python', 'venv', 'Lib', 'site-packages', 'aiohttp')
      : path.join(dataDir, 'python', 'venv', 'lib', `python${host.status().dependencies.python.split('.').slice(0, 2).join('.')}`, 'site-packages', 'aiohttp');
    const root = fs.realpathSync(dataDir);
    const checkedPackage = fs.realpathSync(packageDir);
    assert.ok(checkedPackage.startsWith(root + path.sep));
    fs.rmSync(checkedPackage, { recursive: true, force: true });
    assert.equal(await host.ensure({ repair: true }), true, JSON.stringify(host.status()));
    assert.equal(fs.existsSync(packageDir), true);
    assert.notEqual(host.status().instanceId, instanceId);
    assert.equal(await host.restart(), true);
    assert.notEqual(host.status().instanceId, instanceId);
  } finally {
    await host.stop().catch(() => {});
    const root = fs.realpathSync(dataDir);
    assert.ok(root.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
