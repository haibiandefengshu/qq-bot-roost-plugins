import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  callTransport, createTransportServer, healthCheck, isPathInside,
  ownerKeyForInvocation, readDiscovery, safeOutputPath, signRequestHeaders,
  validateQqInvocation, writeDiscovery,
} from '../lib/local-transport.mjs';
import { createWorkerLeader } from '../lib/worker-leader.mjs';

function tempDir(t, prefix = 'novel-transport-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function invocation(overrides = {}) {
  return {
    source: 'qq',
    botId: 'bot-1',
    kind: 'c2c',
    chatId: 'chat-1',
    userId: 'user-1',
    messageId: `message-${randomBytes(4).toString('hex')}`,
    receivedAt: Date.now(),
    mentioned: true,
    ...overrides,
  };
}

async function signedFetch(discovery, scope, body, { nonce, timestamp } = {}) {
  const raw = Buffer.from(JSON.stringify(body));
  const headers = signRequestHeaders({
    key: discovery.keys[scope],
    body: raw,
    nonce: nonce || randomBytes(18).toString('base64url'),
    timestamp: timestamp || Date.now(),
  });
  return await fetch(`http://${discovery.host}:${discovery.port}/rpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': raw.length,
      'x-novel-scope': scope,
      ...headers,
    },
    body: raw,
  });
}

test('transport authenticates requests, scopes, replay and payloads', async (t) => {
  const dataDir = tempDir(t);
  const seen = [];
  const server = createTransportServer({
    dataDir,
    maxBodyBytes: 2048,
    handler: async ({ scope, payload, invocation: inv }) => {
      seen.push({ scope, payload, invocation: inv });
      return { echoed: payload.value, owner: inv?.source === 'qq' ? ownerKeyForInvocation(inv) : 'panel' };
    },
  });
  await server.listen();
  t.after(() => server.close());
  const discovery = readDiscovery(dataDir);

  const body = { action: 'qq', payload: { value: 7 }, invocation: invocation() };
  const first = await signedFetch(discovery, 'qq', body, { nonce: 'nonce-replay-0000000001' });
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.ok, true);
  assert.equal(firstBody.result.echoed, 7);
  assert.match(firstBody.result.owner, /^[a-f0-9]{64}$/);

  const replay = await signedFetch(discovery, 'qq', body, { nonce: 'nonce-replay-0000000001' });
  assert.equal(replay.status, 401);

  const raw = Buffer.from(JSON.stringify(body));
  const headers = signRequestHeaders({ key: discovery.keys.qq, body: raw, nonce: randomBytes(18).toString('base64url') });
  const tampered = await fetch(`http://${discovery.host}:${discovery.port}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-novel-scope': 'qq', ...headers },
    body: Buffer.from(JSON.stringify({ ...body, payload: { value: 8 } })),
  });
  assert.equal(tampered.status, 401);

  const crossScope = await signedFetch(discovery, 'qq', {
    action: 'panel', payload: {},
  });
  assert.equal(crossScope.status, 403);

  const panelBody = {
    action: 'panel',
    payload: { op: 'status' },
    invocation: { source: 'panel', ownerVerified: false, requestId: 'forged' },
  };
  const panelResponse = await signedFetch(discovery, 'panel', panelBody);
  assert.equal(panelResponse.status, 200);
  assert.equal(seen.at(-1).scope, 'panel');
  assert.equal(seen.at(-1).invocation.source, 'panel');
  assert.equal(seen.at(-1).invocation.ownerVerified, true);
  assert.match(seen.at(-1).invocation.requestId, /^panel-/);

  const invalidInvocation = await signedFetch(discovery, 'qq', {
    action: 'qq', payload: {}, invocation: { source: 'qq', botId: 'bot-1' },
  });
  assert.equal(invalidInvocation.status, 400);

  const tooLarge = await callTransport({
    dataDir,
    scope: 'qq',
    action: 'qq',
    payload: { text: 'x'.repeat(4096) },
    invocation: invocation(),
  }).then(() => null, (error) => error);
  assert.ok(tooLarge);
  assert.match(String(tooLarge.message), /过大/);
});

