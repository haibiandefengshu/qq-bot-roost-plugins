import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createEngineHost, credentialSecretConfig, ENGINE_VERSION, ORIGINAL_ARCHIVE_SHA256, parseEngineUrl,
  readSafeTarGz, SERVICE_ID,
} from '../engine-host.js';

const pluginDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const token = 't'.repeat(64);
const instanceId = '12345678-1234-1234-1234-123456789abc';
const fixtureDirs = [];

function directory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-media-engine-test-'));
  fixtureDirs.push(root);
  return root;
}

function sourceHash() {
  const files = readSafeTarGz(fs.readFileSync(path.join(pluginDir, 'engine.tar.gz')));
  const overlay = (dir, prefix) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (item.name === '__pycache__' || item.name === 'tests') continue;
      if (item.isDirectory()) overlay(path.join(dir, item.name), `${prefix}/${item.name}`);
      else if (item.name.endsWith('.py')) files.set(`${prefix}/${item.name}`, fs.readFileSync(path.join(dir, item.name)));
    }
  };
  overlay(path.join(pluginDir, 'engine', 'service'), 'service');
  files.set('run_engine.py', fs.readFileSync(path.join(pluginDir, 'engine', 'run_engine.py')));
  files.set('config.example.json', fs.readFileSync(path.join(pluginDir, 'engine', 'config.example.json')));
  const hash = crypto.createHash('sha256');
  for (const name of [...files.keys()].sort()) {
    if (!name.endsWith('.py') && !['requirements.txt', 'config.example.json', 'LICENSE', 'README.md'].includes(path.posix.basename(name))) continue;
    hash.update(`${name}\0`).update(files.get(name)).update('\0');
  }
  return hash.digest('hex');
}

function archive(name, type = 48) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  for (const [offset, length, value] of [[100, 8, '0000644'], [108, 8, '0000000'], [116, 8, '0000000'], [124, 12, '00000000000'], [136, 12, '00000000000']]) {
    header.write(value, offset, length - 1, 'ascii');
  }
  header.fill(32, 148, 156);
  header[156] = type;
  const checksum = header.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0');
  header.write(`${checksum}\0 `, 148, 8, 'ascii');
  return zlib.gzipSync(Buffer.concat([header, Buffer.alloc(1024)]));
}

async function server(handler) {
  const service = http.createServer(handler);
  await new Promise((resolve) => service.listen(0, '127.0.0.1', resolve));
  return {
    service,
    url: `http://127.0.0.1:${service.address().port}`,
    close: () => new Promise((resolve) => {
      service.closeAllConnections();
      service.close(resolve);
    }),
  };
}

function context(dataDir, state = {}) {
  return { dataDir, state, logger: { warn() {}, info() {} } };
}

function json(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

test.after(() => {
  for (const root of fixtureDirs) {
    const absolute = fs.realpathSync(root);
    assert.ok(absolute.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
    fs.rmSync(absolute, { recursive: true, force: true });
  }
});

test('the original archive and every vendor file remain byte identical', () => {
  const bytes = fs.readFileSync(path.join(pluginDir, 'engine.tar.gz'));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), ORIGINAL_ARCHIVE_SHA256);
  const files = readSafeTarGz(bytes);
  assert.equal(files.size, 119);
  for (const [name, value] of files) {
    if (name.startsWith('vendor/')) assert.deepEqual(fs.readFileSync(path.join(pluginDir, 'engine', ...name.split('/'))), value, name);
  }
});

test('archive reader rejects path traversal, links, drive paths and bad checksums', () => {
  for (const name of ['../escape.py', '/tmp/escape.py', 'C:/escape.py', 'x\\escape.py', 'x/../escape.py', 'aux.py']) {
    assert.throws(() => readSafeTarGz(archive(name)), /Unsafe path/);
  }
  assert.throws(() => readSafeTarGz(archive('link', 50)), /link or special/);
  const invalid = zlib.gunzipSync(archive('normal.py'));
  invalid[0] ^= 1;
  assert.throws(() => readSafeTarGz(zlib.gzipSync(invalid)), /checksum/);
  assert.throws(() => readSafeTarGz(zlib.gzipSync(Buffer.alloc(100))), /terminator/);
});

test('only literal HTTP loopback engine URLs are accepted', () => {
  assert.equal(parseEngineUrl('http://127.0.0.1:3199').port, 3199);
  assert.equal(parseEngineUrl('http://[::1]:3199').host, '::1');
  for (const value of ['http://localhost:3199', 'https://127.0.0.1', 'http://127.0.0.1/a', 'http://user:p@127.0.0.1', 'http://169.254.169.254', 'http://192.168.1.1']) {
    assert.throws(() => parseEngineUrl(value), /loopback/);
  }
});

