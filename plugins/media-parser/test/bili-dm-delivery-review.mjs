import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBiliDmStore, ensureConversation, makeMessageKey,
} from '../bili-dm-store.js';
import { createBiliDmDelivery } from '../bili-dm-delivery.js';
import { shortMessageId } from '../bili-dm-content.js';

function memoryIo() {
  const files = new Map();
  const io = {
    files,
    onRename: null,
    async readFile(file) {
      if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files.get(file);
    },
    async writeFile(file, text) { files.set(file, String(text)); },
    async rename(from, to) {
      files.set(to, files.get(from));
      files.delete(from);
      await io.onRename?.(JSON.parse(files.get(to)));
    },
    async mkdir() {}, async unlink(file) { files.delete(file); },
  };
  return io;
}

async function fixture({ noAccount = false, noBinding = false, responder = null } = {}) {
  const io = memoryIo();
  let at = 1_795_580_000_000;
  let owner = true;
  const store = createBiliDmStore({
    dataDir: 'review', robotKey: 'review-bot', fs: io, now: () => at, maxSendsPerWindow: 100,
  });
  await store.ready;
  if (!noAccount) await store.setCurrentUid('42');
  if (!noBinding) await store.bind('verified-owner');
  const calls = [], replies = [], ledger = new Map();
  const ctx = {
    isOwner: async (id) => owner && id === 'verified-owner',
    push: async (target, text, options) => {
      const call = { target, text, options };
      calls.push(call);
      if (responder) return responder(call, calls);
      ledger.set(options.requestId, { state: 'sent' });
      return { id: `sent-${calls.length}` };
    },
    reach: { canC2C: async () => 'yes' },
    quotaLeft: async () => 100,
    delivery: { get: (id) => ledger.get(id) || null },
  };
  const delivery = createBiliDmDelivery({ store, ctx, now: () => at });
  async function add(text, sequence = '1', talkerId = '91') {
    const key = makeMessageKey({
      robotKey: 'review-bot', accountUid: '42', sessionType: 1,
      talkerId, msgKey: `9007199254740993${sequence}`, seqno: sequence,
    });
    await store.transaction((state) => {
      const account = state.accounts['42'];
      ensureConversation(account, {
        talkerId, sessionType: 1, high: sequence, baseline: false, now: at,
      });
      account.messages[key] = {
        key, accountUid: '42', sessionType: 1, talkerId, conversationKey: `1:${talkerId}`,
        msgKey: `9007199254740993${sequence}`, messageId: `9007199254740993${sequence}`,
        seqno: sequence, senderUid: talkerId, senderName: '', sentAt: Math.floor(at / 1000),
        type: 'text', rawType: 1, text, imageUrls: [], shareUrls: [], sourceStatus: 'ok',
        status: 'unfinished', deliveryState: 'queued', createdAt: at, completedAt: null,
      };
    });
    return key;
  }
  function msg(id = `incoming-${at}`) {
    return {
      id, kind: 'c2c', chatId: 'verified-owner', userId: 'verified-owner', receivedAt: at,
      api: { seqMap: new Map() },
      replyNow: async (text, options) => {
        replies.push({ text, options, id });
        return { id: `reply-${replies.length}` };
      },
    };
  }
  return {
    io, store, ctx, calls, replies, ledger, delivery, add, msg,
    advance: (ms) => { at += ms; },
    revoke: () => { owner = false; },
  };
}

function segments(store, key) {
  return Object.values(store.current().accounts['42'].segments)
    .filter((segment) => segment.messageKey === key)
    .sort((left, right) => left.index - right.index);
}

test('binding rolled back when owner authority is revoked during persistence', async () => {
  const f = await fixture({ noBinding: true });
  f.io.onRename = async (state) => {
    if (state.binding?.target === 'verified-owner') f.revoke();
  };
  await assert.rejects(f.delivery.bind(f.msg('bind-revoke')), (error) => (
    error.code === 'DM_OWNER_REQUIRED' || error.code === 'DM_STALE'
  ));
  assert.equal(f.store.binding().target, null);
});

test('a pending old-target batch does not block a new target conversation', async () => {
  const f = await fixture({
    responder: (call) => (call.text.includes('old-blocker') ? { pending: true } : { id: 'ok' }),
  });
  const oldKey = await f.add(`old-blocker${'甲'.repeat(4000)}`, '1', '91');
  await f.delivery.pump();
  assert.equal(segments(f.store, oldKey)[0].state, 'pending');
  await f.store.bind('other-owner');
  f.ctx.isOwner = async (id) => id === 'other-owner';
  const newKey = await f.add('independent-new-target-sentinel', '2', '92');
  const before = f.calls.length;
  await f.delivery.pump();
  assert.equal(f.calls.length, before + 1);
  assert.match(f.calls.at(-1).text, /independent-new-target-sentinel/);
  assert.equal(segments(f.store, newKey)[0].state, 'sent');
  assert.equal(segments(f.store, oldKey)[0].state, 'pending');
});

