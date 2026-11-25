import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  BiliDmStoreError, createBiliDmStore, createEmptyState, ensureConversation,
  makeMessageKey, makeRequestId, makeSegmentKey,
} from '../bili-dm-store.js';

const STATE_FILE = path.join('/data', 'bili-dm-state.json');

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

async function makeStore(overrides = {}) {
  const fs = overrides.fs || memoryFs();
  const store = createBiliDmStore({
    dataDir: '/data', robotKey: 'bot-1', fs, now: () => 1_700_000_000_000, ...overrides,
  });
  await store.ready;
  return { store, fs };
}

function addMessage(draft, uid, seq, extra = {}) {
  const key = makeMessageKey({
    robotKey: draft.robotKey,
    accountUid: uid,
    sessionType: 1,
    talkerId: '42',
    msgKey: extra.msgKey,
    seqno: seq,
  });
  draft.accounts[uid].messages[key] = {
    key,
    accountUid: uid,
    sessionType: 1,
    talkerId: '42',
    conversationKey: '1:42',
    msgKey: extra.msgKey || '',
    seqno: seq,
    messageId: extra.msgKey || `seq:${seq}`,
    senderUid: '555',
    senderName: '',
    sentAt: 1_700_000_000,
    type: 'text',
    rawType: 1,
    text: `body-${seq}`,
    imageUrls: [],
    shareUrls: [],
    sourceStatus: 'ok',
    deliveryState: 'queued',
    status: extra.status || 'unfinished',
    createdAt: 1_700_000_000_000,
    completedAt: null,
    ...extra,
  };
  return key;
}

test('store persists atomic state and reloads it', async () => {
  const fs = memoryFs();
  const { store } = await makeStore({ fs });
  await store.setCurrentUid('9007199254740993');
  await store.transaction((draft) => {
    const conversation = ensureConversation(draft.accounts['9007199254740993'], {
      talkerId: '844424930131966', sessionType: 1, high: '1285290404823041', baseline: true, now: 1,
    });
    conversation.committed = '1285290404823042';
    addMessage(draft, '9007199254740993', '1285290404823042', { msgKey: '7354295169819585966' });
  });
  const loaded = createBiliDmStore({ dataDir: '/data', robotKey: 'bot-1', fs });
  await loaded.ready;
  const state = loaded.current();
  assert.equal(state.currentUid, '9007199254740993');
  assert.equal(state.accounts['9007199254740993'].conversations['1:844424930131966'].committed, '1285290404823042');
  assert.equal(Object.keys(state.accounts['9007199254740993'].messages).length, 1);
  assert.equal(state.accounts['9007199254740993'].messages[
    Object.keys(state.accounts['9007199254740993'].messages)[0]
  ].msgKey, '7354295169819585966');
});

test('failed disk write never advances memory cursor or replaces state file', async () => {
  const fs = memoryFs();
  const { store } = await makeStore({ fs });
  await store.ensureAccount('1');
  await store.transaction((draft) => {
    const conversation = ensureConversation(draft.accounts['1'], {
      talkerId: '42', sessionType: 1, high: '5', baseline: true, now: 1,
    });
    conversation.committed = '5';
  });
  const beforeFile = fs.files.get(store.filePath);
  const originalWrite = fs._writeFile;
  let failed = false;
  fs._writeFile = async (...args) => {
    if (!failed) { failed = true; throw new Error('disk full'); }
    return originalWrite.apply(fs, args);
  };
  await assert.rejects(store.transaction((draft) => {
    draft.accounts['1'].conversations['1:42'].committed = '9';
    addMessage(draft, '1', '9');
  }), { code: 'DM_WRITE_FAILED' });
  assert.equal(store.current().accounts['1'].conversations['1:42'].committed, '5');
  assert.equal(fs.files.get(store.filePath), beforeFile);
});

test('guard is checked after async write and before rename', async () => {
  const fs = memoryFs();
  let active = true;
  const gate = { release: null, started: null };
  const started = new Promise((resolve) => { gate.started = resolve; });
  const { store } = await makeStore({ fs, isActive: () => active });
  await store.ensureAccount('1');
  fs._writeFile = async (file, data, options) => {
    gate.started();
    await new Promise((resolve) => { gate.release = resolve; });
    fs.files.set(file, String(data));
    fs.writes.push({ file, data: String(data), options });
  };
  const pending = store.transaction((draft) => {
    draft.accounts['1'].conversations['1:42'] = {
      key: '1:42', talkerId: '42', sessionType: 1,
      firstHigh: '0', lastHigh: '9', committed: '9', dedupeThrough: '9',
      baseline: false, newAfterBaseline: true, pending: null, gap: null,
      createdAt: 1, updatedAt: 1,
    };
  });
  await started;
  active = false;
  gate.release();
  await assert.rejects(pending, { code: 'DM_STALE' });
  assert.equal(store.current().accounts['1'].conversations['1:42'], undefined);
  assert.equal([...fs.files.keys()].some((file) => file.endsWith('.tmp')), false);
});

