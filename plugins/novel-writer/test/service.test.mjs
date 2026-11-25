import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { expireDraft, newDraft, outlineDraft } from '../lib/forms.mjs';
import { createPublicRuntime } from '../lib/public-runtime.mjs';
import { NovelService } from '../lib/service.mjs';
import {
  backupJson, parseBackup, parseImportedTxt, readingTxt,
} from '../lib/text.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
let messageSequence = 0;

function invocation(user = 'user-a', messageId = '') {
  return {
    source: 'qq',
    botId: 'bot-test',
    kind: 'c2c',
    chatId: 'chat-test',
    userId: user,
    messageId: messageId || `message-${++messageSequence}`,
    receivedAt: Date.now(),
    mentioned: true,
  };
}

function makeService(t, nowRef = { value: Date.now() }) {
  const root = mkdtempSync(join(TEST_DIR, '.tmp-'));
  const artifacts = new Map();
  const runtime = {
    version: 1,
    dataDir: root,
    ffmpegBinary: () => '',
    model: {},
    voice: {
      async listSources() {
        return {
          official: { configured: false },
          extension: { configured: false, profiles: [] },
        };
      },
    },
    artifacts: {
      async register(data) {
        const id = `artifact-${artifacts.size + 1}`;
        artifacts.set(id, { ...data, id });
        return { id, fileName: data.fileName, bytes: data.bytes };
      },
      resolve(id, ownerKey) {
        const row = artifacts.get(id);
        if (!row || row.ownerKey !== ownerKey) throw new Error('成果不存在');
        return row;
      },
      async cleanup() { return { removed: 0 }; },
    },
    dependencies: { status: () => ({}) },
  };
  const service = new NovelService({
    runtime,
    now: () => nowRef.value,
    log: () => {},
  });
  service.pump = () => {};
  clearInterval(service.cleanupTimer);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { service, root, runtime, artifacts, nowRef };
}

