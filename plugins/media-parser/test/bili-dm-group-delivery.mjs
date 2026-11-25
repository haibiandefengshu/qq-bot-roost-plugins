import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBiliDmStore, ensureConversation, makeMessageKey, makeRequestId, makeSegmentKey,
} from '../bili-dm-store.js';
import { createBiliDmDelivery } from '../bili-dm-delivery.js';

const UID = '42';
const ROBOT = 'group-delivery';
const OWNER = 'owner-verified';

function memoryIo() {
  const files = new Map();
  return {
    async readFile(file) {
      if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files.get(file);
    },
    async writeFile(file, text) { files.set(file, String(text)); },
    async rename(from, to) { files.set(to, files.get(from)); files.delete(from); },
    async unlink(file) { files.delete(file); },
    async mkdir() {},
  };
}

async function fixture({ noAccount = false } = {}) {
  let at = 1_795_580_000_000;
  let owner = true;
  let groupEnabled = true;
  let groupPush = 'yes';
  const store = createBiliDmStore({
    dataDir: 'group-review', robotKey: ROBOT, fs: memoryIo(), now: () => at, maxSendsPerWindow: 100,
  });
  await store.ready;
  if (!noAccount) await store.setCurrentUid(UID);
  await store.bind(OWNER);
  const calls = [], replies = [], ledger = new Map();
  const ctx = {
    isOwner: async (id) => owner && id === OWNER,
    getGroup: async (id) => (id === 'known-group'
      ? { groupOpenid: id, name: '测试群', enabled: groupEnabled }
      : null),
    gate: { check: async () => ({ ok: true }) },
    reach: {
      canC2C: async () => 'yes',
      canGroupPush: async () => groupPush,
    },
    quotaLeft: async (_target, kind) => (['group', 'c2c'].includes(kind) ? 100 : 0),
    push: async (target, text, options) => {
      calls.push({ target, text, options });
      ledger.set(options.requestId, { state: 'sent' });
      return { id: `message-${calls.length}` };
    },
    delivery: { get: (id) => ledger.get(id) || null },
  };
  const delivery = createBiliDmDelivery({ store, ctx, now: () => at });
  const add = async (n, text = `body-${n}`, talkerId = '91') => {
    const msgKey = `9007199254740993${n}`;
    const key = makeMessageKey({
      robotKey: ROBOT, accountUid: UID, sessionType: 1, talkerId, msgKey, seqno: String(n),
    });
    await store.transaction((state) => {
      const account = state.accounts[UID];
      ensureConversation(account, {
        talkerId, sessionType: 1, high: String(n), baseline: false, now: at,
      });
      account.messages[key] = {
        key,
        accountUid: UID,
        sessionType: 1,
        talkerId,
        conversationKey: `1:${talkerId}`,
        seqno: String(n),
        msgKey,
        messageId: msgKey,
        senderUid: talkerId,
        senderName: '',
        sentAt: Math.floor(at / 1000),
        type: 'text',
        rawType: 1,
        text,
        imageUrls: [],
        shareUrls: [],
        sourceStatus: 'ok',
        status: 'unfinished',
        deliveryState: 'queued',
        createdAt: at,
        completedAt: null,
      };
    });
    return key;
  };
  const msg = (id = `incoming-${at}`) => ({
    id,
    kind: 'c2c',
    chatId: OWNER,
    userId: OWNER,
    receivedAt: at,
    api: { seqMap: new Map() },
    replyNow: async (text, options) => {
      replies.push({ text, options, id });
      ledger.set(options.requestId, { state: 'sent' });
      return { id: `reply-${replies.length}` };
    },
  });
  return {
    store,
    ctx,
    calls,
    replies,
    ledger,
    delivery,
    add,
    msg,
    advance: (ms) => { at += ms; },
    revoke: () => { owner = false; },
    disableGroup: () => { groupEnabled = false; },
    enableGroup: () => { groupEnabled = true; },
    groupReach: (value) => { groupPush = value; },
  };
}

