import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  createBiliDmStore, ensureConversation, makeMessageKey, makeRequestId, makeSegmentKey,
} from '../bili-dm-store.js';

const STATE_FILE = path.join('/data', 'bili-dm-state.json');

function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const fs = {
    files,
    async readFile(file) {
      if (!files.has(file)) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(file);
    },
    async writeFile(file, data) { files.set(file, String(data)); },
    async rename(from, to) {
      files.set(to, files.get(from));
      files.delete(from);
    },
    async unlink(file) { files.delete(file); },
    async mkdir() {},
  };
  return fs;
}

async function seededStore(fs) {
  const store = createBiliDmStore({ dataDir: '/data', robotKey: 'bot-1', fs, now: () => 1_700_000_000_000 });
  await store.ready;
  await store.setCurrentUid('42');
  await store.bind('owner-a');
  const messageKey = makeMessageKey({
    robotKey: 'bot-1', accountUid: '42', sessionType: 1, talkerId: '91',
    msgKey: '7354295169819585966', seqno: '101',
  });
  const segmentKey = makeSegmentKey({
    messageKey, bindingVersion: 1, target: 'owner-a', index: 0,
  });
  await store.transaction((draft) => {
    ensureConversation(draft.accounts['42'], {
      talkerId: '91', sessionType: 1, high: '100', baseline: true, now: 1,
    });
    draft.accounts['42'].messages[messageKey] = {
      key: messageKey,
      accountUid: '42',
      sessionType: 1,
      talkerId: '91',
      conversationKey: '1:91',
      msgKey: '7354295169819585966',
      seqno: '101',
      messageId: '7354295169819585966',
      senderUid: '91',
      senderName: '',
      sentAt: 1_700_000_000,
      type: 'text',
      rawType: 1,
      text: 'hello',
      imageUrls: [],
      shareUrls: [],
      sourceStatus: 'ok',
      fatal: false,
      parseFailure: false,
      robotKey: 'bot-1',
      recallTarget: '',
      status: 'unfinished',
      deliveryState: 'queued',
      createdAt: 1_700_000_000_000,
      completedAt: null,
    };
    draft.accounts['42'].segments[segmentKey] = {
      key: segmentKey,
      messageKey,
      accountUid: '42',
      target: 'owner-a',
      bindingVersion: 1,
      index: 0,
      total: 1,
      body: 'hello',
      requestId: makeRequestId({
        robotKey: 'bot-1',
        accountUid: '42',
        target: 'owner-a',
        bindingVersion: 1,
        messageKey,
        index: 0,
      }),
      state: 'planned',
      attempts: 0,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      nextRetryAt: 0,
      lastErrorCode: '',
      sentAt: null,
      supersededBy: '',
    };
  });
  return { store, messageKey, segmentKey };
}

test('legitimate sync and delivery records survive a reload', async () => {
  const fs = memoryFs();
  await seededStore(fs);
  const restored = createBiliDmStore({ dataDir: '/data', robotKey: 'bot-1', fs });
  await restored.ready;
  const state = restored.current();
  assert.equal(state.accounts['42'].conversations['1:91'].committed, '100');
  assert.equal(state.accounts['42'].messages[Object.keys(state.accounts['42'].messages)[0]].status, 'unfinished');
  assert.equal(Object.keys(state.accounts['42'].segments).length, 1);
});

test('corrupt segment request identity is rejected and file preserved', async () => {
  const fs = memoryFs();
  const { store, segmentKey } = await seededStore(fs);
  const state = JSON.parse(fs.files.get(store.filePath));
  state.accounts['42'].segments[segmentKey].requestId = 'bili-dm:forged';
  const bytes = JSON.stringify(state);
  fs.files.set(store.filePath, bytes);
  const restored = createBiliDmStore({ dataDir: '/data', robotKey: 'bot-1', fs });
  await assert.rejects(restored.ready, { code: 'DM_STATE_CORRUPT' });
  assert.equal(fs.files.get(store.filePath), bytes);
});

test('oversized in-memory state file is capped before parsing', async () => {
  const fs = memoryFs();
  const { store } = await seededStore(fs);
  const bytes = fs.files.get(store.filePath) + ' '.repeat(5000);
  fs.files.set(store.filePath, bytes);
  const restored = createBiliDmStore({
    dataDir: '/data', robotKey: 'bot-1', fs, maxFileBytes: 4096,
  });
  await assert.rejects(restored.ready, { code: 'DM_STATE_CORRUPT' });
  assert.equal(fs.files.get(store.filePath), bytes);
});

test('ensureAccount and prune helpers apply captured guards', async () => {
  const fs = memoryFs();
  const { store } = await seededStore(fs);
  await assert.rejects(store.ensureAccount('43', { guard: () => false }), { code: 'DM_STALE' });
  await assert.rejects(store.prune(1_800_000_000_000, { guard: () => false }), { code: 'DM_STALE' });
  assert.equal(store.current().accounts['43'], undefined);
});
