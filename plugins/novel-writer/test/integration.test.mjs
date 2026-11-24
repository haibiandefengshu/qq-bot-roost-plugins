import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { splitForSpeech } from '../lib/audio.mjs';
import { NovelService } from '../lib/service.mjs';
import { hash } from '../lib/util.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
let sequence = 0;

function invocation(user = 'integration-user', messageId = '') {
  return {
    source: 'qq',
    botId: 'integration-bot',
    kind: 'c2c',
    chatId: 'integration-chat',
    userId: user,
    messageId: messageId || `integration-message-${++sequence}`,
    receivedAt: Date.now(),
    mentioned: true,
  };
}

function chapterResponse(title = '第一章 夜行', marker = '主街') {
  return JSON.stringify({
    chapterTitle: title,
    body: `${marker}。主角沿着夜色中的长街前进，发现新的线索，并决定继续追查。`.repeat(24),
    summary: `主角在${marker}发现线索并继续调查。`,
    states: [`${marker}：调查继续`, '主角：保持警惕'],
  });
}

function summaryResponse(marker = '主线') {
  return JSON.stringify({
    summary: `${marker}摘要：主角已经发现线索，下一步将追查来源。`,
    states: [`${marker}状态：线索已登记`],
  });
}

function createHarness(t, {
  modelGenerate = async () => { throw new Error('unexpected model call'); },
  voice = null,
  ffmpegBinary = () => '',
  beforeArtifactRegister = null,
} = {}) {
  const root = mkdtempSync(join(TEST_DIR, '.tmp-integration-'));
  const artifacts = new Map();
  const runtime = {
    version: 1,
    dataDir: root,
    ffmpegBinary,
    model: {
      async generate(request) {
        return { text: await modelGenerate(request) };
      },
    },
    voice: voice || {
      async listSources() {
        return {
          official: { configured: false },
          extension: { configured: false, profiles: [] },
        };
      },
    },
    artifacts: {
      async register(data) {
        if (beforeArtifactRegister) await beforeArtifactRegister(data);
        const id = `artifact-${artifacts.size + 1}-${sequence++}`;
        artifacts.set(id, { ...data, id });
        return { id, fileName: data.fileName, bytes: data.bytes };
      },
      resolve(id, ownerKey) {
        const row = artifacts.get(id);
        if (!row || row.ownerKey !== ownerKey) throw new Error('成果不存在或不属于当前书库');
        return row;
      },
      async cleanup() { return { removed: 0 }; },
    },
    dependencies: { status: () => ({}) },
  };
  const service = new NovelService({ runtime, now: Date.now, log: () => {} });
  service.pump = () => {};
  clearInterval(service.cleanupTimer);
  t.after(() => {
    for (const controller of service.controllers.values()) controller.abort();
    clearInterval(service.cleanupTimer);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, runtime, artifacts, service };
}

async function seedBook(service, owner, {
  title = '集成测试书',
  settings = {},
  outline = [],
  memory = { validThrough: 0, cumulative: '', states: [] },
} = {}) {
  let bookId = '';
  await service.store.updateLibrary(owner, (library) => {
    const no = Number(library.nextBookNo) || 1;
    bookId = `book-integration-${no}-${sequence++}`;
    library.books.push({
      id: bookId,
      no,
      title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      settings: {
        core: '', genre: '悬疑', world: '', style: '', avoid: '', targetChars: 1000,
        ...settings,
      },
      people: [],
      outline,
      chapters: [],
      memory,
      autoRead: false,
      voice: { source: '', profileId: '', voice: '', speed: 1 },
      audioArtifacts: {},
      generatedOutline: [],
    });
    library.nextBookNo = no + 1;
    library.currentBookId = bookId;
    return library;
  });
  return bookId;
}

async function qq(service, args, inv = invocation()) {
  return await service.handleQq({
    command: '小说',
    args,
    text: `/小说 ${args.join(' ')}`,
  }, inv);
}

async function direct(service, text, inv = invocation()) {
  return await service.handleDirect({ direct: true, args: [], text }, inv);
}

function assertBomCrlf(bytes) {
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0a) assert.equal(bytes[index - 1], 0x0d);
  }
}

