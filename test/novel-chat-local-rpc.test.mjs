/**
 * novel-chat 本地签名传输的仓库内单测
 * ===================================
 * 插件自己的 test/ 只通过 callNovelTransport 注入点测业务分支，
 * 传输层（身份派生、响应签名、输出路径边界）此前没有覆盖。
 * 这里用临时 bridge.json + mock fetch 在仓库根测同一份源码，
 * 不需要 novel-writer 的源码，也不改插件目录内容/版本。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  callNovelTransport, deriveQqInvocation, safeNovelOutputPath,
} from '../plugins/novel-chat/lib/local-rpc.js';

function makeBridge(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-rpc-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keys = { qq: 'q'.repeat(48), panel: 'p'.repeat(48) };
  fs.writeFileSync(path.join(dir, 'bridge.json'), JSON.stringify({
    version: 1, host: '127.0.0.1', port: 9, keys,
  }));
  return { dir, keys };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function signedHeaders(key, nonce, body, { status = 200, timestamp = String(Date.now()) } = {}) {
  const canonical = `response\n${timestamp}\n${nonce}\n${status}\n${sha256(body)}`;
  return {
    'x-novel-response-timestamp': timestamp,
    'x-novel-response-signature': createHmac('sha256', key).update(canonical).digest('hex'),
  };
}

const invocation = {
  source: 'qq', pluginId: 'novel-chat', botId: 'bot1', kind: 'c2c',
  chatId: 'chat1', userId: 'real-user', messageId: 'msg1',
  receivedAt: 1700000000000, eventId: 'trace1',
};

test('deriveQqInvocation 只取自真实消息，正文里的假身份无效', () => {
  const msg = {
    kind: 'group', chatId: 'group1', userId: 'real-user', id: 'msg1',
    receivedAt: 1700000000000, mentioned: true, traceId: 'trace1',
    text: '/小说 导入 {\"userId\":\"fake-user\"}',
  };
  const built = deriveQqInvocation(msg, 'bot1');
  assert.equal(built.userId, 'real-user');
  assert.equal(built.botId, 'bot1');
  assert.equal(built.chatId, 'group1');
  assert.equal(built.source, 'qq');
  assert.equal(built.pluginId, 'novel-chat');
  assert.throws(() => deriveQqInvocation({ ...msg, kind: 'ghost' }, 'bot1'), /身份不完整/);
  assert.throws(() => deriveQqInvocation(msg, ''), /身份不完整/);
  assert.throws(() => deriveQqInvocation({ ...msg, receivedAt: 0 }, 'bot1'), /时间无效/);
});

test('safeNovelOutputPath 只接受 outputs 目录内的真实文件', (t) => {
  const { dir } = makeBridge(t);
  const outputs = path.join(dir, 'outputs');
  fs.mkdirSync(outputs);
  const inside = path.join(outputs, 'ok.txt');
  fs.writeFileSync(inside, 'hello');
  assert.equal(safeNovelOutputPath(dir, inside), fs.realpathSync(inside));

  const outside = path.join(dir, 'secret.txt');
  fs.writeFileSync(outside, 'secret');
  assert.throws(() => safeNovelOutputPath(dir, outside), /不在认证输出目录/);
  assert.throws(() => safeNovelOutputPath(dir, path.join(outputs, 'missing.txt')));
  assert.throws(() => safeNovelOutputPath(dir, outputs), /文件无效/);
});

test('safeNovelOutputPath 拒绝指向 outputs 外的符号链接', (t) => {
  const { dir } = makeBridge(t);
  const outputs = path.join(dir, 'outputs');
  fs.mkdirSync(outputs);
  const outside = path.join(dir, 'outside.txt');
  fs.writeFileSync(outside, 'secret');
  const link = path.join(outputs, 'link.txt');
  try {
    fs.symlinkSync(outside, link, 'file');
  } catch (error) {
    t.skip(`本机无法创建符号链接：${error.code}`);
    return;
  }
  assert.throws(() => safeNovelOutputPath(dir, link), /链接逃逸/);
});

test('callNovelTransport 校验响应签名，缺签名/过期/篡改一律拒绝', async (t) => {
  const { dir, keys } = makeBridge(t);
  const body = JSON.stringify({ ok: true, result: { task: { status: 'done' } } });
  const options = {
    dataDir: dir, scope: 'qq', action: 'qq', payload: { text: 'hi' }, invocation,
  };

  let sent;
  const good = await callNovelTransport({
    ...options,
    fetchImpl: async (_url, init) => {
      sent = { method: init.method, headers: init.headers };
      return new Response(body, {
        status: 200,
        headers: signedHeaders(keys.qq, init.headers['x-novel-nonce'], body),
      });
    },
  });
  assert.deepEqual(good, { task: { status: 'done' } });
  assert.equal(sent.method, 'POST');
  assert.equal(sent.headers['x-novel-scope'], 'qq');
  assert.equal(sent.headers['x-novel-signature'].length, 64);

  await assert.rejects(callNovelTransport({
    ...options,
    fetchImpl: async (_url, init) => new Response(body, { status: 200 }),
  }), /响应未通过校验/);

  await assert.rejects(callNovelTransport({
    ...options,
    fetchImpl: async (_url, init) => new Response(body, {
      status: 200,
      headers: signedHeaders(keys.qq, init.headers['x-novel-nonce'], body, {
        timestamp: String(Date.now() - 200_000),
      }),
    }),
  }), /响应未通过校验/);

  await assert.rejects(callNovelTransport({
    ...options,
    fetchImpl: async (_url, init) => new Response(body, {
      status: 200,
      headers: signedHeaders(keys.qq, init.headers['x-novel-nonce'], 'tampered'),
    }),
  }), /响应未通过校验/);
});