test('callTransport verifies signed responses and rejects unsigned ones', async (t) => {
  const dataDir = tempDir(t);
  const server = createTransportServer({
    dataDir,
    handler: async ({ action, payload }) => ({ action, value: payload.value }),
  });
  await server.listen();
  t.after(() => server.close());

  const result = await callTransport({
    dataDir,
    scope: 'panel',
    action: 'panel',
    payload: { value: 11 },
  });
  assert.deepEqual(result, { action: 'panel', value: 11 });

  const fakeDir = tempDir(t, 'novel-transport-fake-');
  writeDiscovery(fakeDir, {
    pid: process.pid,
    host: '127.0.0.1',
    port: 1,
    startedAt: Date.now(),
    keys: { qq: randomBytes(32).toString('base64url'), panel: randomBytes(32).toString('base64url') },
  });
  const fakeFetch = async () => new Response(JSON.stringify({ ok: true, result: { forged: true } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  await assert.rejects(() => callTransport({
    dataDir: fakeDir,
    scope: 'panel',
    action: 'panel',
    payload: {},
    fetchImpl: fakeFetch,
  }), /响应未通过校验/);
});

test('client never blindly retries mutations but may reconnect idempotent reads', async (t) => {
  const dataDir = tempDir(t);
  writeDiscovery(dataDir, {
    pid: process.pid,
    host: '127.0.0.1',
    port: 9,
    startedAt: Date.now(),
    keys: { qq: randomBytes(32).toString('base64url'), panel: randomBytes(32).toString('base64url') },
  });
  let calls = 0;
  const refusal = async () => {
    calls += 1;
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  };
  await assert.rejects(() => callTransport({
    dataDir,
    scope: 'qq',
    action: 'qq',
    payload: { op: 'deliver' },
    invocation: invocation(),
    fetchImpl: refusal,
  }));
  assert.equal(calls, 1);

  calls = 0;
  await assert.rejects(() => callTransport({
    dataDir,
    scope: 'panel',
    action: 'health',
    fetchImpl: refusal,
  }));
  assert.equal(calls, 2);
});

test('client refreshes discovery after a connection failure', async (t) => {
  const dataDir = tempDir(t);
  const server = createTransportServer({
    dataDir,
    handler: async () => ({ ready: true }),
  });
  await server.listen();
  t.after(() => server.close());

  let first = true;
  const result = await callTransport({
    dataDir,
    scope: 'panel',
    action: 'health',
    fetchImpl: async (url, options) => {
      if (first) {
        first = false;
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      }
      return await fetch(url, options);
    },
  });
  assert.equal(result.pid, process.pid);
});

test('server enforces handler timeout and returns a signed error', async (t) => {
  const dataDir = tempDir(t);
  const server = createTransportServer({
    dataDir,
    requestTimeoutMs: 25,
    handler: () => new Promise(() => {}),
  });
  await server.listen();
  t.after(() => server.close());

  const error = await callTransport({
    dataDir,
    scope: 'qq',
    action: 'qq',
    payload: {},
    invocation: invocation(),
    timeoutMs: 2000,
  }).then(() => null, (err) => err);
  assert.ok(error);
  assert.equal(error.status, 504);
  assert.match(error.message, /25|秒/);
});

test('QQ invocation validation and owner isolation use only trusted identity', () => {
  const valid = validateQqInvocation({
    ...invocation({ messageId: 'm-1' }),
    ownerVerified: true,
    payloadOwner: 'attacker',
  });
  assert.equal(valid.ownerVerified, undefined);
  assert.equal(valid.payloadOwner, undefined);
  assert.equal(valid.botId, 'bot-1');

  const other = validateQqInvocation(invocation({ userId: 'user-2', messageId: 'm-2' }));
  assert.notEqual(ownerKeyForInvocation(valid), ownerKeyForInvocation(other));
  assert.equal(validateQqInvocation({ ...invocation(), kind: 'guild' }), null);
  assert.equal(validateQqInvocation({ ...invocation(), receivedAt: 0 }), null);
  assert.equal(validateQqInvocation({ ...invocation(), source: 'panel' }), null);
});

test('path containment rejects traversal and cross-drive absolute relatives', (t) => {
  const dataDir = tempDir(t);
  const outputs = join(dataDir, 'outputs');
  writeFileSync(join(dataDir, 'outside.txt'), 'no');
  assert.equal(isPathInside(outputs, join(outputs, 'a.txt')), true);
  assert.equal(isPathInside(outputs, join(outputs, '..', 'outside.txt')), false);
  assert.throws(() => safeOutputPath(dataDir, join(dataDir, 'outside.txt')), /输出目录/);
  if (process.platform === 'win32') {
    assert.equal(isPathInside('E:\\novel-root', 'D:\\other-root\\x.txt'), false);
  }
});

test('only the elected worker creates the service and a follower takes over', async (t) => {
  const dataDir = tempDir(t);
  const created = [];
  const factory = async ({ dataDir: root }) => {
    created.push(root);
    return { dispose: async () => { created.push('disposed'); } };
  };
  const handler = async ({ action, payload }) => ({ action, value: payload.value });
  const first = createWorkerLeader({ dataDir, createService: factory, handler, retryMs: 20 });
  const second = createWorkerLeader({ dataDir, createService: factory, handler, retryMs: 20 });
  t.after(async () => { await second.close(); await first.close(); });

  assert.equal(await first.start(), true);
  assert.equal(await second.start(), false);
  assert.equal(first.leader, true);
  assert.equal(second.leader, false);
  assert.equal(created.length, 1);
  assert.equal(await healthCheck({ dataDir, scope: 'panel' }).then((r) => r?.pid), process.pid);

  await first.close();
  assert.equal(first.leader, false);
  assert.equal(existsSync(join(dataDir, 'bridge.json')), false);

  const deadline = Date.now() + 2000;
  while (!second.leader && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(second.leader, true);
  assert.equal(created.filter((item) => item !== 'disposed').length, 2);
  const result = await callTransport({
    dataDir,
    scope: 'panel',
    action: 'panel',
    payload: { value: 21 },
  });
  assert.deepEqual(result, { action: 'panel', value: 21 });
});

test('stale and malformed worker locks are reclaimed safely', async (t) => {
  const dataDir = tempDir(t);
  const factory = async () => ({ dispose: async () => {} });
  const handler = async () => ({ ok: true });

  writeFileSync(join(dataDir, 'worker.lock'), JSON.stringify({ pid: 999999, nonce: 'dead' }));
  const deadLeader = createWorkerLeader({ dataDir, createService: factory, handler, retryMs: 20 });
  t.after(() => deadLeader.close());
  assert.equal(await deadLeader.start(), true);
  await deadLeader.close();

  writeFileSync(join(dataDir, 'worker.lock'), '{not json');
  const old = new Date(Date.now() - 10 * 60 * 1000);
  utimesSync(join(dataDir, 'worker.lock'), old, old);
  const malformedLeader = createWorkerLeader({ dataDir, createService: factory, handler, retryMs: 20, staleMs: 1000 });
  t.after(() => malformedLeader.close());
  assert.equal(await malformedLeader.start(), true);
});

test('workspace storage resolution prefers explicit env and validates installed layout', async (t) => {
  const base = tempDir(t);
  const extensionRoot = join(base, 'extensions', 'novel-writer');
  const explicit = join(base, 'elsewhere');
  const { resolveNovelPaths } = await import('../lib/local-transport.mjs');
  const installed = resolveNovelPaths({ extensionRoot, env: {} });
  assert.equal(installed.dataDir, join(base, 'extension-data', 'novel-writer'));
  const overridden = resolveNovelPaths({
    extensionRoot,
    env: { NOVEL_WRITER_DATA_DIR: explicit, NOVEL_WRITER_DSH_DATA_DIR: join(base, 'dsh') },
  });
  assert.equal(overridden.dataDir, explicit);
  assert.equal(overridden.dshDataDir, join(base, 'dsh'));
  assert.equal(overridden.discoveryFile, join(explicit, 'bridge.json'));
});

test('discovery rejects non-loopback hosts and missing scope keys', (t) => {
  const dataDir = tempDir(t);
  writeFileSync(join(dataDir, 'bridge.json'), JSON.stringify({
    version: 1, pid: 1, host: '10.0.0.1', port: 1234,
    keys: { qq: 'a'.repeat(40), panel: 'b'.repeat(40) },
  }));
  assert.throws(() => readDiscovery(dataDir), /回环/);
  writeFileSync(join(dataDir, 'bridge.json'), JSON.stringify({
    version: 1, pid: 1, host: '127.0.0.1', port: 1234,
    keys: { qq: 'a'.repeat(40) },
  }));
  assert.throws(() => readDiscovery(dataDir), /凭据/);
});

test('tampered discovery file content is rejected', (t) => {
  const dataDir = tempDir(t);
  writeFileSync(join(dataDir, 'bridge.json'), JSON.stringify({
    version: 1, pid: 1, host: '127.0.0.1', port: 1234,
    keys: { qq: 'short', panel: 'b'.repeat(40) },
  }));
  assert.throws(() => readDiscovery(dataDir), /凭据/);
  assert.equal(readFileSync(join(dataDir, 'bridge.json'), 'utf8').includes('short'), true);
});

test('closing during asynchronous election must not publish or leak service', async (t) => {
  const dataDir = tempDir(t);
  let finishFactory;
  let disposed = false;
  const gate = new Promise((resolve) => { finishFactory = resolve; });
  const leader = createWorkerLeader({
    dataDir,
    createService: async () => { await gate; return { dispose: async () => { disposed = true; } }; },
    handler: async () => ({}),
  });
  t.after(() => leader.close());
  const starting = leader.start();
  await new Promise((resolve) => setImmediate(resolve));
  const closing = leader.close();
  const closingAgain = leader.close();
  finishFactory();
  assert.equal(closing, closingAgain);
  await Promise.all([starting, closing, closingAgain]);
  assert.equal(leader.leader, false);
  assert.equal(leader.discovery, null);
  assert.equal(disposed, true);
  assert.equal(existsSync(join(dataDir, 'bridge.json')), false);
});

test('reclamation re-reads the lock and cannot delete a replacement live owner', async (t) => {
  const dataDir = tempDir(t);
  const lock = join(dataDir, 'worker.lock');
  const deadPid = 2147483000;
  writeFileSync(lock, JSON.stringify({ pid: deadPid, nonce: 'stale' }));
  let injected = false;
  let created = 0;
  const leader = createWorkerLeader({
    dataDir,
    isAlive: (pid) => {
      if (pid === deadPid && !injected) {
        injected = true;
        writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: 'replacement-live-owner' }));
        return false;
      }
      return pid === process.pid;
    },
    createService: async () => { created += 1; return {}; },
    handler: async () => ({}),
  });
  t.after(() => leader.close());
  assert.equal(await leader.start(), false);
  assert.equal(created, 0);
  await leader.close();
  assert.equal(readFileSync(lock, 'utf8').includes('replacement-live-owner'), true);
});

test('safe output validation rejects a directory junction escape', (t) => {
  const root = tempDir(t);
  const data = join(root, 'data');
  const outputs = join(data, 'outputs');
  const outside = join(root, 'outside');
  mkdirSync(outputs, { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, 'private.txt'), 'private');
  symlinkSync(outside, join(outputs, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => safeOutputPath(data, join(outputs, 'escape', 'private.txt')), /逃逸/);
});

test('failed election schedules a recoverable retry while open', async (t) => {
  const dataDir = tempDir(t);
  let attempts = 0;
  const leader = createWorkerLeader({
    dataDir,
    retryMs: 20,
    createService: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient startup failure');
      return { dispose: async () => {} };
    },
    handler: async () => ({ ok: true }),
  });
  t.after(() => leader.close());
  assert.equal(await leader.start(), false);
  const deadline = Date.now() + 2000;
  while (!leader.leader && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(leader.leader, true);
  assert.equal(attempts, 2);
});

test('server rejects query strings and non-loopback binding', async (t) => {
  assert.throws(() => createTransportServer({
    dataDir: tempDir(t),
    host: '0.0.0.0',
    handler: async () => ({}),
  }), /127\.0\.0\.1/);
  const dataDir = tempDir(t);
  const server = createTransportServer({ dataDir, handler: async () => ({}) });
  await server.listen();
  t.after(() => server.close());
  const discovery = readDiscovery(dataDir);
  const response = await fetch(`http://${discovery.host}:${discovery.port}/rpc?x=1`, {
    method: 'POST',
    body: '{}',
  });
  assert.equal(response.status, 404);
});

test('bounded shutdown aborts pending work before releasing ownership', async (t) => {
  const dataDir = tempDir(t);
  const server = createTransportServer({
    dataDir,
    requestTimeoutMs: 30_000,
    handler: () => new Promise(() => {}),
  });
  await server.listen();
  t.after(() => server.close());
  const pending = callTransport({
    dataDir,
    scope: 'qq',
    action: 'qq',
    payload: {},
    invocation: invocation(),
    timeoutMs: 20_000,
  }).catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const started = Date.now();
  await server.close({ timeoutMs: 100 });
  assert.ok(Date.now() - started < 1000);
  assert.equal(existsSync(join(dataDir, 'bridge.json')), false);
  const error = await pending;
  assert.ok(error instanceof Error);
});

test('separate processes contending for one stale lock create at most one service', async (t) => {
  const dataDir = tempDir(t);
  const createdFile = join(dataDir, 'created.log');
  writeFileSync(join(dataDir, 'worker.lock'), JSON.stringify({ pid: 2147483000, nonce: 'stale' }));
  const leaderUrl = new URL('../lib/worker-leader.mjs', import.meta.url).href;
  const source = `
    import { appendFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { createWorkerLeader } from ${JSON.stringify(leaderUrl)};
    const root = process.argv[1];
    const worker = createWorkerLeader({
      dataDir: root,
      createService: async () => {
        appendFileSync(join(root, 'created.log'), process.pid + '\\n');
        return { dispose: async () => {} };
      },
      handler: async () => ({ ok: true }),
      retryMs: 50,
    });
    const won = await worker.start();
    console.log(JSON.stringify({ pid: process.pid, won }));
    if (won) await new Promise(resolve => setTimeout(resolve, 1200));
    await worker.close();
    process.exit(0);
  `;
  const runChild = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, dataDir], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('child timeout')); }, 8000);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr || `child exit ${code}`));
      try { resolve(JSON.parse(stdout.trim().split(/\r?\n/).at(-1))); }
      catch (error) { reject(new Error(`bad child output: ${stdout}\n${stderr}`)); }
    });
  });
  const results = await Promise.all(Array.from({ length: 4 }, runChild));
  assert.equal(results.filter((item) => item.won).length, 1);
  const created = readFileSync(createdFile, 'utf8').split(/\r?\n/).filter(Boolean);
  assert.equal(created.length, 1);
});