test('fake model 完成一章并生成 memory、TXT artifact 和单一 queued outbox', async (t) => {
  const stages = [];
  const { service, artifacts } = createHarness(t, {
    async modelGenerate(request) {
      stages.push(request.stage);
      if (request.stage === 'chapter_1') return chapterResponse();
      if (request.stage === 'summary_1') return summaryResponse();
      throw new Error(`unexpected stage: ${request.stage}`);
    },
  });
  const inv = invocation('write-owner');
  const owner = service.store.key(inv);
  const bookId = await seedBook(service, owner, {
    settings: {
      world: '世界观私有设定',
      style: '文风私有设定',
    },
    outline: ['大纲私有内容'],
  });

  const started = await qq(service, ['续写', '1章'], inv);
  assert.equal(started.taskId, started.watchTaskIds[0]);
  const task = service.store.task(started.taskId);
  await service.runTask(task);

  const savedTask = service.store.task(started.taskId);
  const book = service.store.currentBook(owner);
  assert.deepEqual(stages, ['chapter_1', 'summary_1']);
  assert.equal(savedTask.status, 'done');
  assert.equal(book.id, bookId);
  assert.equal(book.chapters.length, 1);
  assert.equal(book.chapters[0].currentVersion, 1);
  assert.equal(book.memory.validThrough, 1);
  assert.match(book.memory.cumulative, /主线摘要/);
  assert.match(savedTask.notice, /第 1 章已保存，TXT：/);
  assert.equal(savedTask.outbox.length, 1);
  assert.equal(savedTask.outbox[0].kind, 'txt');
  assert.equal(savedTask.outbox[0].state, 'queued');
  assert.equal(savedTask.outbox[0].chapterNos.length, 1);
  assert.equal(savedTask.outbox[0].chapterNos[0], 1);

  const txtArtifact = [...artifacts.values()].find((item) => item.kind === 'txt');
  assert.ok(txtArtifact);
  const bytes = readFileSync(txtArtifact.path);
  assertBomCrlf(bytes);
  const text = bytes.toString('utf8');
  assert.match(text, /第一章 夜行/);
  assert.match(text, /主街。/);
  for (const secret of ['世界观私有设定', '文风私有设定', '大纲私有内容']) {
    assert.equal(text.includes(secret), false);
  }
});

test('停止 queued 任务后不会落稿或生成 outbox', async (t) => {
  const { service } = createHarness(t);
  const inv = invocation('queued-stop-owner');
  const owner = service.store.key(inv);
  const bookId = await seedBook(service, owner);
  const started = await qq(service, ['续写', '1章'], inv);

  await qq(service, ['停止', started.taskId], invocation('queued-stop-owner'));
  const task = service.store.task(started.taskId);
  assert.equal(task.status, 'cancelled');
  assert.equal(service.store.library(owner).books.find((book) => book.id === bookId).chapters.length, 0);
  assert.deepEqual(task.outbox, []);
});

test('停止 running 任务后迟到模型结果不会提交', async (t) => {
  let release;
  let startedResolve;
  const released = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const { service } = createHarness(t, {
    async modelGenerate(request) {
      if (request.stage !== 'chapter_1') throw new Error(`unexpected stage: ${request.stage}`);
      startedResolve();
      await released;
      return chapterResponse();
    },
  });
  const inv = invocation('running-stop-owner');
  const owner = service.store.key(inv);
  const bookId = await seedBook(service, owner);
  const queued = await qq(service, ['续写', '1章'], inv);
  const running = service.runTask(service.store.task(queued.taskId));
  await started;

  await qq(service, ['停止', queued.taskId], invocation('running-stop-owner'));
  release();
  await running;
  const task = service.store.task(queued.taskId);
  assert.equal(task.status, 'cancelled');
  assert.equal(service.store.library(owner).books.find((book) => book.id === bookId).chapters.length, 0);
  assert.deepEqual(task.outbox, []);
});

