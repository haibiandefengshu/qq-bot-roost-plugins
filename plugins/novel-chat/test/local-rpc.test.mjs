import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  callNovelTransport, deriveQqInvocation, resolveBridgePaths, safeNovelOutputPath,
} from '../lib/local-rpc.js';
import {
  createTransportServer, readDiscovery,
} from '../../novel-writer/lib/local-transport.mjs';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'novel-chat-rpc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('native layout resolves the same fixed extension data root', (t) => {
  const dsh = tempDir(t);
  const native = join(dsh, 'roost', 'data', 'bots', 'bot-main', 'plugins', 'novel-chat');
  mkdirSync(native, { recursive: true });
  const paths = resolveBridgePaths({ dataDir: native });
  assert.equal(paths.botId, 'bot-main');
  assert.equal(paths.dataDir, join(dsh, 'extension-data', 'novel-writer'));
  assert.equal(paths.source, 'layout');

  const explicit = join(dsh, 'custom-bridge');
  const configured = resolveBridgePaths({ dataDir: native, bridgeDir: explicit });
  assert.equal(configured.dataDir, explicit);
  assert.equal(configured.botId, 'bot-main');

  assert.throws(() => resolveBridgePaths({
    dataDir: join(dsh, 'not-a-native-layout', 'novel-chat'),
  }), /布局无效/);
});

test('native client speaks the signed transport with trusted QQ identity', async (t) => {
  const dsh = tempDir(t);
  const native = join(dsh, 'roost', 'data', 'bots', 'bot-main', 'plugins', 'novel-chat');
  mkdirSync(native, { recursive: true });
  const paths = resolveBridgePaths({ dataDir: native });
  const seen = [];
  const server = createTransportServer({
    dataDir: paths.dataDir,
    handler: async ({ scope, payload, invocation }) => {
      seen.push({ scope, payload, invocation });
      return { text: 'ok' };
    },
  });
  await server.listen();
  t.after(() => server.close());
  assert.equal(readDiscovery(paths.dataDir).pid, process.pid);

  const msg = {
    kind: 'c2c',
    chatId: 'chat-1',
    userId: 'user-1',
    id: 'message-1',
    receivedAt: Date.now(),
    mentioned: false,
    traceId: 'trace-1',
  };
  const invocation = deriveQqInvocation(msg, paths.botId);
  const result = await callNovelTransport({
    dataDir: paths.dataDir,
    scope: 'qq',
    action: 'qq',
    payload: { command: '小说', args: ['书架'] },
    invocation,
  });
  assert.deepEqual(result, { text: 'ok' });
  assert.equal(seen[0].scope, 'qq');
  assert.equal(seen[0].invocation.botId, 'bot-main');
  assert.equal(seen[0].invocation.messageId, 'message-1');
  assert.equal(seen[0].invocation.eventId, 'trace-1');

  assert.throws(() => deriveQqInvocation({ ...msg, kind: 'guild' }, paths.botId), /身份不完整/);
  assert.throws(() => deriveQqInvocation(msg, ''), /身份不完整/);
});

test('native output validation resolves links before accepting a file', (t) => {
  const root = tempDir(t);
  const data = join(root, 'data');
  const outputs = join(data, 'outputs');
  const outside = join(root, 'outside');
  mkdirSync(outputs, { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, 'private.txt'), 'private');
  symlinkSync(outside, join(outputs, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(join(outputs, 'ok.txt'), 'ok');
  assert.equal(safeNovelOutputPath(data, join(outputs, 'ok.txt')), join(outputs, 'ok.txt'));
  assert.throws(() => safeNovelOutputPath(data, join(outputs, 'escape', 'private.txt')), /逃逸/);
});