test('corrupt state is a visible error and the original file is preserved', async () => {
  const fs = memoryFs({ [STATE_FILE]: '{"schemaVersion":1,' });
  const store = createBiliDmStore({ dataDir: '/data', robotKey: 'bot-1', fs });
  await assert.rejects(store.ready, { code: 'DM_STATE_CORRUPT' });
  assert.equal(fs.files.get(STATE_FILE), '{"schemaVersion":1,');
  assert.equal(store.loadError().code, 'DM_STATE_CORRUPT');
});

test('unsupported schema version is visible and preserved', async () => {
  const fs = memoryFs({ [STATE_FILE]: '{"schemaVersion":99,"accounts":{}}' });
  const store = createBiliDmStore({ dataDir: '/data', robotKey: 'bot-1', fs });
  await assert.rejects(store.ready, { code: 'DM_STATE_UNSUPPORTED' });
  assert.equal(fs.files.get(STATE_FILE), '{"schemaVersion":99,"accounts":{}}');
});

test('bindingVersion only increases when the target actually changes', async () => {
  const { store } = await makeStore();
  assert.equal((await store.bind('owner-a')).version, 1);
  assert.equal((await store.bind('owner-a')).version, 1);
  assert.equal((await store.bind('owner-b')).version, 2);
  assert.equal(store.binding().target, 'owner-b');
});

test('unfinished capacity rejects the whole commit and keeps the previous cursor', async () => {
  const { store } = await makeStore({ maxUnfinished: 1 });
  await store.ensureAccount('1');
  await store.transaction((draft) => {
    const conversation = ensureConversation(draft.accounts['1'], {
      talkerId: '42', sessionType: 1, high: '1', baseline: true, now: 1,
    });
    conversation.committed = '1';
    addMessage(draft, '1', '2');
  });
  await assert.rejects(store.transaction((draft) => {
    draft.accounts['1'].conversations['1:42'].committed = '2';
    addMessage(draft, '1', '3');
  }), { code: 'DM_CAPACITY' });
  assert.equal(store.current().accounts['1'].conversations['1:42'].committed, '1');
  assert.equal(Object.keys(store.current().accounts['1'].messages).length, 1);
});

test('completed records prune after retention while dedupe watermark remains', async () => {
  const { store } = await makeStore({ completedRetentionMs: 1000 });
  await store.ensureAccount('1');
  let messageKey;
  await store.transaction((draft) => {
    const conversation = ensureConversation(draft.accounts['1'], {
      talkerId: '42', sessionType: 1, high: '4', baseline: true, now: 1,
    });
    conversation.committed = '4';
    messageKey = addMessage(draft, '1', '4', { status: 'sent', completedAt: 10 });
  });
  await store.prune(5000);
  assert.equal(store.current().accounts['1'].messages[messageKey], undefined);
  assert.equal(store.current().accounts['1'].conversations['1:42'].dedupeThrough, '4');
});

test('message keys fall back to sequence and reject unsafe key parts', () => {
  const key = makeMessageKey({
    robotKey: 'bot', accountUid: '1', sessionType: 1, talkerId: '2', seqno: '77',
  });
  assert.match(key, /seq%3A77$/);
  assert.throws(() => makeSegmentKey({
    messageKey: 'm', bindingVersion: 1, target: 'bad|target', index: 0,
  }), (error) => error instanceof BiliDmStoreError && error.code === 'DM_STATE_CORRUPT');
  const empty = createEmptyState('bot');
  assert.equal(empty.schemaVersion, 1);
  assert.equal(empty.binding.version, 0);
  assert.equal(empty.binding.notifyKind, 'c2c');
  assert.deepEqual(empty.notifications, []);
});

test('owner rebinding preserves destination configuration and increments version', async () => {
  const { store } = await makeStore();
  await store.bind('owner-a');
  await store.transaction((draft) => {
    draft.binding.notifyKind = 'group';
    draft.binding.groupTarget = 'known-group';
    draft.binding.groupName = '测试群';
  });
  const version = store.binding().version;
  const rebound = await store.bind('owner-b');
  assert.equal(rebound.version, version + 1);
  assert.equal(rebound.target, 'owner-b');
  assert.equal(rebound.notifyKind, 'group');
  assert.equal(rebound.groupTarget, 'known-group');
  assert.equal(rebound.groupName, '测试群');
});