test('a JSON service on the configured port is a conflict and is never stopped', async () => {
  let posts = 0;
  const fixture = await server((request, response) => {
    if (request.method === 'POST') posts++;
    json(response, { ok: true, version: ENGINE_VERSION });
  });
  try {
    const host = createEngineHost({ ctx: context(directory()), config: () => ({ engineUrl: fixture.url }) });
    assert.equal(await host.ensure(), false);
    assert.match(host.status().lastError, /occupied.*unverified/);
    assert.equal(await host.stop(), false);
    assert.equal(posts, 0);
    assert.equal(host.status().ready, false);
  } finally { await fixture.close(); }
});

test('external requests verify identity, authenticate, propagate deadline and cancel server work', async () => {
  const dataDir = directory();
  const cache = path.join(dataDir, 'external-cache');
  fs.mkdirSync(cache);
  fs.writeFileSync(path.join(dataDir, 'credentials.json'), JSON.stringify({ engineToken: token }));
  const identities = { serviceId: SERVICE_ID, version: ENGINE_VERSION, instanceId, sourceHash: sourceHash(), pid: process.pid, cacheDir: cache };
  let cancelled = 0;
  let parsed;
  const fixture = await server(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    if (request.url === '/health') return json(response, { ok: true, ...identities, platforms: 31 });
    if (request.url === '/platforms') return json(response, { ok: true, platforms: [{ name: 'bilibili' }] });
    const payload = await body(request);
    if (request.url === '/cancel') {
      cancelled++;
      return json(response, { ok: true, cancelled: true });
    }
    if (request.url === '/parse') {
      parsed = payload;
      if (payload.text === 'slow') return;
      return json(response, { ok: true, plan: { messages: [] }, links: [payload.text] });
    }
    return json(response, { ok: true });
  });
  try {
    const cfg = { engineMode: 'external', engineUrl: fixture.url, externalCacheRoot: cache };
    const host = createEngineHost({ ctx: context(dataDir), config: () => cfg });
    assert.equal(await host.ensure(), true);
    assert.equal(host.status().phase, 'external');
    assert.equal(host.status().platformCount, 31);
    assert.deepEqual(await host.platforms(), [{ name: 'bilibili' }]);
    const deadlineAt = Date.now() + 3000;
    const result = await host.parse({ text: 'https://www.bilibili.com/video/BV1234567890' }, { deadlineAt });
    assert.equal(result.links.length, 1);
    assert.equal(parsed.deadlineAt, deadlineAt);
    assert.match(parsed.taskId, /^[a-f0-9-]{36}$/);
    identities.translation = true;
    assert.equal(await host.health(), null);
    await assert.rejects(host.parse({ text: 'must-not-translate' }), { code: 'ENGINE_NOT_READY' });
    assert.notEqual(parsed.text, 'must-not-translate');
    identities.translation = false;
    await assert.rejects(host.parse({ text: 'slow' }, { deadlineAt: Date.now() + 80 }), { code: 'ENGINE_DEADLINE' });
    assert.equal(cancelled, 1);
    assert.equal(await host.stop(), false);
    assert.equal(JSON.stringify(host.status()).includes(token), false);
  } finally { await fixture.close(); }
});

test('an interrupted parse is never replayed and would not download the same media twice', async () => {
  const dataDir = directory();
  const cache = path.join(dataDir, 'external-cache');
  fs.mkdirSync(cache);
  fs.writeFileSync(path.join(dataDir, 'credentials.json'), JSON.stringify({ engineToken: token }));
  const identities = {
    serviceId: SERVICE_ID, version: ENGINE_VERSION, instanceId,
    sourceHash: sourceHash(), pid: process.pid, cacheDir: cache,
  };
  let parseRequests = 0;
  const fixture = await server(async (request, response) => {
    if (request.url === '/health') return json(response, { ok: true, ...identities, platforms: 31 });
    await body(request);
    if (request.url === '/parse') {
      parseRequests += 1;
      request.socket.destroy();
      return;
    }
    if (request.url === '/cancel') return json(response, { ok: true, cancelled: true });
    return json(response, { ok: true });
  });
  try {
    const host = createEngineHost({
      ctx: context(dataDir),
      config: () => ({ engineMode: 'external', engineUrl: fixture.url, externalCacheRoot: cache }),
    });
    assert.equal(await host.ensure(), true);
    await assert.rejects(
      host.parse({ text: 'https://www.bilibili.com/video/BV1234567890' }, { deadlineAt: Date.now() + 3000 }),
      { code: 'ENGINE_INTERRUPTED' },
    );
    assert.equal(parseRequests, 1);
  } finally { await fixture.close(); }
});