test('生成期间人工新版本使任务进入冲突，迟到结果只保留为候选', async (t) => {
  let release;
  let startedResolve;
  const released = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const { service } = createHarness(t, {
    async modelGenerate(request) {
      if (request.stage !== 'rewrite_1') throw new Error(`unexpected stage: ${request.stage}`);
      startedResolve();
      await released;
      return chapterResponse('自动重写标题', '自动版本');
    },
  });
  const inv = invocation('conflict-owner');
  const owner = service.store.key(inv);
  const bookId = await seedBook(service, owner);
  await service.store.appendVersion(owner, bookId, 1, {
    title: '第一章 原稿',
    body: '这是原稿正文。',
    source: 'test',
  });

  const queued = await qq(service, ['重写', '1', '改善衔接'], inv);
  const running = service.runTask(service.store.task(queued.taskId));
  await started;

  await qq(service, ['修改', '1'], invocation('conflict-owner'));
  await direct(service, '人工写出的正文。', invocation('conflict-owner'));
  await assert.rejects(
    () => direct(service, '完成', invocation('conflict-owner')),
    /写作任务/,
  );
  await service.store.appendVersion(owner, bookId, 1, {
    title: '第一章 人工版',
    body: '人工新版本必须保留。',
    source: 'manual',
  });
  release();
  await running;

  const task = service.store.task(queued.taskId);
  const book = service.store.currentBook(owner);
  const current = service.store.readVersion(owner, bookId, 1, book.chapters[0].currentVersion);
  assert.equal(task.status, 'conflict');
  assert.equal(task.stage, 'conflict');
  assert.equal(task.pendingCandidate.source, 'rewrite');
  assert.match(task.pendingCandidate.body, /自动版本/);
  assert.equal(task.outbox.some((item) => item.state === 'queued'), false);
  assert.equal(book.chapters[0].currentVersion, 2);
  assert.equal(current.body, '人工新版本必须保留。');
});

test('TXT 导出登记期间停止不会留下 queued outbox', async (t) => {
  let release;
  let startedResolve;
  const released = new Promise((resolve) => { release = resolve; });
  const registerStarted = new Promise((resolve) => { startedResolve = resolve; });
  const { service } = createHarness(t, {
    async modelGenerate(request) {
      if (request.stage === 'chapter_1') return chapterResponse();
      if (request.stage === 'summary_1') return summaryResponse();
      throw new Error(`unexpected stage: ${request.stage}`);
    },
    async beforeArtifactRegister(data) {
      if (data.kind !== 'txt') return;
      startedResolve();
      await released;
    },
  });
  const inv = invocation('export-stop-owner');
  const owner = service.store.key(inv);
  await seedBook(service, owner);
  const queued = await qq(service, ['续写', '1章'], inv);
  const running = service.runTask(service.store.task(queued.taskId));
  await registerStarted;

  await qq(service, ['停止', queued.taskId], invocation('export-stop-owner'));
  release();
  await running;

  const task = service.store.task(queued.taskId);
  assert.equal(task.status, 'cancelled');
  assert.equal(task.outbox.some((item) => ['queued', 'sending', 'pending'].includes(item.state)), false);
  assert.equal(service.store.currentBook(owner).chapters.length, 1);
});