test('group segment keys and request ids are namespace separated and validated', async () => {
  const { store } = await makeStore();
  await store.ensureAccount('1');
  let messageKey;
  let segmentKey;
  await store.transaction((draft) => {
    ensureConversation(draft.accounts['1'], {
      talkerId: '42', sessionType: 1, high: '1', baseline: true, now: 1,
    });
    messageKey = addMessage(draft, '1', '1', { msgKey: '9007199254740993' });
    segmentKey = makeSegmentKey({
      messageKey, bindingVersion: 1, target: 'known-group', index: 0, targetKind: 'group',
    });
    draft.accounts['1'].segments[segmentKey] = {
      key: segmentKey,
      messageKey,
      accountUid: '1',
      target: 'known-group',
      targetKind: 'group',
      bindingVersion: 1,
      index: 0,
      total: 1,
      body: 'group body',
      requestId: makeRequestId({
        robotKey: 'bot-1', accountUid: '1', target: 'known-group', bindingVersion: 1,
        messageKey, index: 0, targetKind: 'group',
      }),
      state: 'planned',
      attempts: 0,
      createdAt: 1,
      updatedAt: 1,
      nextRetryAt: 0,
      lastErrorCode: '',
      sentAt: null,
      supersededBy: '',
    };
  });
  assert.equal(store.current().accounts['1'].segments[segmentKey].targetKind, 'group');
  assert.notEqual(segmentKey, makeSegmentKey({
    messageKey, bindingVersion: 1, target: 'known-group', index: 0,
  }));
  await assert.rejects(store.transaction((draft) => {
    draft.accounts['1'].segments[segmentKey].requestId = makeRequestId({
      robotKey: 'bot-1', accountUid: '1', target: 'known-group', bindingVersion: 1,
      messageKey, index: 0,
    });
  }), { code: 'DM_STATE_CORRUPT' });
});

test('suppressed originals do not consume unfinished capacity and prune after retention', async () => {
  const { store } = await makeStore({ maxUnfinished: 1, completedRetentionMs: 1000 });
  await store.ensureAccount('1');
  let suppressedKey;
  await store.transaction((draft) => {
    ensureConversation(draft.accounts['1'], {
      talkerId: '42', sessionType: 1, high: '2', baseline: true, now: 1,
    });
    suppressedKey = addMessage(draft, '1', '1', {
      status: 'suppressed', deliveryState: 'suppressed', suppressedAt: 10, text: 'recalled',
    });
  });
  await store.transaction((draft) => {
    addMessage(draft, '1', '2');
  });
  assert.equal(store.statusCounters().suppressed, 1);
  assert.equal(store.statusCounters().unfinished, 1);
  await store.prune(5000);
  assert.equal(store.current().accounts['1'].messages[suppressedKey], undefined);
});

test('malformed destination or notification state preserves the original file', async () => {
  const fs = memoryFs();
  const { store } = await makeStore({ fs });
  await store.ensureAccount('1');
  const data = JSON.parse(fs.files.get(store.filePath));
  data.binding.notifyKind = 'broadcast';
  const bytes = JSON.stringify(data);
  fs.files.set(store.filePath, bytes);
  const restored = createBiliDmStore({ dataDir: '/data', robotKey: 'bot-1', fs });
  await assert.rejects(restored.ready, { code: 'DM_STATE_CORRUPT' });
  assert.equal(fs.files.get(store.filePath), bytes);
});

test('notification rows require resumable identity and a bounded collection', async () => {
  const { store } = await makeStore();
  const row = {
    id: 1,
    key: 'notice-key',
    target: 'owner-a',
    targetKind: 'c2c',
    bindingVersion: 1,
    body: 'notice body',
    requestId: 'bili-dm:notice',
    state: 'planned',
    attempts: 0,
    createdAt: 1,
    updatedAt: 1,
    nextRetryAt: 0,
    lastErrorCode: '',
    sentAt: null,
  };
  await store.transaction((draft) => {
    draft.notifications = [{ ...row }];
    draft.notificationSeq = 1;
  });
  assert.equal(store.current().notifications.length, 1);
  await assert.rejects(store.transaction((draft) => {
    delete draft.notifications[0].requestId;
  }), { code: 'DM_STATE_CORRUPT' });
});
