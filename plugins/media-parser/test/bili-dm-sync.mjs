import test from 'node:test';
import assert from 'node:assert/strict';
import { createBiliDmService, REQUEST_BUDGET } from '../bili-dm.js';
import { createBiliDmStore } from '../bili-dm-store.js';

const UID = '9007199254740993';
const T = 1_700_000_000_000;

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
    async rename(from, to) { files.set(to, files.get(from)); files.delete(from); },
    async unlink(file) { files.delete(file); },
    async mkdir() {},
  };
  return fs;
}

function settingsFake({
  cookie = 'SESSDATA=secret', enabled = true, poll = 60, includeSystem = false,
} = {}) {
  let value = cookie;
  let revision = value ? 1 : 0;
  const listeners = new Set();
  return {
    ready: Promise.resolve(),
    current: () => ({ biliDmEnabled: enabled, biliDmPollSeconds: poll, biliDmIncludeSystem: includeSystem }),
    getBiliCookie: () => value,
    getBiliCookieRevision: () => revision,
    subscribeBiliCookie(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async flush() {},
    async set(next) {
      value = next;
      revision += 1;
      for (const listener of listeners) listener({ revision, hasCookie: Boolean(value) });
    },
    async clearBiliCookie() {
      value = '';
      revision += 1;
      for (const listener of listeners) listener({ revision, hasCookie: false });
    },
  };
}

function rawMessage(seq, text, extra = {}) {
  return {
    sender_uid: '555',
    receiver_type: 1,
    receiver_id: UID,
    msg_type: 1,
    content: JSON.stringify({ content: text }),
    msg_seqno: String(seq),
    timestamp: 1700000000 + Number(seq),
    msg_key: String(7354295169819585966n + BigInt(seq)),
    msg_status: 0,
    ...extra,
  };
}

function session(talker, high, extra = {}) {
  return {
    talker_id: talker,
    session_type: 1,
    max_seqno: String(high),
    session_ts: String(T * 1000 + Number(high)),
    unread_count: 0,
    ack_seqno: String(high),
    is_intercept: 0,
    is_dnd: 1,
    system_msg_type: 0,
    last_msg: { msg_seqno: String(high), msg_key: String(7354295169819585966n + BigInt(high)) },
    ...extra,
  };
}

function clientFake({ nav, sessions, messages } = {}) {
  const calls = [];
  let navResult = nav;
  return {
    calls,
    setNav(value) { navResult = value; },
    async nav(cookie, options) {
      calls.push({ kind: 'nav', cookie, options });
      return navResult ? navResult(cookie, options) : { mid: UID, uname: '', serverTime: T };
    },
    async sessions(cookie, options) {
      calls.push({ kind: 'sessions', cookie, options });
      return sessions(cookie, options);
    },
    async messages(cookie, options) {
      calls.push({ kind: 'messages', cookie, options });
      return messages(cookie, options);
    },
  };
}

async function harness({
  client, settings = settingsFake(), autoSchedule = false, now = () => Date.now(), bind = true, storeOptions = {},
} = {}) {
  const fs = memoryFs();
  const store = createBiliDmStore({ dataDir: '/data', robotKey: 'bot-1', fs, now: () => T, ...storeOptions });
  await store.ready;
  if (bind) await store.bind('owner-1');
  const service = createBiliDmService({
    settings, client, store, now, autoSchedule, random: () => 0,
  });
  await service.ready;
  await service.start();
  return { fs, store, service, settings, client };
}

test('baseline anchors history, multi-page discovery completes, then catchup publishes ascending messages', async () => {
  let phase = 'baseline';
  const client = clientFake({
    sessions: async (cookie, { endTs }) => {
      if (endTs) throw new Error('unexpected extra page');
      if (phase === 'baseline') {
        return {
          sessions: [session('844424930131966', 5), session('844424930131967', 3)],
          hasMore: false,
          serverTime: T,
        };
      }
      return {
        sessions: [session('844424930131966', 8, { unread_count: 0, ack_seqno: '8' }), session('844424930131967', 3)],
        hasMore: false,
        serverTime: T + 60_000,
      };
    },
    messages: async (cookie, options) => ({
      messages: [rawMessage(8, '八'), rawMessage(7, '七'), rawMessage(6, '六')],
      hasMore: false,
      minSeqno: '6',
      maxSeqno: '8',
      eInfos: [],
      serverTime: T + 60_000,
    }),
  });
  const { store, service } = await harness({ client });
  await service.check();
  assert.equal(service.status().state, 'watching');
  assert.equal(client.calls.filter((call) => call.kind === 'messages').length, 0);
  let account = store.current().accounts[UID];
  assert.equal(Object.keys(account.messages).length, 0);
  assert.equal(account.conversations['1:844424930131966'].firstHigh, '5');

  phase = 'update';
  await service.check();
  account = store.current().accounts[UID];
  assert.equal(account.conversations['1:844424930131966'].committed, '8');
  assert.equal(account.conversations['1:844424930131966'].firstHigh, '5');
  const records = Object.values(account.messages);
  assert.equal(records.length, 3);
  assert.deepEqual(records.map((record) => record.seqno), ['6', '7', '8']);
  assert.equal(records[0].msgKey, (7354295169819585966n + 6n).toString());
  assert.equal(service.status().state, 'watching');
  assert.equal(service.status().queue.unfinished, 3);
});

test('new session after baseline only forwards messages at or after server monitor start', async () => {
  let phase = 'baseline';
  const client = clientFake({
    sessions: async () => (phase === 'baseline'
      ? { sessions: [session('100', 5)], hasMore: false, serverTime: T }
      : { sessions: [session('100', 5), session('200', 20)], hasMore: false, serverTime: T + 60_000 }),
    messages: async () => ({
      messages: [
        rawMessage(20, '新消息', { timestamp: Math.floor(T / 1000) + 30 }),
        rawMessage(19, '旧消息', { timestamp: Math.floor(T / 1000) - 30 }),
      ],
      hasMore: false,
      minSeqno: '19',
      maxSeqno: '20',
    }),
  });
  const { store, service } = await harness({ client });
  await service.check();
  phase = 'update';
  await service.check();
  const account = store.current().accounts[UID];
  assert.equal(account.conversations['1:200'].committed, '20');
  const texts = Object.values(account.messages).map((record) => record.text);
  assert.deepEqual(texts, ['新消息']);
});

test('read and unread counters never suppress new messages', async () => {
  const client = clientFake({
    sessions: async () => ({
      sessions: [session('300', 10, { unread_count: 0, ack_seqno: '10', is_dnd: 1 })],
      hasMore: false,
      serverTime: T,
    }),
    messages: async () => ({
      messages: [rawMessage(10, '已读但新增')], hasMore: false, minSeqno: '10', maxSeqno: '10',
    }),
  });
  const { store, service } = await harness({ client });
  await service.check();
  assert.equal(store.current().accounts[UID].conversations['1:300'].firstHigh, '10');
  await store.transaction((draft) => {
    draft.accounts[UID].conversations['1:300'].lastHigh = '11';
  });
  const withNext = clientFake({
    sessions: async () => ({
      sessions: [session('300', 11, { unread_count: 0, ack_seqno: '11' })],
      hasMore: false,
      serverTime: T,
    }),
    messages: async () => ({
      messages: [rawMessage(11, '已读但新增')], hasMore: false, minSeqno: '11', maxSeqno: '11',
    }),
  });
  const second = createBiliDmService({
    settings: settingsFake(), client: withNext, store, autoSchedule: false, now: () => T,
  });
  await second.ready;
  await second.start();
  await second.check();
  const records = Object.values(store.current().accounts[UID].messages);
  assert.equal(records.some((record) => record.text === '已读但新增'), true);
});

test('same-timestamp full discovery page is an explicit ambiguous gap, never watching', async () => {
  const same = String(T * 1000);
  const sessions = Array.from({ length: 100 }, (_, index) => session(String(1000 + index), 3, { session_ts: same }));
  const client = clientFake({
    sessions: async () => ({ sessions, hasMore: true, serverTime: T }),
  });
  const { store, service } = await harness({ client });
  await service.check();
  const status = service.status();
  assert.equal(status.state, 'error');
  assert.equal(status.reasonCode, 'DM_AMBIGUOUS_CURSOR');
  assert.equal(status.discovery.gap, true);
  assert.equal(store.current().accounts[UID].discovery.endTs, same);
  assert.equal(store.current().accounts[UID].discovery.baselineComplete, false);
});

test('has_more with no cursor progress stops with a visible gap', async () => {
  const client = clientFake({
    sessions: async () => ({ sessions: [session('400', 3)], hasMore: true, serverTime: T }),
  });
  const { service } = await harness({ client });
  await service.check();
  assert.equal(service.status().state, 'error');
  assert.equal(['DM_GAP', 'DM_AMBIGUOUS_CURSOR'].includes(service.status().reasonCode), true);
});

test('request budget continues discovery across rounds without restarting the cursor', async () => {
  let counter = 0;
  const ends = [];
  const client = clientFake({
    sessions: async (cookie, { endTs }) => {
      ends.push(endTs || '');
      const start = endTs ? BigInt(endTs) : BigInt(10_000_000);
      const list = Array.from({ length: 100 }, (_, index) => {
        counter += 1;
        return session(String(10_000 + counter), 1, { session_ts: String(start - BigInt(index)) });
      });
      return { sessions: list, hasMore: true, serverTime: T };
    },
  });
  const { store, service } = await harness({ client });
  await service.check();
  const status = service.status();
  assert.equal(status.state, 'catching_up');
  assert.equal(status.reasonCode, 'DM_BUDGET');
  assert.equal(client.calls.length, REQUEST_BUDGET);
  const firstEnd = store.current().accounts[UID].discovery.endTs;
  assert.equal(Boolean(firstEnd), true);
  const before = client.calls.length;
  await service.check();
  assert.equal(client.calls.length > before, true);
  assert.equal(ends[REQUEST_BUDGET - 1], firstEnd);
});

test('restart resumes the same UID baseline and catches up from the persisted cursor', async () => {
  let phase = 'baseline';
  const client = clientFake({
    sessions: async () => ({
      sessions: [session('500', 5)], hasMore: false, serverTime: T,
    }),
    messages: async () => ({
      messages: [rawMessage(7, '另一条'), rawMessage(6, '停服期间')], hasMore: false,
      minSeqno: '6', maxSeqno: '7',
    }),
  });
  const { store, service } = await harness({ client });
  await service.check();
  assert.equal(service.status().state, 'watching');
  phase = 'update';
  client.setNav(() => ({ mid: UID, uname: '', serverTime: T + 60_000 }));
  client.sessions = async () => ({
    sessions: [session('500', 7)], hasMore: false, serverTime: T + 60_000,
  });
  const restarted = createBiliDmService({
    settings: settingsFake(), client, store, autoSchedule: false, now: () => T + 60_000,
  });
  await restarted.ready;
  await restarted.start();
  await restarted.check();
  const account = store.current().accounts[UID];
  assert.equal(account.conversations['1:500'].committed, '7');
  assert.deepEqual(
    Object.values(account.messages).map((record) => record.seqno),
    ['6', '7'],
  );
  assert.equal(account.conversations['1:500'].firstHigh, '5');
  assert.equal(phase, 'update');
});

test('different UID gets a fresh namespace and switching back restores the old account', async () => {
  let mid = UID;
  const client = clientFake({
    nav: async () => ({ mid, uname: '', serverTime: T }),
    sessions: async () => ({
      sessions: [session(mid === UID ? '600' : '700', mid === UID ? 5 : 9)],
      hasMore: false,
      serverTime: T,
    }),
    messages: async () => ({ messages: [], hasMore: false, minSeqno: '0', maxSeqno: '0' }),
  });
  const settings = settingsFake();
  const { store, service } = await harness({ client, settings });
  await service.check();
  assert.equal(store.current().currentUid, UID);
  mid = '123456789';
  await settings.set('SESSDATA=second');
  await service.check();
  assert.equal(store.current().currentUid, '123456789');
  assert.equal(Boolean(store.current().accounts[UID]), true);
  assert.equal(Boolean(store.current().accounts['123456789']), true);
  assert.equal(store.current().accounts[UID].conversations['1:600'].committed, '5');
  mid = UID;
  await settings.set('SESSDATA=third');
  await service.check();
  assert.equal(store.current().currentUid, UID);
  assert.equal(store.current().accounts[UID].conversations['1:600'].committed, '5');
});

test('login-invalid stops reading, keeps the cookie and exposes only a safe reason', async () => {
  const client = clientFake({
    nav: async () => { throw Object.assign(new Error('SESSDATA=secret'), { code: 'BILI_AUTH' }); },
  });
  const settings = settingsFake();
  const { service } = await harness({ client, settings });
  await service.check();
  assert.equal(service.status().state, 'waiting_login');
  assert.equal(service.status().reasonCode, 'DM_AUTH');
  assert.equal(settings.getBiliCookie().includes('SESSDATA=secret'), true);
  assert.equal(JSON.stringify(service.status()).includes('SESSDATA'), false);
});

test('network failure backs off and manual checks respect the retry time', async () => {
  let clock = T;
  let fail = true;
  const client = clientFake({
    nav: async () => {
      if (fail) throw Object.assign(new Error('network down'), { code: 'BILI_NETWORK' });
      return { mid: UID, uname: '', serverTime: clock };
    },
    sessions: async () => ({ sessions: [], hasMore: false, serverTime: clock }),
  });
  const { service } = await harness({ client, now: () => clock });
  await service.check();
  assert.equal(service.status().state, 'backoff');
  assert.equal(service.status().reasonCode, 'DM_NETWORK');
  const calls = client.calls.length;
  await service.check();
  assert.equal(client.calls.length, calls);
  clock += 61_000;
  fail = false;
  await service.check();
  assert.equal(service.status().state, 'watching');
});

test('a late response after pause is cancelled and cannot commit stale state', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const client = clientFake({
    sessions: async () => {
      await gate;
      return { sessions: [session('800', 4)], hasMore: false, serverTime: T };
    },
  });
  const { store, service } = await harness({ client });
  const running = service.check();
  await Promise.resolve();
  service.pause();
  release();
  await running;
  const account = store.current().accounts[UID];
  assert.equal(service.status().state, 'disabled');
  assert.equal(account?.conversations?.['1:800'], undefined);
  assert.equal(account?.discovery?.baselineComplete || false, false);
});

