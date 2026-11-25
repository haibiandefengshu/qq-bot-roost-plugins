import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import { createNovelChatPlugin } from '../index.js';

function createHarness(options = {}) {
  const result = options.result || { handled: true };
  const root = mkdtempSync(join(tmpdir(), 'novel-chat-unit-'));
  const nativeDir = join(root, 'roost', 'data', 'bots', 'bot-unit', 'plugins', 'novel-chat');
  const dataDir = join(root, 'extension-data', 'novel-writer');
  mkdirSync(nativeDir, { recursive: true });
  mkdirSync(join(dataDir, 'outputs'), { recursive: true });
  let sequence = 0;
  let commandHandler;
  let messageHandler;
  let teardown;
  let currentResult = result;
  let currentFileResult = Object.hasOwn(options, 'fileResult')
    ? options.fileResult
    : { ok: true, id: 'sent-file' };
  let currentFileError = null;
  let currentFileReply = null;
  const extCalls = [];
  const replies = [];
  const repliesNow = [];
  let claims = 0;

  const ctx = {
    dataDir: nativeDir,
    config: { enabled: true },
    command(_name, _options, handler) { commandHandler = handler; },
    on(event, handler) { if (event === 'message') messageHandler = handler; },
    menu() {},
    onTeardown(handler) { teardown = handler; },
  };

  const plugin = createNovelChatPlugin({
    async callNovelTransport({ scope, action, payload, invocation }) {
      extCalls.push({ id: scope, action, payload, invocation });
      if (payload?.op === 'deliver') return { ok: true };
      return await currentResult(payload);
    },
  });
  plugin.setup(ctx);

  function outputPath(name = 'file.txt') {
    const path = join(dataDir, 'outputs', `${++sequence}-${name}`);
    writeFileSync(path, 'outbox fixture');
    return path;
  }

  function message(id, { args = [], command = false, text = '' } = {}) {
    return {
      id,
      kind: 'c2c',
      chatId: 'chat-unit',
      userId: 'user-unit',
      traceId: `trace-${id}`,
      isCommand: command,
      mentioned: false,
      receivedAt: Date.now(),
      args,
      files: [],
      content: text || (command ? `/小说 ${args.join(' ')}` : '普通消息'),
      claim() { claims += 1; },
      async reply(value) { replies.push(String(value)); },
      async replyNow(value) { repliesNow.push(String(value)); },
      async replyFile(path, options) {
        if (currentFileReply) return await currentFileReply(path, options);
        if (currentFileError) throw currentFileError;
        return currentFileResult;
      },
    };
  }

  return {
    get extCalls() { return extCalls; },
    get replies() { return replies; },
    get repliesNow() { return repliesNow; },
    get claims() { return claims; },
    set result(value) { currentResult = value; },
    set fileResult(value) { currentFileResult = value; },
    set fileError(value) { currentFileError = value; },
    set fileReply(value) { currentFileReply = value; },
    outputPath,
    message,
    runDirect: (msg) => messageHandler(msg),
    runCommand: (msg) => commandHandler(msg),
    close: () => {
      teardown?.();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function directResult(value) {
  return async () => value;
}

function commandResult(value) {
  return async () => value;
}

test('handled:false 的消息重投不会 claim', async () => {
  const harness = createHarness({ result: directResult({ handled: false }) });
  try {
    const first = harness.message('direct-rejected');
    const second = harness.message('direct-rejected');
    assert.equal(await harness.runDirect(first), false);
    assert.equal(await harness.runDirect(second), false);
    assert.equal(harness.extCalls.length, 2);
    assert.equal(harness.claims, 0);
    assert.deepEqual(harness.replies, []);
  } finally {
    harness.close();
  }
});

test('handled:true 的重投只执行和回复一次', async () => {
  const harness = createHarness({ result: directResult({ handled: true, text: '已处理' }) });
  try {
    assert.equal(await harness.runDirect(harness.message('direct-once')), true);
    assert.equal(await harness.runDirect(harness.message('direct-once')), true);
    assert.equal(harness.extCalls.length, 1);
    assert.deepEqual(harness.replies, ['已处理']);
    assert.equal(harness.claims, 2);
  } finally {
    harness.close();
  }
});

test('命令重复事件只执行一次', async () => {
  const harness = createHarness({ result: commandResult({ handled: true, text: '命令已处理' }) });
  try {
    const first = harness.message('command-once', { command: true, args: ['任务'] });
    const second = harness.message('command-once', { command: true, args: ['任务'] });
    assert.equal(await harness.runCommand(first), true);
    assert.equal(await harness.runCommand(second), true);
    assert.equal(harness.extCalls.length, 1);
    assert.deepEqual(harness.replies, ['命令已处理']);
    assert.equal(harness.claims, 2);
  } finally {
    harness.close();
  }
});

test('文件终态映射为 sent、pending 或 failed', async (t) => {
  const cases = [
    ['明确 sent', { ok: true, state: 'sent', id: 'file-sent' }, 'sent'],
    ['pending 标志', { ok: true, pending: true }, 'pending'],
    ['state pending', { ok: true, state: 'pending' }, 'pending'],
    ['ok:false', { ok: false, message: '平台拒绝' }, 'failed'],
    ['state queued', { ok: true, state: 'queued' }, 'failed'],
    ['state unknown', { ok: true, state: 'unknown' }, 'failed'],
    ['status queued', { ok: true, status: 'queued' }, 'failed'],
    ['status unknown', { ok: true, status: 'unknown' }, 'failed'],
    ['dryRun', { ok: true, dryRun: true }, 'failed'],
    ['sent:false', { ok: true, sent: false }, 'failed'],
    ['无结果', undefined, 'failed'],
  ];

  for (const [name, fileResult, expected] of cases) {
    await t.test(name, async () => {
      const harness = createHarness({ fileResult });
      harness.result = commandResult({
        handled: true,
        outbox: [{
          path: harness.outputPath('outbox.txt'),
          artifactId: 'artifact-1',
          taskId: 'task-1',
          fileName: 'outbox.txt',
          kind: 'txt',
        }],
      });
      try {
        assert.equal(await harness.runCommand(harness.message(`command-${name}`, {
          command: true,
          args: ['发送'],
        })), true);
        const delivery = harness.extCalls.find((call) => call.payload?.op === 'deliver');
        assert.ok(delivery);
        assert.equal(delivery.payload.state, expected);
        if (expected === 'failed') assert.ok(delivery.payload.error);
      } finally {
        harness.close();
      }
    });
  }
});

test('无 taskId 不发 deliver，有 taskId 才发', async () => {
  const harness = createHarness({
    fileResult: { ok: true, state: 'sent', id: 'direct-sent' },
  });
  harness.result = commandResult({
    handled: true,
    outbox: [{ path: harness.outputPath('direct.txt'), artifactId: 'artifact-direct', kind: 'txt' }],
  });
  try {
    assert.equal(await harness.runCommand(harness.message('command-direct', {
      command: true,
      args: ['发送'],
    })), true);
    assert.equal(harness.extCalls.filter((call) => call.payload?.op === 'deliver').length, 0);

    harness.result = commandResult({
      handled: true,
      outbox: [{
        path: harness.outputPath('task.txt'),
        artifactId: 'artifact-task',
        taskId: 'task-delivery',
        kind: 'txt',
      }],
    });
    assert.equal(await harness.runCommand(harness.message('command-task', {
      command: true,
      args: ['任务'],
    })), true);
    const deliveries = harness.extCalls.filter((call) => call.payload?.op === 'deliver');
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].payload.taskId, 'task-delivery');
    assert.equal(deliveries[0].payload.artifactId, 'artifact-task');
  } finally {
    harness.close();
  }
});

test('多个机器人实例各自使用自己的上下文', async () => {
  const first = createHarness({ result: directResult({ handled: true, text: '第一实例' }) });
  const second = createHarness({ result: directResult({ handled: true, text: '第二实例' }) });
  try {
    assert.equal(await first.runDirect(first.message('instance-1')), true);
    assert.equal(await second.runDirect(second.message('instance-2')), true);
    assert.equal(first.extCalls.length, 1);
    assert.equal(second.extCalls.length, 1);
    assert.deepEqual(first.replies, ['第一实例']);
    assert.deepEqual(second.replies, ['第二实例']);

    first.close();
    assert.equal(await second.runDirect(second.message('instance-3')), true);
    assert.equal(second.extCalls.length, 2);
  } finally {
    first.close();
    second.close();
  }
});

test('父任务已取消时不再 watch 自动朗读子任务', async (t) => {
  const scheduled = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay === 900) {
      scheduled.push(callback);
      return { unref() {} };
    }
    return originalSetTimeout(callback, delay, ...args);
  };
  t.after(() => { globalThis.setTimeout = originalSetTimeout; });

  const watched = [];
  const harness = createHarness({
    result: async (payload) => {
      if (payload?.op !== 'watch') {
        return { handled: true, taskId: 'parent' };
      }
      watched.push(payload.taskId);
      return {
        handled: true,
        task: {
          id: payload.taskId,
          status: payload.taskId === 'parent' ? 'cancelled' : 'done',
          followUps: payload.taskId === 'parent' ? ['child'] : [],
        },
        outbox: [],
      };
    },
  });
  try {
    assert.equal(await harness.runCommand(harness.message('cancelled-follow-up', {
      command: true,
      args: ['领取'],
    })), true);
    // 必须真的安排并执行父任务的首次 watch，不能靠超时静默通过。
    assert.equal(scheduled.length, 1, '父任务必须安排 watch 轮询');
    await scheduled[0]();
    assert.deepEqual(watched, ['parent'], '只轮询已取消的父任务，不轮询 follow-up 子任务');
    assert.equal(scheduled.length, 1, '父任务取消后不应继续调度');
  } finally {
    harness.close();
  }
});

