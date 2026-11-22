import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createTaskQueue } from '../queue.js';
import { DEFAULTS } from '../settings.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
// 队列的等待/任务定时器是 unref 的（不该拖住宿主进程）。Node 22 的 test runner
// 判定"事件循环已空"时会取消还没 settle 的用例，所以这里用一个 ref'd 定时器
// 把事件循环按住，直到本轮断言真正结束；拿到 release 后立刻清掉。
function keepAlive(ms) {
  const timer = setTimeout(() => {}, ms);
  return () => clearTimeout(timer);
}
const sent = { text: 0, image: 0, video: 1, voice: 0, file: 0 };
const link = (id = 'one') => ({ platform: 'bilibili', url: `https://b23.tv/${id}`, key: `https://b23.tv/${id}` });
function fixture(config = {}, extra = {}) {
  const map = new Map();
  const storage = { async get(key, fallback) { return map.has(key) ? map.get(key) : fallback; }, async set(key, value) { map.set(key, structuredClone(value)); }, async flush() {} };
  const cfg = { ...DEFAULTS, ...config };
  const queue = createTaskQueue({ ctx: { storage }, config: () => cfg, ...extra });
  return { queue, cfg, storage, map };
}

test('one session stays serial while a second session uses the second global slot', async () => {
  const { queue } = fixture();
  await queue.ready;
  const holdA = deferred(), holdB = deferred();
  const events = [];
  const a1 = queue.enqueue({ session: 'a', links: [link()], run: async () => { events.push('a1'); await holdA.promise; return { claimed: true, sent }; } });
  const a2 = queue.enqueue({ session: 'a', links: [link('two')], run: async () => { events.push('a2'); return { claimed: true, sent }; } });
  const b1 = queue.enqueue({ session: 'b', links: [link()], run: async () => { events.push('b1'); await holdB.promise; return { claimed: true, sent }; } });
  await tick();
  assert.deepEqual(events, ['a1', 'b1']);
  assert.deepEqual([queue.snapshot().running, queue.snapshot().waiting], [2, 1]);
  holdA.resolve(); await a1; await tick();
  assert.deepEqual(events, ['a1', 'b1', 'a2']);
  holdB.resolve(); await Promise.all([a2, b1]); await tick();
  assert.equal(queue.snapshot().totals.sent.video, 3);
  assert.equal(queue.isIdle(), true);
});

test('queue overflow rejects without silently starting work', async () => {
  const { queue } = fixture({ concurrency: 1, queueLimit: 1 });
  await queue.ready;
  const hold = deferred();
  const first = queue.enqueue({ session: 'a', run: () => hold.promise });
  const second = queue.enqueue({ session: 'b', run: async () => ({ claimed: false }) });
  let ran = false;
  await assert.rejects(queue.enqueue({ session: 'c', run: () => { ran = true; } }), { code: 'QUEUE_FULL' });
  assert.equal(ran, false);
  hold.resolve({ claimed: false }); await Promise.all([first, second]); await tick();
});

test('receipt time determines waiting expiry; an old message never starts parsing', async () => {
  const { queue } = fixture();
  await queue.ready;
  let ran = false;
  await assert.rejects(queue.enqueue({ session: 'a', receivedAt: Date.now() - 31_000, run: () => { ran = true; } }), { code: 'QUEUE_WAIT_TIMEOUT' });
  assert.equal(ran, false);
});

test('queued message expires after its own queue budget and is removed', async () => {
  // queueWaitSeconds 在实现里按秒 clamp 到最小 1，所以这里给足 1 秒预算。
  const { queue } = fixture({ concurrency: 1, queueWaitSeconds: 1 });
  await queue.ready;
  const release = keepAlive(4000);
  const hold = deferred();
  const first = queue.enqueue({ session: 'a', run: () => hold.promise });
  const second = queue.enqueue({ session: 'a', run: () => { throw new Error('must not run'); } });
  const observed = assert.rejects(second, { code: 'QUEUE_WAIT_TIMEOUT' });
  await delay(1150); await observed;
  assert.equal(queue.snapshot().waiting, 0);
  hold.resolve({ claimed: false }); await first; await tick();
  release();
});

