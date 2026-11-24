import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createActions } from '../actions-v1.mjs';
import { normalizePersona, personaContext } from '../lib/people.mjs';
import { NovelService } from '../lib/service.mjs';
import { buildChapterContext } from '../lib/writing.mjs';
import { createHandler } from '../server.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

function panelInvocation() {
  return {
    source: 'panel',
    ownerVerified: true,
    requestId: `panel-${Date.now()}`,
  };
}

function makeHarness(t) {
  const root = mkdtempSync(join(TEST_DIR, '.tmp-panel-'));
  const runtime = {
    version: 1,
    dataDir: root,
    ffmpegBinary: () => '',
    model: {
      status: () => ({ configured: true, provider: 'fixture', model: 'writer' }),
      async generate({ messages }) {
        assert.match(messages[0].content, /新增角色要求/);
        return {
          text: JSON.stringify({
            name: '程野',
            aliases: ['野哥'],
            identity: '刑警',
            appearance: '高瘦，常穿旧风衣',
            personality: '多疑、行动力强',
            relationship: '与林岚互相利用',
            goal: '洗清旧案嫌疑',
            conflict: '保护同僚与追查真相不可兼得',
            secret: '曾销毁一份证物',
            arc: '从自保到公开承担',
            speech: '语速快，喜欢反问',
            notes: '不喝酒',
          }),
        };
      },
    },
    voice: {
      async listSources() {
        return {
          official: {
            available: true, configured: true, provider: 'fixture',
            voice: 'fixture-official', supportsSpeed: true,
          },
          extension: {
            available: true,
            configured: true,
            profiles: [
              { id: 'profile-a', name: 'A 音色' },
              { id: 'profile-b', name: 'B 音色' },
            ],
          },
        };
      },
    },
    artifacts: { async cleanup() { return { removed: 0 }; } },
    dependencies: { status: () => ({ ready: true }) },
  };
  const service = new NovelService({ runtime, now: Date.now, log: () => {} });
  service.pump = () => {};
  clearInterval(service.cleanupTimer);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { service, root, runtime };
}

async function seed(t) {
  const { service, root, runtime } = makeHarness(t);
  const invocation = panelInvocation();
  const owner = service.store.key(invocation);
  let bookId = '';
  await service.store.updateLibrary(owner, (library) => {
    bookId = 'book-panel-1';
    library.books.push({
      id: bookId,
      no: 1,
      title: '面板测试书',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      settings: {
        core: '调查失踪案', genre: '悬疑', world: '港城',
        style: '冷峻', avoid: '无', targetChars: 3000,
      },
      people: [{ name: '旧人物', personality: ['谨慎', '敏锐'] }],
      outline: ['第一条大纲'],
      chapters: [],
      memory: { validThrough: 0, cumulative: '', states: [] },
      autoRead: false,
      voice: { source: '', profileId: '', voice: '', speed: 1 },
      audioArtifacts: {},
      generatedOutline: [],
    });
    library.currentBookId = bookId;
    library.nextBookNo = 2;
    return library;
  });
  const chapter = await service.store.appendVersion(owner, bookId, 1, {
    title: '第一章 旧稿',
    body: '旧稿正文。'.repeat(120),
    summary: '旧摘要',
    states: ['主角仍然安全'],
    source: 'fixture',
  });
  return { service, root, runtime, invocation, owner, bookId, chapter };
}

test('面板拒绝未认证调用', async (t) => {
  const { service } = makeHarness(t);
  await assert.rejects(
    () => service.handlePanel({ op: 'books' }, { source: 'panel', ownerVerified: false }),
    /主人校验/,
  );
});

