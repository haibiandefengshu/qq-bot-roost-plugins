import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PAGE_FILE = join(TEST_DIR, '..', 'page.html');

class FakeClassList {
  constructor() { this.names = new Set(); }
  add(...names) { for (const name of names) this.names.add(name); }
  remove(...names) { for (const name of names) this.names.delete(name); }
  contains(name) { return this.names.has(name); }
  toggle(name, force) {
    if (force === undefined) {
      if (this.names.has(name)) { this.names.delete(name); return false; }
      this.names.add(name);
      return true;
    }
    if (force) this.names.add(name);
    else this.names.delete(name);
    return Boolean(force);
  }
}

class FakeNode {
  constructor(tag = 'div', document = null) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = document;
    this.children = [];
    this.listeners = new Map();
    this.attributes = {};
    this.dataset = {};
    this.classList = new FakeClassList();
    this.className = '';
    this.id = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.textContent = '';
  }
  append(...children) {
    for (const child of children) {
      this.children.push(child instanceof FakeNode ? child : new FakeText(String(child)));
    }
  }
  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'id') this.id = String(value);
  }
  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  dispatch(type, extra = {}) {
    const event = { target: this, preventDefault() {}, ...extra };
    for (const listener of this.listeners.get(type) || []) listener.call(this, event);
  }
  reset() {
    for (const child of this.children) {
      if ('value' in child) child.value = '';
      if ('checked' in child) child.checked = false;
    }
  }
  scrollIntoView() {}
}

class FakeText extends FakeNode {
  constructor(text) {
    super('#text');
    this.textContent = String(text);
  }
}

class FakeOption extends FakeNode {
  constructor(text = '', value = '', defaultSelected = false, selected = false) {
    super('option');
    this.text = String(text);
    this.value = String(value);
    this.defaultSelected = Boolean(defaultSelected);
    this.selected = Boolean(selected);
  }
}

function createDocument(html) {
  const elements = new Map();
  const document = {
    createElement(tag) { return new FakeNode(tag, document); },
    createTextNode(text) { return new FakeText(text); },
    querySelector(selector) {
      if (!selector.startsWith('#')) return null;
      return elements.get(selector.slice(1)) || null;
    },
    querySelectorAll(selector) {
      if (selector === 'button') {
        return [...elements.values()].filter((node) => node.tagName === 'BUTTON');
      }
      return [];
    },
  };
  for (const match of html.matchAll(/\bid=["']([^"']+)["']/g)) {
    const node = new FakeNode('div', document);
    node.id = match[1];
    elements.set(match[1], node);
  }
  return { document, elements };
}

function baseOfficial(overrides = {}) {
  return {
    available: true,
    configured: true,
    provider: 'mimo',
    voice: 'global-voice',
    speed: 1,
    savedSpeed: 1.25,
    effectiveSpeed: 1,
    globalSpeed: 1.25,
    supportsSpeed: false,
    supportsSpeedOverride: false,
    supportsVoiceOverride: false,
    missing: [],
    limitations: [
      '只使用已保存的全局语音配置，不支持每本书单独设置音色、语速或草稿。',
      '已保存全局语速 1.25，但 MiMo 固定原速，实际按 1 合成。',
    ],
    engineChecked: false,
    ...overrides,
  };
}

