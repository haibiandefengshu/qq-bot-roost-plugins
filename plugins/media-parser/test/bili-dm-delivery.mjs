import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBiliDmDelivery, splitOriginalText, buildSegmentBodies, DM_TEXT_LIMIT,
} from '../bili-dm-delivery.js';
import { createBiliDmStore, makeMessageKey } from '../bili-dm-store.js';
import { shortMessageId } from '../bili-dm-content.js';

function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const writes = [];
  const fs = {
    files,
    writes,
    async readFile(file) {
      if (!files.has(file)) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(file);
    },
    async _writeFile(file, data, options) {
      writes.push({ file, data: String(data), options });
      files.set(file, String(data));
    },
    async rename(from, to) {
      if (!files.has(from)) throw new Error('rename source missing');
      files.set(to, files.get(from));
      files.delete(from);
    },
    async unlink(file) { files.delete(file); },
    async mkdir() {},
  };
  fs.writeFile = (...args) => fs._writeFile(...args);
  return fs;
}

function host({
  owner = true, reach = 'yes', quota = 10, responder = null, replyResponder = null,
  ledger = new Map(), clock,
} = {}) {
  const calls = [];
  const replies = [];
  const ctx = {
    isOwner: (id) => owner && id === 'owner-1',
    reach: { canC2C: async () => reach },
    quotaLeft: async () => quota,
    push: async (target, text, options) => {
      const call = { target, text, options };
      calls.push(call);
      if (responder) return responder(call, calls);
      ledger.set(options.requestId, { state: 'sent' });
      return { id: `msg-${calls.length}` };
    },
    delivery: { get: (requestId) => ledger.get(requestId) || null },
    api: { seqMap: new Map() },
  };
  const makeMsg = (userId = 'owner-1', id = 'incoming-1') => {
    const msg = {
      id, kind: 'c2c', chatId: userId, userId, receivedAt: clock?.() ?? Date.now(),
      api: ctx.api,
      async replyNow(text, options = {}) {
        const call = { target: userId, text, options, passive: true };
        replies.push(call);
        if (replyResponder) return replyResponder(call, replies);
        ctx.api.seqMap.set(msg.id, (ctx.api.seqMap.get(msg.id) || 0) + 1);
        ledger.set(options.requestId, { state: 'sent' });
        return { id: `reply-${replies.length}` };
      },
    };
    return msg;
  };
  return { ctx, calls, replies, ledger, makeMsg };
}

async function setup({
  bind = true, maxSends = 2, maxUnfinished = 100, maxFileBytes,
} = {}) {
  let clock = 1_700_000_000_000;
  const fs = memoryFs();
  const store = createBiliDmStore({
    dataDir: '/data', robotKey: 'bot-1', fs, now: () => clock,
    maxSendsPerWindow: maxSends, maxUnfinished, maxFileBytes,
  });
  await store.ready;
  await store.setCurrentUid('9007199254740993');
  if (bind) await store.bind('owner-1');
  const addMessage = async (text, seq = 1, extra = {}) => {
    const msgKey = extra.msgKey || `9007199254740993${seq}`;
    const key = makeMessageKey({
      robotKey: 'bot-1', accountUid: '9007199254740993', sessionType: 1, talkerId: '42',
      msgKey, seqno: String(seq),
    });
    await store.transaction((draft) => {
      draft.accounts['9007199254740993'].messages[key] = {
        key,
        accountUid: '9007199254740993',
        sessionType: 1,
        talkerId: '42',
        conversationKey: '1:42',
        msgKey,
        seqno: String(seq),
        messageId: msgKey,
        senderUid: '555',
        senderName: '',
        sentAt: 1_700_000_000,
        type: 'text',
        rawType: 1,
        text,
        imageUrls: [],
        shareUrls: [],
        sourceStatus: 'ok',
        status: 'unfinished',
        deliveryState: 'queued',
        createdAt: clock,
        completedAt: null,
        ...extra,
      };
    });
    return key;
  };
  const advance = (ms) => { clock += ms; };
  return { store, fs, addMessage, advance, clock: () => clock };
}

function segments(store, key) {
  return Object.values(store.current().accounts['9007199254740993'].segments)
    .filter((segment) => segment.messageKey === key)
    .sort((left, right) => left.index - right.index);
}