test('watch 错误返回不含 task 时不抛未处理异常', async (t) => {
  let watchCalled = false;
  let poll = null;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay) => {
    if (delay === 900) poll = callback;
    return { unref() {} };
  };
  t.after(() => { globalThis.setTimeout = originalSetTimeout; });

  const harness = createHarness({
    result: async (payload) => {
      if (payload?.op !== 'watch') return { handled: true, taskId: 'watch-error' };
      watchCalled = true;
      return { ok: false, text: 'watch unavailable' };
    },
  });
  try {
    assert.equal(await harness.runCommand(harness.message('watch-without-task', {
      command: true,
      args: ['任务'],
    })), true);
    assert.equal(typeof poll, 'function');
    await poll();
    assert.equal(watchCalled, true);
  } finally {
    harness.close();
  }
});

test('teardown 后迟到的 watch 结果不回复也不继续调度', async (t) => {
  let poll = null;
  let schedules = 0;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay) => {
    schedules += 1;
    if (delay === 900) poll = callback;
    return { unref() {} };
  };
  t.after(() => { globalThis.setTimeout = originalSetTimeout; });

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const harness = createHarness({
    result: async (payload) => {
      if (payload?.op !== 'watch') return { handled: true, taskId: 'late-task' };
      startedResolve();
      await gate;
      return {
        handled: true,
        text: '迟到完成',
        task: { id: 'late-task', status: 'done', followUps: ['child-task'] },
        outbox: [],
      };
    },
  });
  try {
    assert.equal(await harness.runCommand(harness.message('late-watch', {
      command: true,
      args: ['任务'],
    })), true);
    assert.equal(typeof poll, 'function');
    const schedulesBeforePoll = schedules;
    const running = poll();
    await started;
    harness.close();
    release();
    await running;
    assert.deepEqual(harness.repliesNow, []);
    assert.equal(schedules, schedulesBeforePoll);
  } finally {
    harness.close();
  }
});