function createHarness({ official, extension, bookVoice, autoRead = false } = {}) {
  const html = readFileSync(PAGE_FILE, 'utf8');
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] || '';
  const { document, elements } = createDocument(html);
  const requests = [];
  const ownerId = 'owner-1';
  const bookId = 'book-1';
  const voices = {
    official: official || baseOfficial(),
    extension: extension || {
      available: true,
      configured: true,
      profiles: [{ id: 'profile-a', name: 'A 音色' }],
    },
  };
  const book = {
    id: bookId,
    title: '朗读测试书',
    chapterCount: 1,
    chars: 12,
    settings: { core: '', genre: '', world: '', style: '', avoid: '', targetChars: 3000 },
    outline: [],
    personas: [],
    chapters: [],
    autoRead,
    voice: bookVoice || { source: 'official', profileId: '', voice: 'book-voice', speed: 1 },
  };
  const summary = {
    id: bookId,
    title: book.title,
    chapterCount: 1,
    chars: 12,
    updatedAt: 1,
  };
  const envelope = (data) => ({ ok: true, data });
  const json = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  });
  const fetchImpl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, options, body });
    if (body?.op === 'sharedDeps.install') {
      return json({ ok: true, name: 'ffmpeg', message: 'FFmpeg 已安装' });
    }
    if (body?.op !== 'extensions.ui.action') {
      return json({ ok: false, message: '未知操作' }, 404);
    }
    const payload = body.arg?.payload || {};
    if (payload.op === 'status') {
      return json(envelope({
        version: 'test',
        model: { configured: true, provider: 'fixture', model: 'writer' },
        voice: voices,
        dependencies: {},
        ffmpeg: true,
        stats: { tasks: 0 },
      }));
    }
    if (payload.op === 'books') {
      return json(envelope({
        selectedOwnerId: ownerId,
        owners: [{ id: ownerId, label: '私人书库', books: [summary], currentBookId: bookId }],
        currentBookId: bookId,
        books: [summary],
        voice: voices,
      }));
    }
    if (payload.op === 'book') {
      return json(envelope({ book }));
    }
    if (payload.op === 'tasks') {
      return json(envelope({ tasks: [] }));
    }
    if (payload.op === 'setReading') {
      const useCurrentGlobal = payload.useCurrentGlobal === true;
      const voice = useCurrentGlobal
        ? { ...payload.voice, voice: voices.official.voice, speed: voices.official.effectiveSpeed }
        : payload.voice;
      return json(envelope({
        autoRead: payload.autoRead === true,
        voice: { source: voice.source, profileId: voice.profileId, voice: voice.voice, speed: voice.speed },
        message: '朗读设置已保存',
      }));
    }
    return json({ ok: false, message: '未处理的面板操作' }, 400);
  };
  const context = vm.createContext({
    AbortController,
    Node: FakeNode,
    Option: FakeOption,
    clearTimeout,
    confirm: () => true,
    console,
    document,
    fetch: fetchImpl,
    prompt: () => null,
    setTimeout,
    window: {},
  });
  new vm.Script(script, { filename: 'page.html' }).runInContext(context);
  return { document, elements, requests, voices, book, ownerId, bookId };
}

async function settle(rounds = 30) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function readingActions(requests) {
  return requests.filter((request) => request.body?.op === 'extensions.ui.action'
    && request.body.arg?.payload?.op === 'setReading');
}

function lastReadingPayload(requests) {
  return readingActions(requests).at(-1)?.body.arg.payload;
}

test('官方语音无覆盖模式保留本书显式语速 1，不按全局 1.25 渲染', async () => {
  const harness = createHarness({
    official: baseOfficial(),
    bookVoice: { source: 'official', profileId: '', voice: 'book-voice', speed: 1 },
    autoRead: true,
  });
  await settle();

  const speed = harness.document.querySelector('#readingSpeed');
  const voice = harness.document.querySelector('#readingOfficialVoice');
  assert.equal(Number(speed.value), 1);
  assert.equal(voice.value, 'book-voice');
  assert.equal(speed.disabled, true);
  assert.equal(voice.disabled, true);
  assert.equal(harness.document.querySelector('#readingApplyGlobal').classList.contains('hidden'), false);

  assert.match(harness.document.querySelector('#readingSaved').textContent, /book-voice/);
  assert.match(harness.document.querySelector('#readingSaved').textContent, /语速 1/);

  harness.document.querySelector('#readingForm').dispatch('submit');
  await settle();
  const payload = lastReadingPayload(harness.requests);
  assert.ok(payload, '普通保存必须发送 setReading');
  assert.equal(payload.ownerId, harness.ownerId);
  assert.equal(payload.bookId, harness.bookId);
  assert.equal(payload.autoRead, true);
  assert.equal(payload.useCurrentGlobal, false);
  assert.equal(payload.voice.source, 'official');
  assert.equal(payload.voice.voice, 'book-voice');
  assert.equal(payload.voice.speed, 1);
  assert.equal(payload.selection, undefined);
});