test('binding accepts only a verified ordinary owner C2C message', async () => {
  const { store } = await setup({ bind: false });
  const h = host();
  const delivery = createBiliDmDelivery({ store, ctx: h.ctx });
  await assert.rejects(delivery.bind({ kind: 'group', userId: 'owner-1', chatId: 'g' }), { code: 'DM_OWNER_REQUIRED' });
  await assert.rejects(delivery.bind({ kind: 'c2c', userId: 'owner-1', chatId: 'owner-2' }), { code: 'DM_OWNER_REQUIRED' });
  h.ctx.isOwner = () => false;
  await assert.rejects(delivery.bind(h.makeMsg()), { code: 'DM_OWNER_REQUIRED' });
  h.ctx.isOwner = () => true;
  const result = await delivery.bind(h.makeMsg());
  assert.equal(result.bound, true);
  assert.equal(store.binding().target, 'owner-1');
});

test('pump commits sending before dispatch then completes the message', async () => {
  const { store, addMessage } = await setup();
  let observed = '';
  const h = host();
  const originalPush = h.ctx.push;
  h.ctx.push = async (target, text, options) => {
    observed = segments(store, key)[0].state;
    return originalPush(target, text, options);
  };
  const delivery = createBiliDmDelivery({ store, ctx: h.ctx });
  const key = await addMessage('第一行\n\n第二行');
  await delivery.pump();
  assert.equal(observed, 'sending');
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].text, /【B站私信】/);
  assert.match(h.calls[0].text, /第一行\n\n第二行/);
  assert.equal(segments(store, key)[0].state, 'sent');
  assert.equal(store.current().accounts['9007199254740993'].messages[key].status, 'sent');
});

test('crash after send but before result commit recovers through the ledger only', async () => {
  const { store, fs, addMessage } = await setup();
  const h = host();
  const delivery = createBiliDmDelivery({ store, ctx: h.ctx });
  const key = await addMessage('崩溃恢复测试');
  const writesBefore = fs.writes.length;
  const original = fs._writeFile;
  let count = 0;
  fs._writeFile = async (...args) => {
    count += 1;
    if (count === 3) throw new Error('simulated crash');
    return original.apply(fs, args);
  };
  await delivery.pump();
  fs._writeFile = original;
  assert.equal(h.calls.length, 1);
  assert.equal(segments(store, key)[0].state, 'sending');
  assert.equal(fs.writes.length >= writesBefore + 2, true);

  const reloaded = createBiliDmStore({ dataDir: '/data', robotKey: 'bot-1', fs, now: () => 1_700_000_001_000 });
  await reloaded.ready;
  const recovered = createBiliDmDelivery({ store: reloaded, ctx: h.ctx, now: () => 1_700_000_001_000 });
  await recovered.pump();
  assert.equal(h.calls.length, 1);
  assert.equal(segments(reloaded, key)[0].state, 'sent');
});

test('reach no and quota zero keep the queue without a send call', async () => {
  const { store, addMessage } = await setup();
  const noReach = host({ reach: 'no' });
  const key = await addMessage('不可达');
  await createBiliDmDelivery({ store, ctx: noReach.ctx }).pump();
  assert.equal(noReach.calls.length, 0);
  assert.equal(segments(store, key)[0].state, 'planned');

  const noQuota = host({ quota: 0 });
  await createBiliDmDelivery({ store, ctx: noQuota.ctx }).pump();
  assert.equal(noQuota.calls.length, 0);
  assert.equal(segments(store, key)[0].state, 'planned');
});

test('unknown result without ID is never treated as sent or retried automatically', async () => {
  const { store, addMessage } = await setup();
  const h = host({ responder: () => ({ task: 'queued' }) });
  const key = await addMessage('未知结果');
  const delivery = createBiliDmDelivery({ store, ctx: h.ctx });
  await delivery.pump();
  assert.equal(h.calls.length, 1);
  assert.equal(segments(store, key)[0].state, 'unknown');
  assert.equal(store.current().accounts['9007199254740993'].messages[key].deliveryState, 'unknown');
  await delivery.pump();
  assert.equal(h.calls.length, 1);
});

test('pending exception stays pending and is never resubmitted', async () => {
  const { store, addMessage } = await setup();
  const h = host({
    responder: () => { throw Object.assign(new Error('pending review'), { code: 'pending' }); },
  });
  const key = await addMessage('审核中');
  const delivery = createBiliDmDelivery({ store, ctx: h.ctx });
  await delivery.pump();
  assert.equal(segments(store, key)[0].state, 'pending');
  await delivery.pump();
  assert.equal(h.calls.length, 1);
});

test('dry is unsent and a definitive failure retries with the same immutable body and request key', async () => {
  const { store, addMessage, advance } = await setup({ maxSends: 10 });
  let dry = true;
  const h = host({
    responder: (call) => (dry ? { dry: true } : { id: 'ok' }),
  });
  const key = await addMessage('重试正文');
  const delivery = createBiliDmDelivery({ store, ctx: h.ctx, now: () => 1_700_000_000_000 });
  await delivery.pump();
  const first = h.calls[0];
  const failed = segments(store, key)[0];
  assert.equal(failed.state, 'failed');
  dry = false;
  advance(120_000);
  const retryDelivery = createBiliDmDelivery({
    store, ctx: h.ctx, now: () => 1_700_000_120_000,
  });
  await retryDelivery.pump();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].options.requestId, first.options.requestId);
  assert.equal(h.calls[1].text, first.text);
  assert.equal(segments(store, key)[0].state, 'sent');
});