test('teardown 期间尚未返回的命令不再回复、发文件或登记 watch', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  let fileCalls = 0;
  const harness = createHarness();
  const latePath = harness.outputPath('late-command.txt');
  harness.fileReply = async () => {
    fileCalls += 1;
    return { ok: true, state: 'sent', id: 'late-sent' };
  };
  harness.result = async () => {
    startedResolve();
    await gate;
    return {
      handled: true,
      text: '迟到命令结果',
      taskId: 'late-command-task',
      outbox: [{
        path: latePath,
        artifactId: 'late-artifact',
        taskId: 'late-command-task',
        kind: 'txt',
      }],
    };
  };
  try {
    const running = harness.runCommand(harness.message('late-command', {
      command: true,
      args: ['任务'],
    }));
    await started;
    harness.close();
    release();
    assert.equal(await running, true);
    assert.equal(fileCalls, 0);
    assert.deepEqual(harness.replies, []);
    assert.deepEqual(harness.repliesNow, []);
    assert.equal(harness.extCalls.filter((call) => call.payload?.op === 'watch').length, 0);
  } finally {
    harness.close();
  }
});

test('teardown 期间命令调用失败后不再回复或 claim', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const harness = createHarness();
  harness.result = async () => {
    startedResolve();
    await gate;
    throw new Error('late transport failure');
  };
  try {
    const running = harness.runCommand(harness.message('teardown-failed-command', {
      command: true,
      args: ['任务'],
    }));
    await started;
    harness.close();
    release();
    assert.equal(await running, true);
    assert.deepEqual(harness.replies, []);
    assert.deepEqual(harness.repliesNow, []);
    assert.equal(harness.claims, 0);
  } finally {
    harness.close();
  }
});

