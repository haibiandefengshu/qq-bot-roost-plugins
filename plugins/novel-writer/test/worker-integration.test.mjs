import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createActions } from '../actions-v1.mjs';
import { callTransport, healthCheck } from '../lib/local-transport.mjs';
import { NovelService } from '../lib/service.mjs';
import { createNovelChatPlugin } from '../../novel-chat/index.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(TEST_DIR);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, { timeout = 15_000, interval = 60, message = '等待超时' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(message);
}

function installFixture(t) {
  const dsh = mkdtempSync(join(tmpdir(), 'novel-worker-integration-'));
  const extension = join(dsh, 'extensions', 'novel-writer');
  mkdirSync(extension, { recursive: true });
  for (const name of ['server.mjs', 'actions-v1.mjs', 'plugin.json']) {
    copyFileSync(join(PLUGIN_ROOT, name), join(extension, name));
  }
  // filter 强制走 JavaScript 目录遍历，避开 Node22 Windows 优化目录复制的 EIO。
  cpSync(join(PLUGIN_ROOT, 'lib'), join(extension, 'lib'), { recursive: true, filter: () => true });
  const fixture = {
    dsh,
    extension,
    dataDir: join(dsh, 'extension-data', 'novel-writer'),
    resources: [],
    closed: false,
    defer(close) { this.resources.push(close); },
  };
  fixture.cleanup = async () => {
    if (fixture.closed) return;
    fixture.closed = true;
    for (const close of fixture.resources.reverse()) {
      try { await close(); } catch {}
    }
    rmSync(dsh, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  t.after(fixture.cleanup);
  return fixture;
}

function nativeDirFor(dsh, botId = 'bot-main') {
  const native = join(dsh, 'roost', 'data', 'bots', botId, 'plugins', 'novel-chat');
  mkdirSync(native, { recursive: true });
  return native;
}

async function startFakeApi(t, fixture = null) {
  const requests = [];
  const sockets = new Set();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    requests.push({ method: req.method, path: url.pathname });
    let body = { ok: true };
    if (url.pathname === '/v1/config') {
      body = {
        ok: true,
        config: {
          model: { default: { provider: 'fixture', model: 'fixture-writer' } },
          tts: {
            enabled: true,
            provider: 'edge',
            voice: 'fixture-voice',
            speed: 1.25,
            maxChars: 120,
          },
        },
      };
    } else if (url.pathname === '/v1/agent.new') {
      const parsed = JSON.parse(raw || '{}');
      body = { ok: true, sessionId: parsed.sessionId };
    } else if (url.pathname === '/v1/agent.prompt') {
      const parsed = JSON.parse(raw || '{}');
      const text = String(parsed.text || '');
      if (text.includes('只输出 JSON：{"summary"')) {
        body = {
          ok: true,
          text: JSON.stringify({
            summary: '主角在长街发现线索，并决定继续追查来源。',
            states: ['主角：保持警惕'],
          }),
        };
      } else {
        body = {
          ok: true,
          text: JSON.stringify({
            chapterTitle: '第一章 夜行',
            body: '主角沿着夜色中的长街前进，发现新的线索并决定继续调查。'.repeat(150),
            summary: '主角在长街发现线索并继续调查。',
            states: ['长街：线索已登记'],
          }),
        };
      }
    } else if (url.pathname === '/v1/tts') {
      body = {
        ok: true,
        audio: Buffer.from('fake-audio').toString('base64'),
        contentType: 'audio/mpeg',
        bytes: 10,
      };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    server.closeAllConnections?.();
    await Promise.race([
      new Promise((resolve) => server.close(() => resolve())),
      sleep(2000),
    ]);
  };
  t.after(close);
  fixture?.defer(close);
  const address = server.address();
  return { url: `http://127.0.0.1:${address.port}/v1`, requests, close };
}

function spawnMcp(t, { extension, env = {}, fixture = null }) {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: extension,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stderr = [];
  let buffer = '';
  let sequence = 0;
  let exited = false;
  const pending = new Map();
  const exit = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      for (const row of pending.values()) {
        clearTimeout(row.timer);
        row.reject(new Error(`MCP 已退出：${code ?? signal}`));
      }
      pending.clear();
      resolve({ code, signal });
    });
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const row = pending.get(message.id);
      if (!row) continue;
      pending.delete(message.id);
      clearTimeout(row.timer);
      row.resolve(message);
    }
  });

  function request(method, params = {}) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      if (exited) return reject(new Error('MCP 已退出'));
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP 请求超时：${method}`));
      }, 5000);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async function close() {
    if (exited) return await exit;
    try { child.stdin.end(); } catch {}
    const ended = await Promise.race([exit, sleep(5000).then(() => null)]);
    if (ended) return ended;
    await forceClose();
    return null;
  }

  let forceClosed = false;
  async function forceClose() {
    if (forceClosed) return;
    forceClosed = true;
    if (!exited) {
      try { child.stdin.end(); } catch {}
      await Promise.race([exit, sleep(1500).then(() => null)]);
    }
    if (!exited) {
      try { child.kill(); } catch {}
      await Promise.race([exit, sleep(1500).then(() => null)]);
    }
    if (!exited) {
      try { child.kill('SIGKILL'); } catch {}
      await Promise.race([exit, sleep(800).then(() => null)]);
    }
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      try { stream?.destroy(); } catch {}
    }
  }

  t.after(forceClose);
  fixture?.defer(forceClose);

  return {
    child,
    stderr,
    request,
    close,
    forceClose,
    get exited() { return exited; },
  };
}

function nativeHarness(dsh, botId = 'bot-main') {
  const dataDir = nativeDirFor(dsh, botId);
  const replies = [];
  const repliesNow = [];
  let commandHandler;
  let messageHandler;
  let teardown;
  let sequence = 0;
  const files = new Map();
  const ctx = {
    dataDir,
    config: { enabled: true },
    command(_name, _options, handler) { commandHandler = handler; },
    on(event, handler) { if (event === 'message') messageHandler = handler; },
    menu() {},
    onTeardown(handler) { teardown = handler; },
  };
  const plugin = createNovelChatPlugin();
  plugin.setup(ctx);

  function message({ args = [], command = false, text = '', userId = 'user-a' } = {}) {
    const id = `message-${++sequence}`;
    return {
      id,
      kind: 'c2c',
      chatId: 'chat-main',
      userId,
      traceId: `trace-${id}`,
      isCommand: command,
      mentioned: false,
      receivedAt: Date.now(),
      args,
      files: [],
      content: text || (command ? `/小说 ${args.join(' ')}` : '普通消息'),
      claim() {},
      async reply(value) { replies.push(String(value)); },
      async replyNow(value) { repliesNow.push(String(value)); },
      async replyFile(path, options = {}) {
        files.set(path, options);
        return { ok: true, state: 'sent', id: `sent-${files.size}` };
      },
    };
  }

  return {
    replies,
    repliesNow,
    files,
    message,
    runCommand: (msg) => commandHandler(msg),
    runDirect: (msg) => messageHandler(msg),
    close: () => teardown?.(),
  };
}

async function createBook(native, title, userId = 'user-a') {
  assert.equal(await native.runCommand(native.message({
    command: true, args: ['新建', title], userId,
  })), true);
  for (const text of ['核心故事', '跳过', '跳过', '跳过', '跳过', '否', '跳过', '确认']) {
    assert.equal(await native.runDirect(native.message({ text, userId })), true);
  }
}

async function waitWorker(dataDir, pid) {
  return await waitFor(async () => {
    const health = await healthCheck({ dataDir, scope: 'panel', timeoutMs: 500 });
    return health?.pid === pid ? health : null;
  }, { message: `等待 MCP 进程 ${pid} 成为小说 worker 超时` });
}

async function panel(dataDir, payload) {
  return await callTransport({
    dataDir,
    scope: 'panel',
    action: 'panel',
    payload,
    timeoutMs: 30_000,
  });
}

async function waitWriteTask(dataDir, ownerId) {
  return await waitFor(async () => {
    const result = await panel(dataDir, { op: 'tasks', ownerId });
    const task = result?.data?.tasks?.find((item) => item.kind === 'write');
    if (!task) return null;
    return ['done', 'error', 'cancelled', 'conflict', 'interrupted'].includes(task.status)
      ? task : null;
  }, { message: '等待续写任务结束超时' });
}

test('QQ 在面板动作前访问 worker；面板 CRUD、大章节与 owner 隔离共用同一存储', { timeout: 90_000 }, async (t) => {
  const fixture = installFixture(t);
  const api = await startFakeApi(t, fixture);
  const mcp = spawnMcp(t, {
    extension: fixture.extension,
    fixture,
    env: {
      ROOST_API_URL: api.url,
      ROOST_API_TOKEN: 'fixture-token',
    },
  });
  const initialized = await mcp.request('initialize', {});
  assert.equal(initialized.result.serverInfo.name, 'novel-writer');
  const listed = await mcp.request('tools/list', {});
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['novel_help', 'novel_capabilities']);
  await waitWorker(fixture.dataDir, mcp.child.pid);

  let legacyTouches = 0;
  const legacyRuntime = new Proxy({ version: 1 }, {
    get(target, property) {
      legacyTouches += 1;
      return Reflect.get(target, property);
    },
  });
  const actions = createActions({
    novelRuntime: legacyRuntime,
    env: {
      ...process.env,
      NOVEL_WRITER_DATA_DIR: fixture.dataDir,
      ROOST_API_URL: api.url,
      ROOST_API_TOKEN: 'test-token',
    },
  });
  const proxied = await actions.panel({ op: 'books' });
  assert.equal(proxied.handled, true);
  assert.equal(proxied.ok, true);
  assert.equal(legacyTouches, 0);

  const native = nativeHarness(fixture.dsh);
  try {
    assert.equal(await native.runCommand(native.message({ command: true, args: ['书架'] })), true);
    assert.match(native.replies.at(-1), /书架还是空的/);

    await createBook(native, '集成测试小说');
    const books = await panel(fixture.dataDir, { op: 'books' });
    assert.equal(books.ok, true);
    assert.equal(books.data.books.length, 1);
    assert.equal(books.data.books[0].title, '集成测试小说');
    const ownerId = books.data.selectedOwnerId;
    const bookId = books.data.books[0].id;

    assert.equal(await native.runCommand(native.message({
      command: true, args: ['续写', '1章'],
    })), true);
    const task = await waitWriteTask(fixture.dataDir, ownerId);
    assert.equal(task.status, 'done', task.error || task.notice);

    const chapter = await panel(fixture.dataDir, { op: 'chapter', ownerId, bookId, chapterNo: 1 });
    assert.equal(chapter.ok, true);
    assert.equal(chapter.data.currentVersion, 1);
    assert.match(chapter.data.body, /长街/);
    assert.ok(api.requests.some((row) => row.path === '/v1/agent.prompt'));

    const persona = await panel(fixture.dataDir, {
      op: 'savePersona',
      ownerId,
      bookId,
      persona: { name: '林岚', identity: '记者', secret: '她保留了一份旧录音' },
    });
    assert.equal(persona.ok, true);
    assert.equal(persona.data.personas[0].name, '林岚');

    const large = '大'.repeat(400_000);
    const saved = await panel(fixture.dataDir, {
      op: 'saveChapter',
      ownerId,
      bookId,
      chapterNo: 1,
      expectedVersion: chapter.data.currentVersion,
      title: '第一章 大章节',
      body: large,
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.data.chapter.currentVersion, 2);
    assert.equal(saved.data.chapter.body.length, large.length);

    const reread = await panel(fixture.dataDir, { op: 'chapter', ownerId, bookId, chapterNo: 1 });
    assert.equal(reread.data.currentVersion, 2);
    assert.equal(reread.data.body, large);
    assert.equal(native.files.size, 0);

    assert.equal(await native.runCommand(native.message({
      command: true, args: ['书架'], userId: 'user-b',
    })), true);
    assert.match(native.replies.at(-1), /书架还是空的/);
    assert.equal(await native.runCommand(native.message({
      command: true, args: ['书架'], userId: 'user-a',
    })), true);
    assert.match(native.replies.at(-1), /集成测试小说/);
  } finally {
    native.close();
  }
});

test('两个真实 MCP 进程共享数据目录，领导者退出后幸存者接管并保留私人书库', { timeout: 60_000 }, async (t) => {
  const fixture = installFixture(t);
  const api = await startFakeApi(t, fixture);
  const env = {
    ROOST_API_URL: api.url,
    ROOST_API_TOKEN: 'fixture-token',
  };
  const first = spawnMcp(t, { extension: fixture.extension, env, fixture });
  const second = spawnMcp(t, { extension: fixture.extension, env, fixture });

  await first.request('initialize', {});
  await second.request('initialize', {});
  await waitWorker(fixture.dataDir, first.child.pid);

  const native = nativeHarness(fixture.dsh);
  try {
    await createBook(native, '接管保留书');
  } finally {
    native.close();
  }

  await sleep(500);
  const before = await healthCheck({ dataDir: fixture.dataDir, scope: 'panel', timeoutMs: 500 });
  assert.equal(before.pid, first.child.pid);

  await first.close();
  await waitFor(() => first.exited, { timeout: 5000, message: '第一个 MCP 未退出' });
  await waitWorker(fixture.dataDir, second.child.pid);

  const books = await panel(fixture.dataDir, { op: 'books' });
  assert.equal(books.ok, true);
  assert.equal(books.data.books.length, 1);
  assert.equal(books.data.books[0].title, '接管保留书');

  await second.close();
});

test('service shutdown 将运行任务保留为 interrupted、停止 pump 且不清空成果', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'novel-service-shutdown-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let modelStartedResolve;
  const modelStarted = new Promise((resolve) => { modelStartedResolve = resolve; });
  const runtime = {
    version: 1,
    dataDir: root,
    ffmpegBinary: () => '',
    model: {
      status: () => ({ configured: true }),
      async generate({ signal }) {
        modelStartedResolve();
        await new Promise((resolve, reject) => {
          if (signal?.aborted) {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            return;
          }
          signal?.addEventListener?.('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          }, { once: true });
        });
      },
    },
    voice: {
      async listSources() {
        return { official: { configured: false }, extension: { configured: false, profiles: [] } };
      },
    },
    artifacts: {
      async register() { throw new Error('unexpected artifact'); },
      resolve() { throw new Error('unexpected resolve'); },
      async cleanup() { return { removed: 0 }; },
    },
    dependencies: { status: () => ({}) },
  };
  const service = new NovelService({ runtime, now: Date.now, log: () => {} });
  const originalPump = service.pump.bind(service);
  service.pump = () => {};
  const invocation = {
    source: 'qq',
    botId: 'shutdown-bot',
    kind: 'c2c',
    chatId: 'shutdown-chat',
    userId: 'shutdown-user',
    messageId: 'shutdown-message',
    receivedAt: Date.now(),
    mentioned: true,
  };
  const owner = service.store.key(invocation);
  let bookId = '';
  await service.store.updateLibrary(owner, (library) => {
    bookId = 'book-shutdown';
    library.books.push({
      id: bookId,
      no: 1,
      title: '关闭测试书',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      settings: {
        core: '', genre: '悬疑', world: '', style: '', avoid: '', targetChars: 1000,
      },
      people: [],
      outline: [],
      chapters: [],
      memory: { validThrough: 0, cumulative: '', states: [] },
      autoRead: false,
      voice: { source: '', profileId: '', voice: '', speed: 1 },
      audioArtifacts: {},
      generatedOutline: [],
    });
    library.currentBookId = bookId;
    return library;
  });
  const first = await service.enqueue({
    kind: 'write',
    owner,
    invocation,
    input: { bookId, count: 1, targetChars: 1000, request: '' },
    dedupe: 'shutdown-first',
  });
  first.outbox = [{
    kind: 'txt',
    state: 'queued',
    artifactId: 'existing-artifact',
    fileName: 'existing.txt',
  }];
  await service.store.saveTask(first);
  const second = await service.enqueue({
    kind: 'write',
    owner,
    invocation,
    input: { bookId, count: 1, targetChars: 1000, request: '' },
    dedupe: 'shutdown-second',
  });

  service.pump = originalPump;
  service.pump();
  await modelStarted;
  await service.shutdown();

  const savedFirst = service.store.task(first.id);
  const savedSecond = service.store.task(second.id);
  assert.equal(savedFirst.status, 'interrupted');
  assert.equal(savedFirst.stage, 'interrupted');
  assert.equal(savedFirst.outbox[0].state, 'queued');
  assert.equal(savedSecond.status, 'queued');
  assert.equal(service.cleanupTimer, null);
  assert.equal(service.closing, true);

  service.pump();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.store.task(second.id).status, 'queued');
});