test('single-fault notices are deduped per fault cycle and recovered once', async () => {
  let fail = true;
  const client = clientFake({
    nav: async () => {
      if (fail) throw Object.assign(new Error('down'), { code: 'BILI_NETWORK' });
      return { mid: UID, uname: '', serverTime: T };
    },
    sessions: async () => ({ sessions: [], hasMore: false, serverTime: T }),
  });
  let clock = T;
  const { service } = await harness({ client, now: () => clock });
  await service.check();
  assert.equal(service.status().state, 'backoff');
  const first = service.consumeNotice();
  assert.equal(first?.code, 'DM_NETWORK');
  clock += 61_000;
  await service.check();
  assert.equal(service.consumeNotice(), null);
  fail = false;
  clock += 200_000;
  await service.check();
  assert.equal(service.status().state, 'watching');
  const recovered = service.consumeNotice();
  assert.equal(recovered?.code, 'DM_RECOVERED');
  assert.equal(service.consumeNotice(), null);
});

test('an incomplete message page below the captured target is a visible gap and never advances', async () => {
  let phase = 'baseline';
  const client = clientFake({
    sessions: async () => (phase === 'baseline'
      ? { sessions: [session('940', 5)], hasMore: false, serverTime: T }
      : { sessions: [session('940', 20)], hasMore: false, serverTime: T + 60_000 }),
    messages: async () => ({
      messages: [rawMessage(10, '只有一半')], hasMore: false, minSeqno: '10', maxSeqno: '10',
    }),
  });
  const { store, service } = await harness({ client });
  await service.check();
  phase = 'update';
  await service.check();
  assert.equal(service.status().state, 'error');
  assert.equal(service.status().reasonCode, 'DM_GAP');
  const account = store.current().accounts[UID];
  assert.equal(account.conversations['1:940'].committed, '5');
  assert.equal(Object.keys(account.messages).length, 0);
});

