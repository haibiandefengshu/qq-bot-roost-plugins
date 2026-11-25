import test from 'node:test';
import assert from 'node:assert/strict';
import { createBiliDmService } from '../bili-dm.js';
import { createBiliDmStore, makeMessageKey, makeRequestId, makeSegmentKey } from '../bili-dm-store.js';

const UID = '42';
const TALKER = '91';
const OWNER = 'verified-owner';
const ROBOT = 'review-bot';
const T = 1_795_580_000_000;

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

function settingsFake({ cookie = 'SESSDATA=offline-review', includeSystem = false } = {}) {
  const config = { biliDmEnabled: true, biliDmPollSeconds: 60, biliDmIncludeSystem: includeSystem };
  return {
    ready: Promise.resolve(),
    current: () => ({ ...config }),
    getBiliCookie: () => cookie,
    getBiliCookieRevision: () => 0,
    subscribeBiliCookie: () => () => {},
    async flush() {},
    setIncludeSystem(value) { config.biliDmIncludeSystem = value === true; },
  };
}

function session(high, patch = {}) {
  return {
    talker_id: TALKER,
    session_type: 1,
    session_ts: String(BigInt(T) * 1000n),
    max_seqno: String(high),
    system_msg_type: 0,
    ...patch,
  };
}

function message(seqno, patch = {}) {
  return {
    sender_uid: TALKER,
    receiver_id: UID,
    receiver_type: 1,
    timestamp: Math.floor(T / 1000) + 1,
    msg_seqno: String(seqno),
    msg_key: `9007199254740993${seqno}`,
    msg_type: 1,
    msg_status: 0,
    content: JSON.stringify({ content: `body-${seqno}` }),
    ...patch,
  };
}

async function fixture({
  clientPatch = {}, settings = settingsFake(), now = () => T, storeOptions = {},
} = {}) {
  const store = createBiliDmStore({
    dataDir: 'review-sync', robotKey: ROBOT, fs: memoryIo(), now, ...storeOptions,
  });
  await store.ready;
  await store.bind(OWNER);
  const client = {
    nav: async () => ({ mid: UID, uname: '', serverTime: T }),
    sessions: async () => ({ sessions: [session(0)], hasMore: false, serverTime: T }),
    messages: async () => ({ messages: [], hasMore: false }),
    ...clientPatch,
  };
  const service = createBiliDmService({ settings, store, client, now, autoSchedule: false, random: () => 0 });
  await service.ready;
  await service.start();
  return { store, client, service, settings };
}