test('healthy recorded managed instances survive new host objects and shutdown requires matching ownership', async () => {
  const dataDir = directory();
  const cache = path.join(dataDir, 'cache');
  fs.mkdirSync(cache);
  let shutdowns = 0;
  const identities = { serviceId: SERVICE_ID, version: ENGINE_VERSION, instanceId, sourceHash: sourceHash(), pid: process.pid, cacheDir: cache };
  const fixture = await server(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    if (request.url === '/health') return json(response, { ok: true, ...identities, platforms: 31 });
    if (request.url === '/shutdown') {
      const payload = await body(request);
      assert.equal(payload.instanceId, instanceId);
      assert.equal(payload.sourceHash, identities.sourceHash);
      shutdowns++;
      json(response, { ok: true });
      setTimeout(() => fixture.service.close(), 30);
    }
  });
  fs.writeFileSync(path.join(dataDir, 'engine-instance.json'), JSON.stringify({
    ...identities, token, url: fixture.url, cacheRoot: cache,
  }));
  try {
    const first = createEngineHost({ ctx: context(dataDir), config: () => ({ engineUrl: fixture.url }) });
    assert.equal(await first.ensure(), true);
    assert.equal(fs.existsSync(path.join(dataDir, 'python')), false);
    const reloaded = createEngineHost({ ctx: context(dataDir), config: () => ({ engineUrl: fixture.url }) });
    assert.equal(await reloaded.ensure(), true);
    assert.equal(reloaded.status().instanceId, first.status().instanceId);
    // A changed local translation toggle must never prevent stopping our own service.
    identities.translation = true;
    assert.equal(await reloaded.stop(), true);
    assert.equal(shutdowns, 1);
  } finally { await fixture.close(); }
});

test('credential merge keeps the canonical root Bili cookie alongside upstream secrets', () => {
  const merged = credentialSecretConfig({
    engineToken: 'ENGINE-PRIVATE',
    engine: { token: 'ENGINE-TOKEN' },
    bilibili_enhanced: { cookie: 'ROOT-COOKIE', use_cookie: true },
    pixiv: { cookie: 'PIXIV-COOKIE' },
    upstream: {
      bilibili_enhanced: { cookie: 'NESTED-STALE', other_field: 2 },
      other_platform: { token: 'UPSTREAM-TOKEN' },
    },
  });
  assert.equal(merged.bilibili_enhanced.cookie, 'ROOT-COOKIE');
  assert.equal(merged.bilibili_enhanced.use_cookie, true);
  assert.equal(merged.bilibili_enhanced.other_field, 2);
  assert.equal(merged.pixiv.cookie, 'PIXIV-COOKIE');
  assert.equal(merged.other_platform.token, 'UPSTREAM-TOKEN');
  assert.equal('engineToken' in merged, false);
  assert.equal('engine' in merged, false);
  assert.equal('upstream' in merged, false);
});

test('a recorded PID does not authorize stopping a mismatched instance', async () => {
  const dataDir = directory();
  const cache = path.join(dataDir, 'cache');
  fs.mkdirSync(cache);
  let shutdowns = 0;
  const fixture = await server((request, response) => {
    if (request.method === 'POST') shutdowns++;
    json(response, {
      ok: true, serviceId: SERVICE_ID, version: ENGINE_VERSION, instanceId: crypto.randomUUID(),
      sourceHash: sourceHash(), pid: process.pid, cacheDir: cache,
    });
  });
  fs.writeFileSync(path.join(dataDir, 'engine-instance.json'), JSON.stringify({
    serviceId: SERVICE_ID, version: ENGINE_VERSION, instanceId, sourceHash: sourceHash(),
    token, url: fixture.url, cacheRoot: cache, pid: process.pid,
  }));
  try {
    const host = createEngineHost({ ctx: context(dataDir), config: () => ({ engineUrl: fixture.url }) });
    assert.equal(await host.ensure(), false);
    assert.equal(await host.stop(), false);
    assert.equal(shutdowns, 0);
  } finally { await fixture.close(); }
});
