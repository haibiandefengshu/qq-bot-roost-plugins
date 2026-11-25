import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { NovelService } from '../lib/service.mjs';

const OWNER_INVOCATION = Object.freeze({
  source: 'panel',
  ownerVerified: true,
  requestId: 'reading-service-test',
});

function official(overrides = {}) {
  return {
    available: true,
    configured: true,
    provider: 'edge',
    voice: 'global-voice',
    speed: 1.25,
    savedSpeed: 1.25,
    effectiveSpeed: 1.25,
    globalSpeed: 1.25,
    supportsSpeed: false,
    supportsSpeedOverride: false,
    supportsVoiceOverride: false,
    engineChecked: false,
    missing: [],
    limitations: ['只使用已保存的全局语音配置。'],
    ...overrides,
  };
}

function makeHarness(t, sources, bookVoice = null) {
  const root = mkdtempSync(join(tmpdir(), 'novel-service-reading-'));
  const runtime = {
    version: 1,
    dataDir: root,
    ffmpegBinary: () => '',
    model: { status: () => ({ configured: true }) },
    voice: {
      async listSources() { return sources; },
    },
    artifacts: { async cleanup() { return { removed: 0 }; } },
    dependencies: { status: () => ({}) },
  };
  const service = new NovelService({ runtime, now: Date.now, log: () => {} });
  service.pump = () => {};
  clearInterval(service.cleanupTimer);
  const owner = service.store.key(OWNER_INVOCATION);
  const bookId = 'book-reading-1';
  t.after(async () => {
    await service.shutdown({ timeoutMs: 1000 });
    rmSync(root, { recursive: true, force: true });
  });
  return { service, owner, bookId, root, runtime, source: sources, bookVoice };
}

async function seed(harness) {
  await seedOwner(harness, OWNER_INVOCATION, harness.bookVoice);
  return harness;
}

async function seedOwner(harness, invocation, bookVoice) {
  const { service, bookId } = harness;
  const owner = service.store.key(invocation);
  await service.store.updateLibrary(owner, (library) => {
    library.books.push({
      id: bookId,
      no: 1,
      title: '朗读设置测试书',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      settings: {
        core: '', genre: '', world: '', style: '', avoid: '', targetChars: 3000,
      },
      people: [],
      outline: [],
      chapters: [],
      memory: { validThrough: 0, cumulative: '', states: [] },
      autoRead: false,
      voice: bookVoice || { source: '', profileId: '', voice: '', speed: 1 },
      audioArtifacts: {},
      generatedOutline: [],
    });
    library.currentBookId = bookId;
    library.nextBookNo = 2;
    return library;
  });
  return owner;
}

function qqInvocation(suffix) {
  return {
    source: 'qq',
    botId: 'reading-bot',
    kind: 'c2c',
    chatId: 'reading-chat',
    userId: 'reading-user',
    messageId: `reading-${suffix}`,
    receivedAt: Date.now(),
    mentioned: true,
  };
}

test('voice sources keep official limits, saved/effective speeds and extension errors', async (t) => {
  const harness = makeHarness(t, {
    official: official({
      savedSpeed: 1.25,
      effectiveSpeed: 1,
      globalSpeed: 1.25,
      provider: 'mimo',
      voice: 'mimo-voice',
      engineChecked: true,
      missing: ['API Key'],
      limitations: ['MiMo 固定原速。'],
      error: 'engine unavailable',
    }),
    extension: {
      available: false,
      configured: false,
      profiles: [{ id: 'p1', name: '方案一' }],
      missing: ['参考音频'],
      limitations: ['扩展限制'],
      error: '扩展不可用',
    },
  });
  await seed(harness);
  const result = await harness.service.handlePanel({ op: 'books' }, OWNER_INVOCATION);
  const voice = result.data.voice;
  assert.equal(voice.official.speed, 1);
  assert.equal(voice.official.savedSpeed, 1.25);
  assert.equal(voice.official.effectiveSpeed, 1);
  assert.equal(voice.official.globalSpeed, 1.25);
  assert.equal(voice.official.supportsSpeed, false);
  assert.equal(voice.official.supportsSpeedOverride, false);
  assert.equal(voice.official.supportsVoiceOverride, false);
  assert.equal(voice.official.engineChecked, true);
  assert.deepEqual(voice.official.missing, ['API Key']);
  assert.deepEqual(voice.official.limitations, ['MiMo 固定原速。']);
  assert.equal(voice.official.error, 'engine unavailable');
  assert.deepEqual(voice.extension.missing, ['参考音频']);
  assert.deepEqual(voice.extension.limitations, ['扩展限制']);
  assert.equal(voice.extension.error, '扩展不可用');
  assert.equal(voice.extension.profiles[0].name, '方案一');
});