test('rate persistence survives a store reload', async () => {
  let clock = 1_700_000_000_000;
  const fs = memoryFs();
  const first = createBiliDmStore({
    dataDir: '/data', robotKey: 'bot-1', fs, now: () => clock, maxSendsPerWindow: 2,
  });
  await first.ready;
  await first.setCurrentUid('9007199254740993');
  await first.bind('owner-1');
  const h = host();
  const keys = [];
  for (let index = 1; index <= 3; index += 1) {
    const msgKey = `9007199254740993${index}`;
    const key = makeMessageKey({
      robotKey: 'bot-1', accountUid: '9007199254740993', sessionType: 1, talkerId: '42',
      msgKey, seqno: String(index),
    });
    keys.push(key);
    await first.transaction((draft) => {
      draft.accounts['9007199254740993'].messages[key] = {
        key, accountUid: '9007199254740993', sessionType: 1, talkerId: '42',
        conversationKey: '1:42',
        msgKey, seqno: String(index), messageId: msgKey,
        senderUid: '555', senderName: '',
        sentAt: 1_700_000_000, type: 'text', rawType: 1, text: `消息${index}`,
        imageUrls: [], shareUrls: [], sourceStatus: 'ok', status: 'unfinished',
        deliveryState: 'queued', createdAt: clock, completedAt: null,
      };
    });
  }
  await createBiliDmDelivery({ store: first, ctx: h.ctx, now: () => clock }).pump();
  assert.equal(h.calls.length, 2);
  const second = createBiliDmStore({
    dataDir: '/data', robotKey: 'bot-1', fs, now: () => clock, maxSendsPerWindow: 2,
  });
  await second.ready;
  await createBiliDmDelivery({ store: second, ctx: h.ctx, now: () => clock }).pump();
  assert.equal(h.calls.length, 2);
  clock += 61_000;
  await createBiliDmDelivery({ store: second, ctx: h.ctx, now: () => clock }).pump();
  assert.equal(h.calls.length, 3);
  assert.equal(keys.length, 3);
});

test('target change freezes pending work and claim copies only clearly unsent segments', async () => {
  const { store, addMessage } = await setup({ maxSends: 10 });
  const h = host({
    responder: () => { throw Object.assign(new Error('pending review'), { code: 'pending' }); },
  });
  const pendingKey = await addMessage('待核对', 1);
  await createBiliDmDelivery({ store, ctx: h.ctx }).pump();
  assert.equal(segments(store, pendingKey)[0].state, 'pending');
  await store.bind('owner-2');
  h.ctx.isOwner = (id) => id === 'owner-2';
  await createBiliDmDelivery({ store, ctx: h.ctx }).pump();
  assert.equal(h.calls.length, 1);
  const claimMsg = h.makeMsg('owner-2');
  const delivery = createBiliDmDelivery({ store, ctx: h.ctx });
  const claim = await delivery.claim(claimMsg);
  assert.equal(claim.sent, 0);
  assert.equal(h.replies.length, 0);

  const unsentKey = await addMessage('明确未发送', 2);
  const blocked = host({ reach: 'no' });
  blocked.ctx.isOwner = () => true;
  await createBiliDmDelivery({ store, ctx: blocked.ctx }).pump();
  assert.equal(segments(store, unsentKey)[0].state, 'planned');
  await store.bind('owner-3');
  h.ctx.isOwner = (id) => id === 'owner-3';
  const claimMsg3 = h.makeMsg('owner-3', 'incoming-3');
  const claim3 = await createBiliDmDelivery({ store, ctx: h.ctx }).claim(claimMsg3);
  assert.equal(claim3.sent, 1);
  assert.equal(h.replies.length, 1);
  const moved = Object.values(store.current().accounts['9007199254740993'].segments)
    .filter((segment) => segment.messageKey === unsentKey && segment.state === 'sent');
  assert.equal(moved.length, 1);
  assert.equal(moved[0].target, 'owner-3');
});