test('面板、清单和 MCP 使用同一插件版本', async (t) => {
  const { service } = makeHarness(t);
  const invocation = panelInvocation();
  const manifest = JSON.parse(readFileSync(join(TEST_DIR, '..', 'plugin.json'), 'utf8'));
  const status = await service.handlePanel({ op: 'status' }, invocation);
  assert.equal(status.data.version, manifest.version);
  const handler = createHandler();
  const initialized = await handler({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(initialized.result.serverInfo.version, status.data.version);
  const capabilityResponse = await handler({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'novel_capabilities', arguments: {} },
  });
  const capability = JSON.parse(capabilityResponse.result.content[0].text);
  assert.equal(capability.extension.version, status.data.version);
});

test('面板可列出、读取、保存和删除自己的书籍', async (t) => {
  const { service, invocation, owner, bookId } = await seed(t);
  const listed = await service.handlePanel({ op: 'books' }, invocation);
  assert.equal(listed.ok, true);
  assert.equal(listed.data.owners.length, 1);
  assert.equal(listed.data.selectedOwnerId, service.store.key(invocation));
  assert.equal(listed.data.currentBookId, bookId);
  assert.equal(listed.data.books[0].title, '面板测试书');

  await service.store.updateLibrary(owner, (library) => {
    const book = library.books.find((item) => item.id === bookId);
    book.memory = { validThrough: 5, cumulative: '旧摘要', states: ['旧状态'] };
    book.audioArtifacts = { old: [{ artifactId: 'old' }] };
    book.chapters[0].audioFingerprint = 'old-audio';
    return library;
  });

  const saved = await service.handlePanel({
    op: 'saveBook',
    bookId,
    title: '修改后的书名',
    settings: {
      core: '新核心', genre: '都市', world: '新世界',
      style: '简洁', avoid: '拖沓', targetChars: 2400,
    },
    outline: ['新大纲一', '新大纲二'],
  }, invocation);
  assert.equal(saved.data.book.title, '修改后的书名');
  assert.equal(saved.data.book.settings.targetChars, 2400);
  assert.deepEqual(saved.data.book.outline, ['新大纲一', '新大纲二']);
  const resetBook = service.store.book(owner, bookId);
  assert.deepEqual(resetBook.memory, { validThrough: 0, cumulative: '', states: [] });
  assert.deepEqual(resetBook.audioArtifacts, {});
  assert.equal(resetBook.chapters[0].audioFingerprint, '');

  await assert.rejects(
    () => service.handlePanel({ op: 'deleteBook', bookId, confirmTitle: '错误书名' }, invocation),
    /完整书名/,
  );
  const deleted = await service.handlePanel({
    op: 'deleteBook',
    bookId,
    confirmTitle: '修改后的书名',
  }, invocation);
  assert.equal(deleted.data.deleted, true);
  assert.equal(service.store.library(service.store.key(invocation)).books.length, 0);
});

test('人设卡面板保存全部字段并进入写作上下文', async (t) => {
  const { service, invocation, owner, bookId } = await seed(t);
  const saved = await service.handlePanel({
    op: 'savePersona',
    bookId,
    persona: {
      name: '林岚',
      aliases: '阿岚、小岚',
      identity: '记者',
      appearance: '短发，右手有旧伤',
      personality: '冷静但护短',
      relationship: '韩川的旧友',
      goal: '找到失踪的妹妹',
      conflict: '真相可能伤害亲近的人',
      secret: '她曾伪造采访记录',
      arc: '从追索真相到承担代价',
      speech: '短句，避免承诺',
      notes: '讨厌甜食',
    },
  }, invocation);
  assert.equal(saved.ok, true);
  assert.equal(saved.data.persona.id.startsWith('person-'), true);
  assert.deepEqual(saved.data.persona.aliases, ['阿岚', '小岚']);
  assert.equal(saved.data.personas.length, 2);

  const book = service.store.book(owner, bookId);
  const context = buildChapterContext({
    book,
    versions: [],
    request: '继续调查',
  });
  assert.match(context, /林岚/);
  assert.match(context, /她曾伪造采访记录/);
  assert.match(context, /从追索真相到承担代价/);
  assert.match(personaContext(saved.data.persona), /语言风格：短句/);

  await assert.rejects(() => service.handlePanel({
    op: 'savePersona',
    bookId,
    persona: { name: '林岚', identity: '另一个同名人物' },
  }, invocation), /同名人物/);

  const deleted = await service.handlePanel({
    op: 'deletePersona',
    bookId,
    personaId: saved.data.persona.id,
  }, invocation);
  assert.equal(deleted.data.personas.length, 1);
});

test('旧人物卡读取、编辑和删除使用稳定编号', async (t) => {
  const { service, invocation, bookId } = await seed(t);
  const first = await service.handlePanel({ op: 'book', bookId }, invocation);
  const second = await service.handlePanel({ op: 'book', bookId }, invocation);
  const oldFirst = first.data.book.personas[0];
  const oldSecond = second.data.book.personas[0];
  assert.equal(oldFirst.id, oldSecond.id);

  const edited = await service.handlePanel({
    op: 'savePersona',
    bookId,
    persona: { ...oldFirst, secret: '旧卡新增秘密', appearance: '高个子' },
  }, invocation);
  assert.equal(edited.data.persona.id, oldFirst.id);
  assert.equal(edited.data.personas.length, 1);

  const removed = await service.handlePanel({
    op: 'deletePersona',
    bookId,
    personaId: oldFirst.id,
  }, invocation);
  assert.deepEqual(removed.data.personas, []);
});

test('人设卡可以由当前书稿生成候选，保存前不落库', async (t) => {
  const { service, invocation, owner, bookId } = await seed(t);
  const generated = await service.handlePanel({
    op: 'generatePersona',
    bookId,
    hint: '增加一个推动旧案调查的刑警',
  }, invocation);
  assert.equal(generated.data.persona.name, '程野');
  assert.equal(generated.data.persona.secret, '曾销毁一份证物');
  assert.equal(service.store.book(owner, bookId).people.length, 1);
});

test('人设生成超时后释放面板队列', async (t) => {
  const { service, runtime, invocation, bookId } = await seed(t);
  service.panelGenerateTimeoutMs = 20;
  runtime.model.generate = () => new Promise(() => {});
  await assert.rejects(() => service.handlePanel({
    op: 'generatePersona',
    bookId,
    hint: '会超时',
  }, invocation), /超过 1 秒/);
  const listed = await service.handlePanel({ op: 'books' }, invocation);
  assert.equal(listed.ok, true);
});

test('面板章节编辑创建新版本、保留旧稿并阻止过期版本覆盖', async (t) => {
  const { service, invocation, owner, bookId } = await seed(t);
  const read = await service.handlePanel({ op: 'chapter', bookId, chapterNo: 1 }, invocation);
  assert.equal(read.data.currentVersion, 1);
  assert.match(read.data.body, /旧稿正文/);

  const saved = await service.handlePanel({
    op: 'saveChapter',
    bookId,
    chapterNo: 1,
    expectedVersion: 1,
    title: '第一章 新稿',
    body: '新稿正文。'.repeat(120),
  }, invocation);
  assert.equal(saved.data.chapter.currentVersion, 2);
  assert.equal(service.store.readVersion(owner, bookId, 1, 1).title, '第一章 旧稿');
  assert.equal(service.store.readVersion(owner, bookId, 1, 2).title, '第一章 新稿');

  await assert.rejects(() => service.handlePanel({
    op: 'saveChapter',
    bookId,
    chapterNo: 1,
    expectedVersion: 1,
    title: '过期覆盖',
    body: '不应保存。'.repeat(100),
  }, invocation), /已有新版本/);
});

test('面板朗读设置校验来源并保存音色与自动朗读', async (t) => {
  const { service, invocation, owner, bookId } = await seed(t);
  const saved = await service.handlePanel({
    op: 'setReading',
    bookId,
    selection: { source: 'extension', profileId: 'profile-b', speed: 1.25 },
    autoRead: true,
  }, invocation);
  assert.equal(saved.data.voice.source, 'extension');
  assert.equal(saved.data.voice.profileId, 'profile-b');
  assert.equal(saved.data.autoRead, true);
  const book = service.store.book(owner, bookId);
  assert.equal(book.voice.speed, 1.25);

  await assert.rejects(() => service.handlePanel({
    op: 'setReading',
    bookId,
    selection: { source: 'extension', profileId: 'missing', speed: 1 },
    autoRead: false,
  }, invocation), /音色方案不存在/);
});

test('旧人设自动补全新字段且页面脚本语法有效', () => {
  const person = normalizePersona({ name: '旧人物', personality: ['谨慎', '敏锐'] });
  assert.equal(person.personality, '谨慎\n敏锐');
  assert.deepEqual(person.aliases, []);
  const html = readFileSync(join(TEST_DIR, '..', 'page.html'), 'utf8');
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] || '';
  assert.doesNotThrow(() => new Function(script));
  for (const id of ['personaList', 'chapterList', 'readingSource', 'taskList', 'bookSelect']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
});

test('动作包装器把业务错误放进宿主可见 message', async (t) => {
  const { runtime, invocation, bookId } = await seed(t);
  const actions = createActions({ novelRuntime: runtime });
  const result = await actions.panel({ op: 'book', bookId: 'missing-book' }, invocation);
  assert.equal(result.ok, false);
  assert.match(result.message, /小说操作失败：书籍不存在/);
  assert.equal(result.message, result.text);
});