test('claim continues an independent conversation but reports pending work honestly', async () => {
  const f = await fixture({
    responder: (call) => (call.text.includes('blocked-blocker') ? { pending: true } : { id: 'ok' }),
  });
  const blockedKey = await f.add(`blocked-blocker${'乙'.repeat(5000)}`, '1', '91');
  await f.delivery.pump();
  assert.equal(segments(f.store, blockedKey)[0].state, 'pending');
  const freeKey = await f.add('claim-independent-sentinel', '2', '92');
  const result = await f.delivery.claim(f.msg('claim-1'));
  assert.equal(result.sent, 1);
  assert.match(f.replies[0].text, /claim-independent-sentinel/);
  assert.equal(segments(f.store, freeKey)[0].state, 'sent');
  assert.ok(f.replies.length <= 4);
  const notice = f.replies.find((reply) => reply.text.includes('待核对'));
  assert.ok(notice, 'pending work must be reported without implying it can be resent');
  assert.match(notice.text, /不会自动重复发送/);
  assert.ok(notice.options.requestId.includes('claim-notice'));
});

test('claim reserves the final passive slot for an accurate continuation notice', async () => {
  const f = await fixture();
  const key = await f.add('丙'.repeat(12_000), '1');
  const result = await f.delivery.claim(f.msg('claim-budget'));
  assert.equal(f.replies.length, 4);
  assert.equal(result.sent, 3);
  assert.ok(result.remaining > 0);
  assert.match(f.replies.at(-1).text, /可继续领取/);
  assert.match(f.replies.at(-1).text, /\/解析 私信 领取/);
  assert.ok(segments(f.store, key).filter((segment) => segment.state === 'sent').length === 3);
});

test('panel test works without a Bili account and keeps a bounded synthetic record', async () => {
  const f = await fixture({ noAccount: true });
  const msg = f.msg('panel-test-message');
  const first = await f.delivery.sendTest(msg);
  assert.equal(first.sent, 1);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].text, /测试/);
  assert.equal(Object.keys(f.store.current().accounts).length, 0);
  assert.equal(f.store.current().notifications.length, 1);
  const again = await f.delivery.sendTest(msg);
  assert.equal(again.sent, 0);
  assert.equal(again.alreadySent, true);
  assert.equal(f.calls.length, 1);
  const panel = await f.delivery.sendTest();
  assert.equal(panel.sent, 1);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls.at(-1).target, 'verified-owner');
  assert.equal(Object.keys(f.store.current().accounts).length, 0);
});

test('duplicate view pages long content and is idempotent per message and page', async () => {
  const f = await fixture();
  const key = await f.add('长内容\n'.repeat(3000), '1');
  const id = shortMessageId(key);
  const page1 = await f.delivery.view(f.msg('view-msg'), { shortId: id });
  assert.equal(page1.sent, 3);
  assert.equal(page1.nextPage, 2);
  assert.ok(page1.remaining > 0);
  assert.ok(page1.totalPages > 1);
  assert.equal(f.replies.length, 4);
  const repeat = await f.delivery.view(f.msg('view-msg'), { shortId: id });
  assert.equal(repeat.sent, page1.sent);
  assert.equal(repeat.nextPage, page1.nextPage);
  assert.equal(f.replies.length, 4);
  const page2 = await f.delivery.view(f.msg('view-page-2'), { shortId: id, page: 2 });
  assert.equal(page2.page, 2);
  assert.equal(page2.sent, 3);
  assert.ok(page2.remaining > 0);
  assert.ok(f.replies.length <= 8);
  assert.equal(f.replies.slice(4).filter((reply) => reply.text.includes('重复查看')).length, 3);
  assert.match(f.replies.at(-1).text, /继续查看请发送/);
  assert.equal(f.store.current().accounts['42'].messages[key].status, 'unfinished');
  assert.equal(segments(f.store, key).length, 0);
});

test('invalid and undersized view identifiers fail closed', async () => {
  const f = await fixture();
  await f.add('body', '1');
  const invalid = await f.delivery.view(f.msg('view-invalid'), { shortId: 'ABC' });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reasonCode, 'DM_SHORT_ID_INVALID');
  const missing = await f.delivery.view(f.msg('view-missing'), { shortId: 'A'.repeat(12) });
  assert.equal(missing.ok, false);
  assert.equal(missing.reasonCode, 'DM_NOT_FOUND');
  assert.equal(f.replies.length, 0);
});