test('自动朗读入队临界点停止会同时取消子任务且 watch 不发送', async (t) => {
  let release;
  let startedResolve;
  const released = new Promise((resolve) => { release = resolve; });
  const speechQueued = new Promise((resolve) => { startedResolve = resolve; });
  const { service } = createHarness(t, {
    async modelGenerate(request) {
      if (request.stage === 'chapter_1') return chapterResponse();
      if (request.stage === 'summary_1') return summaryResponse();
      throw new Error(`unexpected stage: ${request.stage}`);
    },
    ffmpegBinary: () => 'ffmpeg-for-auto-speech-boundary',
  });
  const inv = invocation('auto-speech-stop-owner');
  const owner = service.store.key(inv);
  const bookId = await seedBook(service, owner);
  await service.store.updateLibrary(owner, (library) => {
    const book = library.books.find((item) => item.id === bookId);
    book.autoRead = true;
    book.voice = { source: 'official', voice: 'integration-voice', speed: 1 };
    return library;
  });
  const queued = await qq(service, ['续写', '1章'], inv);
  const originalEnqueue = service.enqueue.bind(service);
  service.enqueue = async (options) => {
    const created = await originalEnqueue(options);
    if (options.kind === 'speech') {
      startedResolve(created.id);
      await released;
    }
    return created;
  };
  const running = service.runTask(service.store.task(queued.taskId));
  const speechTaskId = await speechQueued;

  await qq(service, ['停止', queued.taskId], invocation('auto-speech-stop-owner'));
  release();
  await running;

  const parent = service.store.task(queued.taskId);
  const speech = service.store.task(speechTaskId);
  assert.equal(parent.status, 'cancelled');
  assert.ok(parent.followUps.includes(speechTaskId));
  assert.equal(speech.status, 'cancelled');
  assert.equal(speech.outbox.some((item) => item.state === 'queued'), false);
  const watched = await service.watch(owner, speechTaskId, invocation('auto-speech-stop-owner'));
  assert.deepEqual(watched.outbox, []);
});

test('父任务停止会阻断已完成但尚未发送的自动朗读子任务', async (t) => {
  const { service, runtime } = createHarness(t);
  const inv = invocation('done-follow-up-stop-owner');
  const owner = service.store.key(inv);
  const parent = await service.enqueue({
    kind: 'write',
    owner,
    invocation: inv,
    input: {},
  });
  const child = await service.enqueue({
    kind: 'speech',
    owner,
    invocation: inv,
    input: {},
  });
  const artifact = await runtime.artifacts.register({
    ownerKey: owner,
    fileName: 'automatic-audio.mp3',
    bytes: Buffer.from('completed-audio'),
  });

  parent.followUps = [child.id];
  child.status = 'done';
  child.stage = 'done';
  child.outbox = [{
    artifactId: artifact.id,
    fileName: artifact.fileName,
    kind: 'audio',
    state: 'queued',
  }];
  await service.store.saveTask(parent);
  await service.store.saveTask(child);

  const before = await service.outboxFor(owner, [child], inv);
  assert.equal(before.outbox.length, 1);

  await service.cancelFollowUps(parent);

  const savedChild = service.store.task(child.id);
  assert.equal(savedChild.status, 'done');
  assert.equal(savedChild.cancelRequested, true);
  assert.equal(savedChild.outbox[0].state, 'cancelled');
  const after = await service.outboxFor(owner, [savedChild], inv);
  assert.deepEqual(after.outbox, []);
});