test('recall suppression drops unattempted segments but preserves attempted bodies and request ids', async () => {
  const f = await fixture();
  await f.service.check();
  const binding = f.store.binding();
  const target = '90071992547409931';
  const messageKey = makeMessageKey({
    robotKey: ROBOT, accountUid: UID, sessionType: 1, talkerId: TALKER, msgKey: target, seqno: '1',
  });
  const plannedKey = makeSegmentKey({
    messageKey, bindingVersion: binding.version, target: OWNER, index: 0,
  });
  const failedKey = makeSegmentKey({
    messageKey, bindingVersion: binding.version, target: OWNER, index: 1,
  });
  const plannedRequest = makeRequestId({
    robotKey: ROBOT, accountUid: UID, target: OWNER, bindingVersion: binding.version, messageKey, index: 0,
  });
  const failedRequest = makeRequestId({
    robotKey: ROBOT, accountUid: UID, target: OWNER, bindingVersion: binding.version, messageKey, index: 1,
  });
  await f.store.transaction((draft) => {
    const account = draft.accounts[UID];
    account.messages[messageKey] = {
      key: messageKey,
      accountUid: UID,
      sessionType: 1,
      talkerId: TALKER,
      conversationKey: `1:${TALKER}`,
      msgKey: target,
      seqno: '1',
      messageId: target,
      senderUid: TALKER,
      senderName: '',
      sentAt: Math.floor(T / 1000),
      type: 'text',
      rawType: 1,
      text: 'withdrawn-original-sentinel',
      imageUrls: [],
      shareUrls: [],
      sourceStatus: 'ok',
      status: 'unfinished',
      deliveryState: 'queued',
      createdAt: T,
      completedAt: null,
    };
    account.segments[plannedKey] = {
      key: plannedKey,
      messageKey,
      accountUid: UID,
      target: OWNER,
      bindingVersion: binding.version,
      index: 0,
      total: 2,
      body: 'planned-secret-body',
      requestId: plannedRequest,
      state: 'planned',
      attempts: 0,
      createdAt: T,
      updatedAt: T,
      nextRetryAt: 0,
      lastErrorCode: '',
      sentAt: null,
      supersededBy: '',
    };
    account.segments[failedKey] = {
      key: failedKey,
      messageKey,
      accountUid: UID,
      target: OWNER,
      bindingVersion: binding.version,
      index: 1,
      total: 2,
      body: 'attempted-secret-body',
      requestId: failedRequest,
      state: 'failed',
      attempts: 1,
      createdAt: T,
      updatedAt: T,
      nextRetryAt: T,
      lastErrorCode: 'offline',
      sentAt: null,
      supersededBy: '',
    };
  });
  f.client.sessions = async () => ({ sessions: [session(2)], hasMore: false, serverTime: T + 2000 });
  f.client.messages = async () => ({
    messages: [message(2, { msg_type: 5, content: target })], hasMore: false,
  });
  await f.service.check();
  const account = f.store.current().accounts[UID];
  assert.equal(account.messages[messageKey].text.includes('withdrawn-original-sentinel'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(account.segments, plannedKey), false);
  const attempted = account.segments[failedKey];
  assert.ok(attempted);
  assert.equal(attempted.state, 'superseded');
  assert.equal(attempted.body, 'attempted-secret-body');
  assert.equal(attempted.requestId, failedRequest);
});

test('ambiguous withdrawal without a target fails closed on queued conversation content', async () => {
  const f = await fixture();
  await f.service.check();
  f.client.sessions = async () => ({ sessions: [session(1)], hasMore: false, serverTime: T + 1000 });
  f.client.messages = async () => ({
    messages: [message(1, { content: JSON.stringify({ content: 'withdrawn-original-sentinel' }) })],
    hasMore: false,
  });
  await f.service.check();
  f.client.sessions = async () => ({ sessions: [session(2)], hasMore: false, serverTime: T + 2000 });
  f.client.messages = async () => ({
    messages: [message(2, { msg_type: 5, content: 'not-a-lossless-message-key' })], hasMore: false,
  });
  await f.service.check();
  const account = f.store.current().accounts[UID];
  const records = Object.values(account.messages);
  assert.equal(records.some((record) => record.text.includes('withdrawn-original-sentinel')), false);
  assert.equal(account.conversations[`1:${TALKER}`].gap?.code, 'DM_GAP');
  assert.equal(f.service.status().state, 'error');
});

test('include-system scope baseline persists while ordinary system progress resumes after reload', async () => {
  const settings = settingsFake({ includeSystem: false });
  const f = await fixture({
    settings,
    clientPatch: { sessions: async () => ({ sessions: [], hasMore: false, serverTime: T }) },
  });
  await f.service.check();
  settings.setIncludeSystem(true);
  f.service.configChanged();
  f.client.sessions = async () => ({
    sessions: [session(9, { system_msg_type: 1 })], hasMore: false, serverTime: T + 86_400_000,
  });
  f.client.messages = async () => ({ messages: [message(9)], hasMore: false });
  await f.service.check();
  let account = f.store.current().accounts[UID];
  assert.equal(Object.keys(account.messages).length, 0);
  assert.equal(account.conversations[`1:${TALKER}`].committed, '9');
  assert.equal(typeof account.discovery.scopeBaselineAt, 'number');
  assert.equal(account.discovery.scopeIncludeSystem, true);

  const restartedClient = {
    nav: async () => ({ mid: UID, uname: '', serverTime: T + 90_000_000 }),
    sessions: async () => ({
      sessions: [session(11, { system_msg_type: 1 })], hasMore: false, serverTime: T + 90_000_000,
    }),
    messages: async () => ({
      messages: [message(11), message(10)], hasMore: false,
    }),
  };
  const restarted = createBiliDmService({
    settings, store: f.store, client: restartedClient, now: () => T + 90_000_000, autoSchedule: false,
  });
  await restarted.ready;
  await restarted.start();
  await restarted.check();
  account = f.store.current().accounts[UID];
  assert.deepEqual(
    Object.values(account.messages).map((record) => record.seqno).sort(),
    ['10', '11'],
  );
  assert.equal(account.conversations[`1:${TALKER}`].committed, '11');
});

test('automatic rounds do not hammer a known-invalid cookie while an explicit check revalidates once', async () => {
  let navCalls = 0;
  const f = await fixture({
    clientPatch: {
      nav: async () => {
        navCalls += 1;
        throw Object.assign(new Error('safe fixture'), { code: 'BILI_AUTH' });
      },
    },
  });
  await f.service.check();
  assert.equal(f.service.status().state, 'waiting_login');
  assert.equal(navCalls, 1);
  await f.service.check({ manual: false });
  assert.equal(navCalls, 1);
  assert.equal(f.service.status().state, 'waiting_login');
  f.client.nav = async () => {
    navCalls += 1;
    return { mid: UID, uname: '', serverTime: T };
  };
  f.client.sessions = async () => ({ sessions: [], hasMore: false, serverTime: T });
  await f.service.check();
  assert.equal(navCalls, 2);
  assert.equal(f.service.status().state, 'watching');
});

test('lifecycle prune removes only completed retained records', async () => {
  let clock = T;
  const f = await fixture({
    now: () => clock,
    storeOptions: { completedRetentionMs: 1000 },
    clientPatch: { sessions: async () => ({ sessions: [], hasMore: false, serverTime: T }) },
  });
  await f.service.check();
  const completedKey = makeMessageKey({
    robotKey: ROBOT, accountUid: UID, sessionType: 1, talkerId: TALKER, seqno: '1',
  });
  const unfinishedKey = makeMessageKey({
    robotKey: ROBOT, accountUid: UID, sessionType: 1, talkerId: TALKER, seqno: '2',
  });
  await f.store.transaction((draft) => {
    const account = draft.accounts[UID];
    account.messages[completedKey] = {
      key: completedKey,
      accountUid: UID,
      sessionType: 1,
      talkerId: TALKER,
      conversationKey: `1:${TALKER}`,
      msgKey: '',
      seqno: '1',
      messageId: 'seq:1',
      senderUid: TALKER,
      senderName: '',
      sentAt: Math.floor(T / 1000),
      type: 'text',
      rawType: 1,
      text: 'done',
      imageUrls: [],
      shareUrls: [],
      sourceStatus: 'ok',
      createdAt: T - 20_000,
      completedAt: T - 10_000,
      status: 'sent',
      deliveryState: 'sent',
    };
    account.messages[unfinishedKey] = {
      key: unfinishedKey,
      accountUid: UID,
      sessionType: 1,
      talkerId: TALKER,
      conversationKey: `1:${TALKER}`,
      msgKey: '',
      seqno: '2',
      messageId: 'seq:2',
      senderUid: TALKER,
      senderName: '',
      sentAt: Math.floor(T / 1000),
      type: 'text',
      rawType: 1,
      text: 'still pending',
      imageUrls: [],
      shareUrls: [],
      sourceStatus: 'ok',
      createdAt: T - 20_000,
      completedAt: null,
      status: 'unfinished',
      deliveryState: 'queued',
    };
  });
  clock += 3_600_001;
  await f.service.check();
  const messages = f.store.current().accounts[UID].messages;
  assert.equal(Object.prototype.hasOwnProperty.call(messages, completedKey), false);
  assert.equal(Object.prototype.hasOwnProperty.call(messages, unfinishedKey), true);
});

test('a late ignored-abort response still shares one round promise and commits once', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture({
    clientPatch: {
      sessions: async () => {
        await gate;
        return { sessions: [session(5)], hasMore: false, serverTime: T };
      },
      messages: async () => ({ messages: [], hasMore: false }),
    },
  });
  const first = f.service.check();
  const second = f.service.check();
  assert.equal(first, second);
  release();
  await first;
  const account = f.store.current().accounts[UID];
  assert.equal(account.conversations[`1:${TALKER}`].firstHigh, '5');
  assert.equal(f.service.status().state, 'watching');
});