test('all links share a deadline and timeout keeps locks until the real work exits', async () => {
  const { queue } = fixture({ concurrency: 2 });
  await queue.ready;
  const cleanup = deferred();
  let active, afterStarted = false;
  const deadlineAt = Date.now() + 30;
  const first = queue.enqueue({
    session: 'a', links: [link(), link('two'), link('three')], deadlineAt,
    run: async (task) => { assert.equal(task.deadlineAt, deadlineAt); active = task.isActive; await cleanup.promise; return { claimed: false }; },
  });
  const observed = assert.rejects(first, { code: 'TASK_TIMEOUT' });
  await delay(45); await observed;
  assert.equal(active(), false);
  assert.equal(queue.snapshot().running, 1);
  const second = queue.enqueue({ session: 'a', run: async () => { afterStarted = true; return { claimed: false }; } });
  await tick(); assert.equal(afterStarted, false);
  cleanup.resolve(); await second; await tick();
  assert.equal(afterStarted, true);
  assert.equal(queue.snapshot().running, 0);
});

test('same-session dedupe preserves query and only records claimed deliveries', async () => {
  const { queue } = fixture();
  await queue.ready;
  const links = [link()];
  const hold = deferred();
  const first = queue.enqueue({ session: 'a', links, run: () => hold.promise });
  assert.deepEqual(queue.filterFresh('a', links), []);
  assert.equal(queue.filterFresh('b', links).length, 1);
  hold.resolve({ claimed: false }); await first; await tick();
  assert.equal(queue.filterFresh('a', links).length, 1);
  await queue.enqueue({ session: 'a', links, run: async () => ({ claimed: true, sent }) }); await tick();
  assert.deepEqual(queue.filterFresh('a', links), []);
  assert.equal(queue.filterFresh('a', [link('one?p=2')]).length, 1);
});

test('teardown aborts waiting and active work, history is bounded, paginated and persists without body', async () => {
  const { queue, map } = fixture({ concurrency: 1 }, { historyLimit: 5 });
  await queue.ready;
  for (let i = 0; i < 8; i++) {
    await queue.enqueue({ session: 'a', links: [link(String(i))], run: async () => ({ claimed: true, sent }) });
    await tick();
  }
  assert.equal(queue.list({ page: 2, pageSize: 2 }).rows.length, 2);
  assert.equal(queue.list().total, 5);
  let abortSeen = false;
  const first = queue.enqueue({ session: 'a', run: ({ signal }) => new Promise((resolve) => { signal.addEventListener('abort', () => { abortSeen = true; resolve({ claimed: false }); }); }) });
  const second = queue.enqueue({ session: 'b', run: async () => ({ claimed: false }) });
  const observed = [assert.rejects(first, { code: 'CANCELLED' }), assert.rejects(second, { code: 'CANCELLED' })];
  await tick(); queue.cancelAll(); await Promise.all(observed); await tick(); await queue.flush();
  assert.equal(abortSeen, true);
  assert.equal(queue.snapshot().closed, true);
  assert.equal(map.get('media-parser:tasks:v1').length <= 5, true);
  assert.equal(JSON.stringify(map.get('media-parser:tasks:v1')).includes('senderName'), false);
});

test('reload repositories share one bounded history without a stale snapshot overwriting new tasks', async () => {
  const repository = {};
  const { queue, storage } = fixture({}, { repository });
  await queue.ready;
  await queue.enqueue({ session: 'a', run: async () => ({ claimed: false }) }); await tick();
  queue.cancelAll('reload');
  const next = createTaskQueue({ ctx: { storage }, repository, config: () => DEFAULTS });
  await next.ready;
  await next.enqueue({ session: 'b', run: async () => ({ claimed: true, sent }) }); await tick();
  assert.equal(next.list().total, 2);
  await next.flush();
  assert.equal((await storage.get('media-parser:tasks:v1')).length, 2);
});