test('摘要失败后重试复用已提交章节并只补摘要', async (t) => {
  const stages = [];
  let summaryFailures = 1;
  const { service } = createHarness(t, {
    async modelGenerate(request) {
      stages.push(request.stage);
      if (request.stage === 'chapter_1') return chapterResponse();
      if (request.stage === 'summary_1') {
        if (summaryFailures > 0) {
          summaryFailures -= 1;
          throw new Error('模拟摘要失败');
        }
        return summaryResponse('重试');
      }
      throw new Error(`unexpected stage: ${request.stage}`);
    },
  });
  const inv = invocation('retry-owner');
  const owner = service.store.key(inv);
  await seedBook(service, owner);

  const first = await qq(service, ['续写', '1章'], inv);
  await service.runTask(service.store.task(first.taskId));
  const failed = service.store.task(first.taskId);
  assert.equal(failed.status, 'error');
  assert.equal(failed.completed.chapters.length, 1);
  assert.deepEqual(failed.pendingSummary, { chapterNo: 1, versionNo: 1 });
  assert.equal(service.store.currentBook(owner).chapters.length, 1);
  assert.equal(service.store.currentBook(owner).chapters[0].versions.length, 1);

  const retry = await qq(service, ['重试', first.taskId], invocation('retry-owner'));
  assert.equal(retry.taskId, retry.watchTaskIds[0]);
  assert.deepEqual(service.store.task(retry.taskId).planned, [1]);
  await service.runTask(service.store.task(retry.taskId));

  const task = service.store.task(retry.taskId);
  const book = service.store.currentBook(owner);
  assert.equal(stages.filter((stage) => stage === 'chapter_1').length, 1);
  assert.equal(stages.filter((stage) => stage === 'summary_1').length, 2);
  assert.equal(task.status, 'done');
  assert.equal(task.pendingSummary, null);
  assert.equal(book.chapters[0].versions.length, 1);
  assert.match(book.memory.cumulative, /重试摘要/);
  assert.equal(task.outbox.length, 1);
  assert.equal(task.outbox[0].kind, 'txt');
});