test('应用当前全局按钮提交 useCurrentGlobal:true 和实际全局语速', async () => {
  const harness = createHarness({ official: baseOfficial() });
  await settle();

  harness.document.querySelector('#readingApplyGlobal').dispatch('click');
  await settle();
  const payload = lastReadingPayload(harness.requests);
  assert.ok(payload, '应用全局设置必须发送 setReading');
  assert.equal(payload.useCurrentGlobal, true);
  assert.equal(payload.voice.source, 'official');
  assert.equal(payload.voice.profileId, '');
  assert.equal(payload.voice.voice, 'global-voice');
  assert.equal(payload.voice.speed, 1);
});

test('MiMo 显示已保存 1.25 与实际生效 1，并显示限制与缺失配置', async () => {
  const harness = createHarness({
    official: baseOfficial({
      missing: ['API Key'],
      configured: false,
      limitations: ['无法读取全局语音配置。', '只使用已保存的全局语音配置。'],
    }),
  });
  await settle();

  const state = harness.document.querySelector('#readingOfficialState').textContent;
  assert.match(state, /已保存全局语速：1\.25/);
  assert.match(state, /实际生效语速：1/);
  assert.match(state, /MiMo 固定原速/);
  assert.match(harness.document.querySelector('#readingMissing').textContent, /缺少配置：API Key/);
  assert.match(harness.document.querySelector('#readingLimitations').textContent, /只使用已保存的全局语音配置/);
  assert.equal(harness.document.querySelector('#readingApplyGlobal').disabled, true);
  assert.equal(harness.document.querySelector('#readingOfficialVoice').disabled, true);
});

test('切换来源时官方无覆盖字段保持禁用，扩展音色与语速可编辑', async () => {
  const harness = createHarness({ official: baseOfficial() });
  await settle();

  const source = harness.document.querySelector('#readingSource');
  const profile = harness.document.querySelector('#readingProfile');
  const speed = harness.document.querySelector('#readingSpeed');
  const officialVoice = harness.document.querySelector('#readingOfficialVoice');
  const apply = harness.document.querySelector('#readingApplyGlobal');

  assert.equal(officialVoice.disabled, true);
  assert.equal(speed.disabled, true);
  assert.equal(profile.disabled, true);

  source.value = 'extension';
  source.dispatch('change');
  assert.equal(profile.disabled, false);
  assert.equal(speed.disabled, false);
  assert.equal(officialVoice.disabled, true);
  assert.equal(apply.classList.contains('hidden'), true);

  source.value = 'official';
  source.dispatch('change');
  assert.equal(profile.disabled, true);
  assert.equal(speed.disabled, true);
  assert.equal(officialVoice.disabled, true);
  assert.equal(apply.classList.contains('hidden'), false);
});

test('安装 FFmpeg 使用共享依赖 op 并随后刷新面板状态', async () => {
  const harness = createHarness({ official: baseOfficial() });
  await settle();

  harness.document.querySelector('#deps').dispatch('click');
  await settle();

  const shared = harness.requests.find((request) => request.body?.op === 'sharedDeps.install');
  assert.ok(shared, '必须调用宿主共享依赖安装');
  assert.equal(shared.url, '/roost/api/quick');
  assert.equal(shared.options.method, 'POST');
  assert.equal(shared.options.credentials, 'same-origin');
  assert.equal(shared.options.cache, 'no-store');
  assert.match(shared.options.headers['content-type'], /application\/json/);
  assert.deepEqual(shared.body, { op: 'sharedDeps.install', arg: { name: 'ffmpeg' } });

  const after = harness.requests.slice(harness.requests.indexOf(shared) + 1);
  assert.ok(after.some((request) => request.body?.op === 'extensions.ui.action'
    && request.body.arg?.payload?.op === 'status'), '安装后必须用现有面板 status 动作刷新依赖状态');
  assert.ok(!after.some((request) => request.body?.arg?.payload?.op === 'installDeps'));
});