test('useCurrentGlobal applies effective official values and only for official', async (t) => {
  const harness = makeHarness(t, {
    official: official({ voice: 'current-global', effectiveSpeed: 1.25 }),
    extension: { available: true, configured: true, profiles: [{ id: 'p1', name: '方案一' }] },
  }, { source: 'official', profileId: '', voice: 'old-voice', speed: 1 });
  await seed(harness);
  const applied = await harness.service.handlePanel({
    op: 'setReading',
    bookId: harness.bookId,
    autoRead: true,
    useCurrentGlobal: true,
    voice: { source: 'official', profileId: '', voice: 'old-voice', speed: 1 },
  }, OWNER_INVOCATION);
  assert.equal(applied.ok, true);
  assert.equal(applied.data.voice.voice, 'current-global');
  assert.equal(applied.data.voice.speed, 1.25);
  assert.equal(applied.data.autoRead, true);
  const stored = harness.service.store.book(harness.owner, harness.bookId);
  assert.equal(stored.voice.voice, 'current-global');
  assert.equal(stored.voice.speed, 1.25);

  await assert.rejects(() => harness.service.handlePanel({
    op: 'setReading',
    bookId: harness.bookId,
    useCurrentGlobal: true,
    voice: { source: 'extension', profileId: 'p1', speed: 1 },
  }, OWNER_INVOCATION), /只有官方/);
});

test('ordinary official saves strictly reject speed and voice differences without mutation', async (t) => {
  const harness = makeHarness(t, {
    official: official({ effectiveSpeed: 1.25 }),
  }, { source: 'official', profileId: '', voice: 'old-voice', speed: 1 });
  await seed(harness);
  await assert.rejects(() => harness.service.handlePanel({
    op: 'setReading',
    bookId: harness.bookId,
    voice: { source: 'official', profileId: '', voice: 'global-voice', speed: 1 },
  }, OWNER_INVOCATION), /实际语速 1\.25/);
  let stored = harness.service.store.book(harness.owner, harness.bookId);
  assert.equal(stored.voice.voice, 'old-voice');
  assert.equal(stored.voice.speed, 1);

  await assert.rejects(() => harness.service.handlePanel({
    op: 'setReading',
    bookId: harness.bookId,
    voice: { source: 'official', profileId: '', voice: 'other-voice', speed: 1.25 },
  }, OWNER_INVOCATION), /全局音色/);
  stored = harness.service.store.book(harness.owner, harness.bookId);
  assert.equal(stored.voice.voice, 'old-voice');

  const saved = await harness.service.handlePanel({
    op: 'setReading',
    bookId: harness.bookId,
    voice: { source: 'official', profileId: '', voice: 'global-voice', speed: 1.25 },
  }, OWNER_INVOCATION);
  assert.equal(saved.ok, true);
  stored = harness.service.store.book(harness.owner, harness.bookId);
  assert.equal(stored.voice.voice, 'global-voice');
  assert.equal(stored.voice.speed, 1.25);
});