function discoverFfmpeg() {
  const fromEnv = String(process.env.FFMPEG_PATH || '').trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const finder = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(finder, ['ffmpeg'], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return '';
  const found = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return found && existsSync(found) ? found : '';
}

function tinyWav({ sampleRate = 24_000, durationMs = 120, frequency = 440 } = {}) {
  const samples = Math.max(1, Math.round(sampleRate * durationMs / 1000));
  const data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(Math.sin(2 * Math.PI * frequency * index / sampleRate) * 3200);
    data.writeInt16LE(value, index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

test('speech 多段真实 FFmpeg 合成、重试复用与正文指纹失效', async (t) => {
  const ffmpegBinary = discoverFfmpeg();
  if (!ffmpegBinary) {
    t.skip('未在 FFMPEG_PATH 或 PATH 中发现 ffmpeg');
    return;
  }

  let segmentCalls = 0;
  const voice = {
    async listSources() {
      return {
        official: { configured: true },
        extension: { configured: false, profiles: [] },
      };
    },
    async snapshot() {
      return {
        token: 'integration-voice-token',
        source: 'official',
        chunkChars: 20,
        voice: 'integration-voice',
        fingerprint: 'integration-voice-fingerprint',
      };
    },
    async synthesizeSegment() {
      segmentCalls += 1;
      return { audio: tinyWav({ frequency: 360 + segmentCalls * 20 }), contentType: 'audio/wav' };
    },
  };
  const { service } = createHarness(t, {
    voice,
    ffmpegBinary: () => ffmpegBinary,
  });
  const inv = invocation('speech-owner');
  const owner = service.store.key(inv);
  const bookId = await seedBook(service, owner);
  await service.store.appendVersion(owner, bookId, 1, {
    title: '第一章 有声',
    body: '第一句用于朗读。第二句用于朗读。第三句用于朗读。第四句用于朗读。',
    source: 'test',
  });
  await service.store.updateLibrary(owner, (library) => {
    const book = library.books.find((item) => item.id === bookId);
    book.voice = { source: 'official', voice: 'integration-voice', speed: 1 };
    return library;
  });

  const first = await qq(service, ['朗读', '1'], inv);
  await service.runTask(service.store.task(first.taskId));
  let task = service.store.task(first.taskId);
  let book = service.store.currentBook(owner);
  const firstFingerprint = book.chapters[0].audioFingerprint;
  const firstCalls = segmentCalls;
  assert.equal(task.status, 'done');
  assert.ok(firstCalls > 1);
  assert.equal(task.generated.length, 1);
  assert.equal(task.outbox.length, 1);
  assert.equal(task.outbox[0].kind, 'audio');
  assert.equal(task.outbox[0].state, 'queued');
  const firstAudio = service.runtime.artifacts.resolve(task.outbox[0].artifactId, owner);
  const decoded = spawnSync(ffmpegBinary, ['-v', 'error', '-i', firstAudio.path, '-f', 'null', '-'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(decoded.status, 0, decoded.stderr);

  task.status = 'error';
  task.stage = 'export';
  await service.store.saveTask(task);
  const retry = await qq(service, ['重试', first.taskId], invocation('speech-owner'));
  await service.runTask(service.store.task(retry.taskId));
  assert.equal(segmentCalls, firstCalls);
  assert.equal(service.store.task(retry.taskId).outbox.length, 1);

  await service.store.appendVersion(owner, bookId, 1, {
    title: '第一章 有声',
    body: '正文已经改变，这是新的朗读内容。第二句也发生变化。第三句继续更新。第四句结束。',
    source: 'test',
  });
  book = service.store.currentBook(owner);
  assert.equal(book.chapters[0].audioFingerprint, '');
  const changed = await qq(service, ['朗读', '1'], invocation('speech-owner'));
  await service.runTask(service.store.task(changed.taskId));
  book = service.store.currentBook(owner);
  assert.notEqual(book.chapters[0].audioFingerprint, firstFingerprint);
  assert.ok(segmentCalls > firstCalls);
  assert.equal(service.store.task(changed.taskId).outbox.length, 1);
});

test('speech 中途失败后重试复用稳定目录里的已完成分段', async (t) => {
  const ffmpegBinary = discoverFfmpeg();
  if (!ffmpegBinary) {
    t.skip('未在 FFMPEG_PATH 或 PATH 中发现 ffmpeg');
    return;
  }

  let segmentCalls = 0;
  const voice = {
    async snapshot() {
      return {
        token: 'retry-segment-token',
        source: 'official',
        fingerprint: 'stable-retry-fingerprint',
        chunkChars: 20,
        voice: 'integration-voice',
      };
    },
    async synthesizeSegment() {
      segmentCalls += 1;
      if (segmentCalls === 3) throw new Error('模拟第三段合成失败');
      return { audio: tinyWav({ frequency: 420 + segmentCalls * 10 }), contentType: 'audio/wav' };
    },
  };
  const { service } = createHarness(t, {
    voice,
    ffmpegBinary: () => ffmpegBinary,
  });
  const inv = invocation('speech-retry-segment-owner');
  const owner = service.store.key(inv);
  const bookId = await seedBook(service, owner);
  const body = '第一段需要完整朗读，并保留下来。第二段也同样需要朗读。第三段会发生失败。第四段应该在重试时继续。第五段完成整次合成。';
  const expectedPieces = splitForSpeech(body, 20).length;
  assert.ok(expectedPieces >= 4);
  await service.store.appendVersion(owner, bookId, 1, {
    title: '第一章 分段重试',
    body,
    source: 'test',
  });
  await service.store.updateLibrary(owner, (library) => {
    library.books.find((item) => item.id === bookId).voice = {
      source: 'official', voice: 'integration-voice', speed: 1,
    };
    return library;
  });

  const first = await qq(service, ['朗读', '1'], inv);
  await service.runTask(service.store.task(first.taskId));
  assert.equal(service.store.task(first.taskId).status, 'error');
  assert.equal(segmentCalls, 3);

  const retry = await qq(service, ['重试', first.taskId], invocation('speech-retry-segment-owner'));
  await service.runTask(service.store.task(retry.taskId));
  assert.equal(segmentCalls, expectedPieces + 1);
  assert.equal(service.store.task(retry.taskId).status, 'done');
  assert.ok(service.store.task(retry.taskId).outbox.length > 0);
});

test('朗读切句保留连续标点与省略号', () => {
  const input = '你好！！再见……最后一句。';
  const pieces = splitForSpeech(input, 200);
  assert.equal(pieces.map((piece) => piece.text).join(''), input);
});

test('跨 owner 的 watch、deliver、claim 和 artifact resolve 被拒绝', async (t) => {
  const { service, runtime, root } = createHarness(t);
  const invA = invocation('owner-a');
  const invB = invocation('owner-b');
  const ownerA = service.store.key(invA);
  const ownerB = service.store.key(invB);
  const bookB = await seedBook(service, ownerB, { title: 'B 的书' });
  const taskB = await service.enqueue({
    kind: 'write',
    owner: ownerB,
    invocation: invB,
    input: { bookId: bookB, count: 1, targetChars: 1000, request: '' },
    dedupe: 'integration-foreign-task',
  });
  await assert.rejects(() => service.watch(ownerA, taskB.id, invA), /不属于当前书库/);
  await assert.rejects(
    () => service.deliver(ownerA, { taskId: taskB.id, artifactId: 'forged', state: 'sent' }),
    /成果不属于当前书库/,
  );
  const claim = await qq(service, ['领取', taskB.id], invA);
  assert.match(claim.text, /任务不存在/);

  const output = join(root, 'outputs', 'owner-a.txt');
  writeFileSync(output, 'owner a artifact');
  const artifact = await runtime.artifacts.register({
    ownerKey: ownerA,
    bookId: 'owner-a-book',
    kind: 'txt',
    path: output,
    fileName: 'owner-a.txt',
    bytes: Buffer.byteLength('owner a artifact'),
  });
  assert.throws(() => runtime.artifacts.resolve(artifact.id, ownerB), /不属于当前书库/);
});

test('fake model 生成大纲时只写候选，确认后才覆盖并失效缓存', async (t) => {
  const stages = [];
  const { service } = createHarness(t, {
    async modelGenerate(request) {
      stages.push(request.stage);
      if (request.stage !== 'outline_generate') throw new Error(`unexpected stage: ${request.stage}`);
      return JSON.stringify({ outline: ['新大纲一', '新大纲二'] });
    },
  });
  const inv = invocation('outline-integration-owner');
  const owner = service.store.key(inv);
  const bookId = await seedBook(service, owner, { outline: ['旧大纲'] });
  await service.store.appendVersion(owner, bookId, 1, {
    title: '第一章',
    body: '正文',
    source: 'test',
  });
  await service.store.updateLibrary(owner, (library) => {
    const book = library.books.find((item) => item.id === bookId);
    book.memory = { validThrough: 1, cumulative: '旧记忆', states: ['旧状态'] };
    book.audioArtifacts = { old: [{ artifactId: 'old' }] };
    book.chapters[0].audioFingerprint = hash('old-audio');
    return library;
  });

  const generated = await qq(service, ['大纲', '生成'], inv);
  await service.runTask(service.store.task(generated.taskId));
  assert.deepEqual(stages, ['outline_generate']);
  let book = service.store.currentBook(owner);
  assert.deepEqual(book.outline, ['旧大纲']);
  assert.deepEqual(book.generatedOutline, ['新大纲一', '新大纲二']);
  assert.equal(book.memory.validThrough, 1);
  assert.notDeepEqual(book.audioArtifacts, {});

  await qq(service, ['大纲', '确认'], invocation('outline-integration-owner'));
  book = service.store.currentBook(owner);
  assert.deepEqual(book.outline, ['旧大纲']);
  assert.equal(service.store.draft(owner).data.action, 'apply_outline');
  await direct(service, '确认', invocation('outline-integration-owner'));
  book = service.store.currentBook(owner);
  assert.deepEqual(book.outline, ['新大纲一', '新大纲二']);
  assert.deepEqual(book.generatedOutline, []);
  assert.deepEqual(book.memory, { validThrough: 0, cumulative: '', states: [] });
  assert.deepEqual(book.audioArtifacts, {});
  assert.equal(book.chapters[0].audioFingerprint, '');
});