test('long original text is split under the limit without losing text or surrogate pairs', async () => {
  const text = `${'甲'.repeat(1200)}\n\n${'😀'.repeat(200)}\n尾部`;
  const chunks = splitOriginalText(text, 100);
  assert.equal(chunks.join(''), text);
  for (const chunk of chunks) {
    assert.equal(/[\uD800-\uDBFF]$/.test(chunk), false);
  }
  const record = {
    key: 'k', senderUid: '555', senderName: '', sentAt: 1_700_000_000, text,
  };
  const bodies = buildSegmentBodies(record);
  assert.equal(bodies.length > 1, true);
  assert.equal(bodies.every((body) => body.length <= DM_TEXT_LIMIT), true);
});

test('status is serializable and never exposes target, UID, sender or body text', async () => {
  const { store, addMessage } = await setup();
  const h = host();
  await addMessage('绝密私信正文');
  await createBiliDmDelivery({ store, ctx: h.ctx }).pump();
  const status = createBiliDmDelivery({ store, ctx: h.ctx }).status();
  const text = JSON.stringify(status);
  assert.equal(text.includes('owner-1'), false);
  assert.equal(text.includes('9007199254740993'), false);
  assert.equal(text.includes('绝密私信正文'), false);
  assert.equal(text.includes('555'), false);
  assert.equal(status.binding.bound, true);
  assert.match(status.binding.mask, /^\*\*\*/);
});

test('partial long message keeps later segments unsent and retries only the immutable remainder', async () => {
  const { store, addMessage, advance } = await setup({ maxSends: 10 });
  let calls = 0;
  let failSecond = true;
  const h = host({
    responder: () => {
      calls += 1;
      if (failSecond && calls === 2) throw Object.assign(new Error('quota'), { code: 'quota' });
      return { id: `ok-${calls}` };
    },
  });
  const key = await addMessage(`${'甲'.repeat(2000)}${'乙'.repeat(2000)}`);
  await createBiliDmDelivery({ store, ctx: h.ctx, now: () => 1_700_000_000_000 }).pump();
  let parts = segments(store, key);
  assert.equal(parts.length > 2, true);
  assert.equal(parts[0].state, 'sent');
  assert.equal(parts[1].state, 'failed');
  assert.equal(parts.slice(2).every((segment) => segment.state === 'planned'), true);
  const savedBodies = parts.map((segment) => segment.body);
  const savedIds = parts.map((segment) => segment.requestId);
  failSecond = false;
  advance(120_000);
  await createBiliDmDelivery({ store, ctx: h.ctx, now: () => 1_700_000_120_000 }).pump();
  parts = segments(store, key);
  assert.equal(parts.every((segment) => segment.state === 'sent'), true);
  assert.deepEqual(parts.map((segment) => segment.body), savedBodies);
  assert.deepEqual(parts.map((segment) => segment.requestId), savedIds);
});

test('autonomous pump and passive claim share one lock and never duplicate a request', async () => {
  const { store, addMessage } = await setup({ maxSends: 10 });
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  const h = host({
    responder: async (call, calls) => {
      if (calls.length === 1) { started(); await gate; }
      return { id: `ok-${calls.length}` };
    },
  });
  const key = await addMessage(`${'甲'.repeat(2000)}${'乙'.repeat(2000)}`);
  const delivery = createBiliDmDelivery({ store, ctx: h.ctx });
  const pumpPromise = delivery.pump();
  await entered;
  const claimPromise = delivery.claim(h.makeMsg());
  await Promise.resolve();
  assert.equal(h.replies.length, 0);
  release();
  await pumpPromise;
  await claimPromise;
  const parts = segments(store, key);
  assert.equal(parts.every((segment) => segment.state === 'sent'), true);
  assert.equal(new Set(parts.map((segment) => segment.requestId)).size, parts.length);
  for (const reply of h.replies) {
    assert.equal(parts.some((segment) => segment.requestId === reply.options.requestId), false);
  }
});

test('test notification and duplicate view use the same guarded channel without changing original success', async () => {
  const { store, addMessage } = await setup({ maxSends: 10 });
  const h = host();
  const key = await addMessage('保留内容');
  const delivery = createBiliDmDelivery({ store, ctx: h.ctx });
  await delivery.pump();
  const original = segments(store, key)[0];
  assert.equal(original.state, 'sent');
  const test = await delivery.sendTest(h.makeMsg('owner-1', 'test-msg'));
  assert.equal(test.sent, 1);
  assert.match(h.calls.at(-1).text, /【B站私信·测试】/);
  assert.equal(segments(store, key)[0].state, 'sent');

  const view = await delivery.view(h.makeMsg('owner-1', 'view-msg'), { shortId: shortMessageId(key) });
  assert.equal(view.ok, true);
  assert.equal(view.sent, 1);
  assert.equal(h.replies.length, 1);
  assert.match(h.replies[0].text, /【B站私信·重复查看】/);
  assert.equal(segments(store, key)[0].state, 'sent');
});