function segments(store, key) {
  return Object.values(store.current().accounts[UID].segments)
    .filter((segment) => segment.messageKey === key)
    .sort((left, right) => left.index - right.index);
}

test('configureTarget is opt-in, versioned, and rejects unknown or disabled groups', async () => {
  const f = await fixture();
  const initial = f.store.binding();
  await assert.rejects(f.delivery.configureTarget({ kind: 'group', target: 'unknown-group' }));
  f.disableGroup();
  await assert.rejects(f.delivery.configureTarget({ kind: 'group', target: 'known-group' }));
  assert.deepEqual(f.store.binding(), initial);
  f.enableGroup();

  const selected = await f.delivery.configureTarget({ kind: 'group', target: 'known-group' });
  assert.equal(selected.ok, true);
  assert.equal(selected.changed, true);
  assert.equal(f.store.binding().notifyKind, 'group');
  assert.equal(f.store.binding().groupTarget, 'known-group');
  assert.equal(f.store.binding().target, OWNER);
  const version = f.store.binding().version;
  const repeat = await f.delivery.configureTarget({ kind: 'group', target: 'known-group' });
  assert.equal(repeat.changed, false);
  assert.equal(f.store.binding().version, version);
  await f.delivery.configureTarget({ kind: 'c2c', target: '' });
  assert.equal(f.store.binding().version, version + 1);
  assert.equal(f.store.binding().groupTarget, '');
});

test('configureTarget requires a live owner and does not expose private identifiers', async () => {
  const f = await fixture();
  f.revoke();
  await assert.rejects(f.delivery.configureTarget({ kind: 'group', target: 'known-group' }));
  assert.equal(f.store.binding().notifyKind, 'c2c');
  const text = JSON.stringify(await f.delivery.configureTarget({ kind: 'c2c', target: '' }).catch((error) => (
    { code: error.code }
  )));
  assert.equal(text.includes(OWNER), false);
  assert.equal(text.includes(UID), false);
});

test('new records use the selected group with separated keys while old backlog stays frozen', async () => {
  const f = await fixture();
  const oldKey = await f.add(1, 'frozen-original-sentinel');
  await f.delivery.configureTarget({ kind: 'group', target: 'known-group' });
  const oldSegments = segments(f.store, oldKey);
  assert.equal(oldSegments.length, 1);
  assert.equal(oldSegments[0].target, OWNER);
  assert.equal(oldSegments[0].targetKind, 'c2c');

  const newKey = await f.add(2, 'new-group-sentinel');
  await f.delivery.pump();
  assert.equal(f.calls.some((call) => call.text.includes('frozen-original-sentinel')), false);
  const groupCall = f.calls.find((call) => call.text.includes('new-group-sentinel'));
  assert.ok(groupCall);
  assert.equal(groupCall.target, 'known-group');
  assert.equal(groupCall.options.kind, 'group');
  const groupSegment = segments(f.store, newKey)[0];
  assert.equal(groupSegment.targetKind, 'group');
  assert.equal(segments(f.store, oldKey)[0].state, 'planned');
  assert.notEqual(groupSegment.key, makeSegmentKey({
    messageKey: newKey,
    bindingVersion: groupSegment.bindingVersion,
    target: 'known-group',
    index: 0,
  }));
  assert.equal(groupSegment.key, makeSegmentKey({
    messageKey: newKey,
    bindingVersion: groupSegment.bindingVersion,
    target: 'known-group',
    index: 0,
    targetKind: 'group',
  }));
  assert.equal(groupSegment.requestId, makeRequestId({
    robotKey: ROBOT,
    accountUid: UID,
    target: 'known-group',
    bindingVersion: groupSegment.bindingVersion,
    messageKey: newKey,
    index: 0,
    targetKind: 'group',
  }));
});