test('teardown 发生在两个 outbox 文件之间时不再发送后续文件或投递报告', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const fileCalls = [];
  const harness = createHarness();
  harness.fileReply = async (path) => {
    fileCalls.push(path);
    if (fileCalls.length === 1) {
      startedResolve();
      await gate;
    }
    return { ok: true, state: 'sent', id: `sent-${fileCalls.length}` };
  };
  harness.result = commandResult({
    handled: true,
    outbox: [{
      path: harness.outputPath('first.txt'),
      artifactId: 'first-artifact',
      taskId: 'first-task',
      kind: 'txt',
    }, {
      path: harness.outputPath('second.txt'),
      artifactId: 'second-artifact',
      taskId: 'second-task',
      kind: 'txt',
    }],
  });
  try {
    const running = harness.runCommand(harness.message('teardown-between-files', {
      command: true,
      args: ['发送'],
    }));
    await started;
    harness.close();
    release();
    assert.equal(await running, true);
    assert.equal(fileCalls.length, 1);
    assert.equal(harness.extCalls.filter((call) => call.payload?.op === 'deliver').length, 0);
    assert.deepEqual(harness.repliesNow, []);
  } finally {
    harness.close();
  }
});

test('同一任务出现在 taskId 和 watchTaskIds 时只轮询并回复一次', async (t) => {
  const polls = [];
  let watchCalls = 0;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay) => {
    if (delay === 900) polls.push(callback);
    return { unref() {} };
  };
  t.after(() => { globalThis.setTimeout = originalSetTimeout; });

  const harness = createHarness({
    result: async (payload) => {
      if (payload?.op !== 'watch') {
        return {
          handled: true,
          taskId: 'same-task',
          watchTaskIds: ['same-task', 'same-task'],
        };
      }
      watchCalls += 1;
      return {
        handled: true,
        task: { id: 'same-task', status: 'done', followUps: [] },
        text: '任务完成',
        outbox: [],
      };
    },
  });
  try {
    assert.equal(await harness.runCommand(harness.message('dedupe-watch', {
      command: true,
      args: ['任务'],
    })), true);
    assert.equal(polls.length, 1);
    await polls[0]();
    assert.equal(watchCalls, 1);
    assert.deepEqual(harness.repliesNow, ['任务完成']);
  } finally {
    harness.close();
  }
});