test('MiMo effective speed 1 validates against effective, not saved 1.25', async (t) => {
  const harness = makeHarness(t, {
    official: official({
      provider: 'mimo',
      voice: 'mimo-voice',
      speed: 1,
      savedSpeed: 1.25,
      effectiveSpeed: 1,
      globalSpeed: 1.25,
      limitations: ['MiMo 固定原速。'],
    }),
  }, { source: 'official', profileId: '', voice: 'stale-voice', speed: 1.25 });
  await seed(harness);
  await assert.rejects(() => harness.service.handlePanel({
    op: 'setReading',
    bookId: harness.bookId,
    voice: { source: 'official', profileId: '', voice: 'mimo-voice', speed: 1.25 },
  }, OWNER_INVOCATION), /实际语速 1/);
  let stored = harness.service.store.book(harness.owner, harness.bookId);
  assert.equal(stored.voice.speed, 1.25);

  const saved = await harness.service.handlePanel({
    op: 'setReading',
    bookId: harness.bookId,
    voice: { source: 'official', profileId: '', voice: 'mimo-voice', speed: 1 },
  }, OWNER_INVOCATION);
  assert.equal(saved.ok, true);
  stored = harness.service.store.book(harness.owner, harness.bookId);
  assert.equal(stored.voice.speed, 1);

  const applied = await harness.service.handlePanel({
    op: 'setReading',
    bookId: harness.bookId,
    useCurrentGlobal: true,
    voice: { source: 'official', profileId: '', voice: 'mimo-voice', speed: 1 },
  }, OWNER_INVOCATION);
  assert.equal(applied.data.voice.speed, 1);
});

test('QQ official voice settings validate against effective global speed and voice', async (t) => {
  const harness = makeHarness(t, {
    official: official({
      provider: 'mimo',
      voice: 'mimo-voice',
      speed: 1,
      savedSpeed: 1.25,
      effectiveSpeed: 1,
      globalSpeed: 1.25,
    }),
  }, { source: 'official', profileId: '', voice: 'mimo-voice', speed: 1 });
  const qqOwner = await seedOwner(harness, qqInvocation('seed'), {
    source: 'official', profileId: '', voice: 'mimo-voice', speed: 1,
  });
  const accepted = await harness.service.handleQq({
    command: '小说',
    args: ['朗读', '设置', '官方'],
  }, qqInvocation('accepted'));
  assert.match(accepted.text, /已设置当前书朗读方式/);
  assert.equal(harness.service.store.book(qqOwner, harness.bookId).voice.speed, 1);

  const rejectedSpeed = await harness.service.handleQq({
    command: '小说',
    args: ['朗读', '设置', '官方', '1.25'],
  }, qqInvocation('bad-speed'));
  assert.match(rejectedSpeed.text, /实际语速 1/);
  assert.equal(harness.service.store.book(qqOwner, harness.bookId).voice.speed, 1);

  const rejectedVoice = await harness.service.handleQq({
    command: '小说',
    args: ['朗读', '设置', '官方', 'other-voice'],
  }, qqInvocation('bad-voice'));
  assert.match(rejectedVoice.text, /全局音色/);
  assert.equal(harness.service.store.book(qqOwner, harness.bookId).voice.voice, 'mimo-voice');
});

test('legacy injected runtime that advertises speed override still accepts custom values', async (t) => {
  const harness = makeHarness(t, {
    official: {
      available: true,
      configured: true,
      provider: 'legacy',
      voice: 'legacy-voice',
      supportsSpeed: true,
    },
  });
  await seed(harness);
  const saved = await harness.service.handlePanel({
    op: 'setReading',
    bookId: harness.bookId,
    voice: { source: 'official', profileId: '', voice: 'legacy-custom', speed: 1.5 },
  }, OWNER_INVOCATION);
  assert.equal(saved.ok, true);
  const stored = harness.service.store.book(harness.owner, harness.bookId);
  assert.equal(stored.voice.voice, 'legacy-custom');
  assert.equal(stored.voice.speed, 1.5);
});