test('a blocked group never falls back to owner C2C', async () => {
  const f = await fixture();
  await f.delivery.configureTarget({ kind: 'group', target: 'known-group' });
  await f.add(1);
  f.groupReach('no');
  await f.delivery.pump();
  assert.equal(f.calls.length, 0);
  f.groupReach('yes');
  await f.delivery.pump();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options.kind, 'group');
});

test('owner claim transfers only clearly unsent group records into a fresh C2C identity', async () => {
  const f = await fixture();
  await f.delivery.configureTarget({ kind: 'group', target: 'known-group' });
  const unsentKey = await f.add(1, 'claim-transfer-sentinel');
  await f.delivery.pump();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options.kind, 'group');
  assert.ok(unsentKey);

  const f2 = await fixture();
  await f2.delivery.configureTarget({ kind: 'group', target: 'known-group' });
  const blockedKey = await f2.add(1, 'claim-blocked-sentinel');
  f2.groupReach('no');
  await f2.delivery.pump();
  const source = segments(f2.store, blockedKey)[0];
  assert.equal(source.targetKind, 'group');
  const result = await f2.delivery.claim(f2.msg('claim-group-1'));
  assert.equal(result.sent, 1);
  assert.equal(f2.replies.length, 1);
  assert.match(f2.replies[0].text, /claim-blocked-sentinel/);
  const transferred = segments(f2.store, blockedKey).filter((segment) => segment.state === 'sent');
  assert.equal(transferred.length, 1);
  assert.equal(transferred[0].targetKind, 'c2c');
  assert.equal(transferred[0].target, OWNER);
  assert.notEqual(transferred[0].key, source.key);
  assert.notEqual(transferred[0].requestId, source.requestId);
});

test('pending or unknown group attempts are not transferred by owner claim', async () => {
  const f = await fixture();
  await f.delivery.configureTarget({ kind: 'group', target: 'known-group' });
  await f.add(1, 'pending-group-sentinel');
  f.ctx.push = async (target, text, options) => {
    f.calls.push({ target, text, options });
    f.ledger.set(options.requestId, { state: 'pending' });
    return { pending: true, id: 'audit' };
  };
  await f.delivery.pump();
  assert.equal(f.calls.length, 1);
  const result = await f.delivery.claim(f.msg('claim-pending-group'));
  assert.equal(result.sent, 0);
  assert.equal(f.replies.length, 0);
  const rows = segments(f.store, Object.keys(f.store.current().accounts[UID].messages)[0]);
  assert.equal(rows[0].state, 'pending');
});

test('fault notices persist once per cycle and route to the selected group', async () => {
  const f = await fixture();
  await f.delivery.configureTarget({ kind: 'group', target: 'known-group' });
  const first = await f.delivery.notifyStatus({ code: 'DM_NETWORK', at: 1000 });
  assert.equal(first.accepted, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].target, 'known-group');
  assert.equal(f.calls[0].options.kind, 'group');
  const count = f.store.current().notifications.length;
  const again = await f.delivery.notifyStatus({ code: 'DM_NETWORK', at: 1000 });
  assert.equal(again.accepted, true);
  assert.equal(f.store.current().notifications.length, count);
  assert.equal(f.calls.length, 1);
  const raw = JSON.stringify(f.store.current().notifications);
  assert.equal(raw.includes('SESSDATA'), false);
});

test('synthetic panel notifications use persisted monotonic identities and keep blocked records', async () => {
  const f = await fixture({ noAccount: true });
  const first = await f.delivery.sendTest();
  assert.equal(first.sent, 1);
  const second = await f.delivery.sendTest();
  assert.equal(second.sent, 1);
  const notifications = f.store.current().notifications;
  assert.equal(notifications.length, 2);
  assert.ok(notifications[0].id < notifications[1].id);
  assert.equal(f.store.current().notificationSeq, notifications[1].id);
});