test('capacity pauses fetching without advancing the committed cursor or dropping the continuation', async () => {
  let phase = 'baseline';
  const client = clientFake({
    sessions: async () => (phase === 'baseline'
      ? { sessions: [session('950', 2)], hasMore: false, serverTime: T }
      : { sessions: [session('950', 4)], hasMore: false, serverTime: T + 60_000 }),
    messages: async () => ({
      messages: [rawMessage(4, '四'), rawMessage(3, '三')],
      hasMore: false, minSeqno: '3', maxSeqno: '4',
    }),
  });
  const { store, service } = await harness({ client, storeOptions: { maxUnfinished: 1 } });
  await service.check();
  phase = 'update';
  await service.check();
  assert.equal(service.status().state, 'paused_capacity');
  const account = store.current().accounts[UID];
  assert.equal(account.conversations['1:950'].committed, '2');
  assert.equal(Object.keys(account.messages).length, 0);
});

test('status is a whitelist without UID, owner target, sender, body or credentials', async () => {
  const client = clientFake({
    sessions: async () => ({ sessions: [session('900', 2)], hasMore: false, serverTime: T }),
  });
  const { service } = await harness({ client, settings: settingsFake({ cookie: 'SESSDATA=private-cookie' }) });
  await service.check();
  const text = JSON.stringify(service.status());
  for (const secret of [UID, 'owner-1', 'private-cookie', '900', '555']) {
    assert.equal(text.includes(secret), false);
  }
  assert.equal(service.status().binding.bound, true);
  assert.match(service.status().binding.mask, /^\*\*\*/);
});