async function seedBook(service, owner, title = '测试书') {
  let bookId = '';
  await service.store.updateLibrary(owner, (library) => {
    const no = Number(library.nextBookNo) || 1;
    bookId = `book-seed-${no}-${messageSequence++}`;
    library.books.push({
      id: bookId,
      no,
      title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      settings: { core: '', genre: '', world: '', style: '', avoid: '', targetChars: 1000 },
      people: [],
      outline: [],
      chapters: [],
      memory: { validThrough: 0, cumulative: '', states: [] },
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

async function completeNewBook(service, title) {
  await qq(service, ['新建', title]);
  await direct(service, '核心故事');
  await direct(service, '跳过');
  await direct(service, '跳过');
  await direct(service, '跳过');
  await direct(service, '跳过');
  await direct(service, '否');
  await direct(service, '跳过');
  return await direct(service, '确认');
}

test('同书名创建为不同 ID 和编号', async (t) => {
  const { service } = makeService(t);
  const first = await completeNewBook(service, '同名小说');
  const second = await completeNewBook(service, '同名小说');
  assert.equal(first.handled, true);
  assert.equal(second.handled, true);

  const library = service.store.library(service.store.key(invocation()));
  assert.equal(library.books.length, 2);
  assert.notEqual(library.books[0].id, library.books[1].id);
  assert.notEqual(library.books[0].no, library.books[1].no);
});

test('两个 owner 相互隔离，伪造 bookId 和 taskId 被拒绝', async (t) => {
  const { service } = makeService(t);
  const invA = invocation('owner-a');
  const invB = invocation('owner-b');
  const ownerA = service.store.key(invA);
  const ownerB = service.store.key(invB);
  const bookA = await seedBook(service, ownerA, 'A 的书');
  const bookB = await seedBook(service, ownerB, 'B 的书');

  assert.equal(service.store.currentBook(ownerA).id, bookA);
  assert.equal(service.store.currentBook(ownerB).id, bookB);
  assert.equal(service.store.library(ownerA).books.some((book) => book.id === bookB), false);

  const foreignTask = await service.enqueue({
    kind: 'write',
    owner: ownerB,
    invocation: invB,
    input: { bookId: bookB, count: 1, targetChars: 1000, request: '' },
    dedupe: 'owner-b-task',
  });
  await assert.rejects(
    () => service.watch(ownerA, foreignTask.id, invA),
    /任务不存在或不属于当前书库/,
  );
  await assert.rejects(
    () => service.deliver(ownerA, {
      taskId: foreignTask.id,
      artifactId: 'forged-artifact',
      state: 'sent',
    }),
    /成果不属于当前书库/,
  );

  const forgedTask = {
    ownerKey: ownerA,
    kind: 'write',
    input: { bookId: bookB, count: 1, targetChars: 1000, request: '' },
    completed: {},
    generated: [],
    outbox: [],
  };
  await assert.rejects(
    () => service.runWriteTask(forgedTask, new AbortController().signal),
    /书籍不存在/,
  );
});

test('单消息重复只追加一次', async (t) => {
  const { service } = makeService(t);
  const inv = invocation('draft-owner');
  const owner = service.store.key(inv);
  const bookId = await seedBook(service, owner);
  await qq(service, ['大纲', '添加'], inv);

  const duplicate = invocation('draft-owner', 'same-message-id');
  await direct(service, '第一条', duplicate);
  await direct(service, '第一条', duplicate);
  const draft = service.store.draft(owner);
  assert.equal(draft.data.bookId, bookId);
  assert.deepEqual(draft.data.lines, ['第一条']);
});

test('同一命令消息跨服务重建后只执行一次', async (t) => {
  const { service, runtime } = makeService(t);
  const inv = invocation('rebuild-owner', 'persistent-command');
  const owner = service.store.key(inv);
  await seedBook(service, owner);

  const first = await qq(service, ['大纲', '添加'], inv);
  assert.equal(first.handled, true);
  assert.match(first.text, /逐条发送大纲/);
  const before = service.store.draft(owner);

  const rebuilt = new NovelService({
    runtime,
    now: () => Date.now(),
    log: () => {},
  });
  rebuilt.pump = () => {};
  clearInterval(rebuilt.cleanupTimer);

  const duplicate = await qq(rebuilt, ['大纲', '添加'], inv);
  assert.deepEqual(duplicate, { handled: true, text: '' });
  assert.deepEqual(rebuilt.store.draft(owner), before);
});

test('删除书籍后同时移除该书章节版本目录', async (t) => {
  const { service, root } = makeService(t);
  const inv = invocation('delete-owner');
  const owner = service.store.key(inv);
  const bookId = await seedBook(service, owner, '待删除书');
  await service.store.appendVersion(owner, bookId, 1, {
    title: '第一章',
    body: '会被删除的正文',
    source: 'test',
  });

  const book = service.store.currentBook(owner);
  const bookDir = join(root, 'owners', owner, 'books', bookId);
  assert.equal(existsSync(bookDir), true);

  const prompt = await qq(service, ['删除', String(book.no)], inv);
  assert.match(prompt.text, /即将删除/);
  const deleted = await direct(service, '确认', invocation('delete-owner'));
  assert.match(deleted.text, /已删除/);
  assert.equal(existsSync(bookDir), false);
  assert.equal(service.store.library(owner).books.some((item) => item.id === bookId), false);
});

test('暂停、继续和 7 天 draft 过期都会持久化', async (t) => {
  const nowRef = { value: Date.now() };
  const { service } = makeService(t, nowRef);
  const inv = invocation('pause-owner');
  const owner = service.store.key(inv);
  await seedBook(service, owner);
  await qq(service, ['大纲', '添加'], inv);

  await direct(service, '暂停', invocation('pause-owner'));
  assert.ok(service.store.draft(owner).pausedAt > 0);
  await qq(service, ['继续'], invocation('pause-owner'));
  assert.equal(service.store.draft(owner).pausedAt, 0);

  const draft = service.store.draft(owner);
  draft.active = true;
  draft.kind = 'outline';
  draft.step = 'outline_body';
  draft.data = { bookId: draft.data.bookId, lines: ['旧内容'] };
  draft.updatedAt = nowRef.value - 8 * 24 * 60 * 60 * 1000;
  draft.pausedAt = 0;
  await service.store.updateDraft(owner, () => draft);
  await service.expireOwnerDraft(owner);
  assert.equal(service.store.draft(owner).active, false);

  const directExpiry = expireDraft(newDraft({ title: '过期' }), Date.now() + 8 * 24 * 60 * 60 * 1000);
  assert.equal(directExpiry.expired, true);
});

test('TXT 使用 BOM 和 CRLF，且不泄漏设定、记忆或摘要', () => {
  const book = {
    title: '隐私测试书',
    settings: { core: '核心设定机密', world: '世界观机密' },
    outline: ['大纲机密'],
    memory: { validThrough: 1, cumulative: '记忆机密', states: ['状态机密'] },
  };
  const bytes = readingTxt(book, [{
    chapterNo: 1,
    title: '第一章',
    body: '第一行\n第二行',
    summary: '摘要机密',
    states: ['章节状态机密'],
  }]);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0a) assert.equal(bytes[index - 1], 0x0d);
  }
  const text = bytes.toString('utf8');
  for (const secret of ['核心设定机密', '世界观机密', '大纲机密', '记忆机密', '状态机密', '摘要机密', '章节状态机密']) {
    assert.equal(text.includes(secret), false);
  }
  assert.match(text, /第一章\r\n\r\n第一行\r\n第二行/);
});

test('TXT 导入与 JSON 备份可以往返', async (t) => {
  const { service } = makeService(t);
  const inv = invocation('import-owner');
  const owner = service.store.key(inv);
  const importedBytes = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('导入书名\r\n第一章 起始\r\n正文一\r\n第二章 继续\r\n正文二'),
  ]);
  const preview = parseImportedTxt(importedBytes, '导入书名.txt');
  assert.equal(preview.title, '导入书名');
  assert.equal(preview.chapters.length, 2);
  assert.equal(preview.chapters[0].body, '正文一');

  await qq(service, ['导入'], inv);
  const previewResult = await direct(service, importedBytes.toString('utf8'), invocation('import-owner'));
  assert.match(previewResult.text, /识别《导入书名》/);
  const imported = await direct(service, '确认', invocation('import-owner'));
  assert.match(imported.text, /已导入/);
  assert.equal(service.store.currentBook(owner).chapters.length, 2);

  const book = service.store.currentBook(owner);
  const versions = book.chapters.map((chapter) =>
    service.store.readVersion(owner, book.id, chapter.no, chapter.currentVersion));
  const backupBook = {
    ...book,
    settings: { genre: '幻想', world: '备份世界观' },
    people: [{ name: '备份人物' }],
    outline: ['备份大纲'],
  };
  const backup = parseBackup(backupJson(backupBook, versions, Date.now()));
  assert.equal(backup.title, '导入书名');
  assert.equal(backup.chapters.length, 2);
  assert.equal(backup.chapters[1].body, '正文二');
  assert.equal(backup.settings.genre, '幻想');
  assert.deepEqual(backup.outline, ['备份大纲']);
});

test('大纲确认前不应用，确认后 memory 和 audio 失效', async (t) => {
  const { service } = makeService(t);
  const inv = invocation('outline-owner');
  const owner = service.store.key(inv);
  const bookId = await seedBook(service, owner);
  await service.store.appendVersion(owner, bookId, 1, {
    title: '第一章',
    body: '正文',
    source: 'test',
  });
  await service.store.updateLibrary(owner, (library) => {
    const book = library.books.find((item) => item.id === bookId);
    book.outline = ['旧大纲'];
    book.generatedOutline = ['新大纲一', '新大纲二'];
    book.memory = { validThrough: 1, cumulative: '旧记忆', states: ['旧状态'] };
    book.audioArtifacts = { old: [{ artifactId: 'old' }] };
    book.chapters[0].audioFingerprint = 'old';
    return library;
  });

  const prompt = await qq(service, ['大纲', '确认'], inv);
  assert.match(prompt.text, /回复“确认”应用/);
  assert.deepEqual(service.store.currentBook(owner).outline, ['旧大纲']);
  assert.equal(service.store.draft(owner).data.action, 'apply_outline');

  const applied = await direct(service, '确认', invocation('outline-owner'));
  assert.match(applied.text, /已应用/);
  const book = service.store.currentBook(owner);
  assert.deepEqual(book.outline, ['新大纲一', '新大纲二']);
  assert.deepEqual(book.memory, { validThrough: 0, cumulative: '', states: [] });
  assert.deepEqual(book.audioArtifacts, {});
  assert.equal(book.chapters[0].audioFingerprint, '');
});

test('artifacts 并发注册不会丢失索引', async (t) => {
  const base = mkdtempSync(join(TEST_DIR, '.tmp-runtime-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'extension-data', 'novel-writer');
  const outputs = join(root, 'outputs');
  mkdirSync(outputs, { recursive: true });
  const runtime = createPublicRuntime({
    dataDir: root,
    extensionRoot: join(base, 'extensions', 'novel-writer'),
    env: {},
  });

  const registrations = Array.from({ length: 24 }, (_, index) => {
    const body = `artifact-body-${index}`;
    const path = join(outputs, `artifact-${index}.txt`);
    writeFileSync(path, body);
    return runtime.artifacts.register({
      ownerKey: 'owner-concurrent',
      bookId: 'book-concurrent',
      kind: 'txt',
      path,
      fileName: `artifact-${index}.txt`,
      bytes: Buffer.byteLength(body),
    });
  });
  const registered = await Promise.all(registrations);
  const state = JSON.parse(readFileSync(join(root, 'artifacts.json'), 'utf8'));
  assert.equal(Object.keys(state.items).length, 24);
  for (const item of registered) {
    assert.equal(runtime.artifacts.resolve(item.id, 'owner-concurrent').path, state.items[item.id].path);
  }
});
