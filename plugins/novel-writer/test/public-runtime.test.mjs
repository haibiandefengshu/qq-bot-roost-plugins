import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createPublicRuntime } from '../lib/public-runtime.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

function temp(t, prefix = '.tmp-public-') {
  const dir = mkdtempSync(join(TEST_DIR, prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function readJson(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (!chunks.length) return resolveBody({});
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
  });
  res.end(body);
}

async function listen(t, handler) {
  const server = createServer((req, res) => {
    Promise.resolve()
      .then(() => handler(req, res))
      .catch(() => sendJson(res, 500, { ok: false, error: 'fixture_failed' }));
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  t.after(() => new Promise((resolveClose) => {
    server.closeAllConnections?.();
    server.close(() => resolveClose());
  }));
  return `http://127.0.0.1:${server.address().port}/v1`;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitFor(check, timeoutMs = 2000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('条件等待超时');
    await delay(5);
  }
}

const VOICE_PROFILE_ID = '11111111-1111-4111-8111-111111111111';

function resetVoiceState() {
  const state = {
    statusCalls: 0,
    last: null,
    version: 'v1',
    values: {
      api: 'http://127.0.0.1:9880',
      sovitsWeights: 'sovits',
      gptWeights: 'gpt',
      refAudio: 'ref.wav',
      promptText: '参考',
      promptLang: 'zh',
      textLang: 'auto',
      speed: 1,
      maxChars: 60,
    },
  };
  globalThis.__novelVoiceFixture = state;
  return state;
}

function voiceFixtureSource(bundleVersion, includeLongForm) {
  return `
const testState = globalThis.__novelVoiceFixture ||= {
  statusCalls: 0,
  last: null,
  version: '${bundleVersion}',
  values: {
    api: 'http://127.0.0.1:9880',
    sovitsWeights: 'sovits',
    gptWeights: 'gpt',
    refAudio: 'ref.wav',
    promptText: '参考',
    promptLang: 'zh',
    textLang: 'auto',
    speed: 1,
    maxChars: 60
  }
};
testState.version = '${bundleVersion}';
export { testState };
export function createActions({ env, root } = {}) {
  return {
    status() {
      testState.statusCalls += 1;
      throw new Error('status must not be called');
    },
    profiles(payload = {}) {
      if (payload.op !== 'list') throw new Error('bad op');
      return {
        ok: true,
        data: {
          items: [{
            id: '${VOICE_PROFILE_ID}',
            name: testState.version === 'v2' ? '方案二' : '方案一',
            values: { ...testState.values }
          }]
        }
      };
    }${includeLongForm ? `,
    longForm(payload = {}) {
      testState.last = { ...payload, values: { ...payload.values } };
      return {
        ok: true,
        data: {
          wavBase64: Buffer.from('wav-' + testState.version + '-' + payload.text).toString('base64'),
          contentType: 'audio/wav',
          bytes: 4
        }
      };
    }` : ''}
  };
}
`;
}

function writeVoiceExtension(base, {
  version = '1.1.8',
  bundleVersion = 'v1',
  includeLongForm = true,
} = {}) {
  const extensionRoot = join(base, 'extensions', 'novel-writer');
  const sibling = join(base, 'extensions', 'voice-reply');
  mkdirSync(extensionRoot, { recursive: true });
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, 'plugin.json'), JSON.stringify({
    version,
    ui: { entry: 'entry.mjs', actions: [] },
  }));
  const entry = join(sibling, 'entry.mjs');
  writeFileSync(entry, voiceFixtureSource(bundleVersion, includeLongForm));
  return { extensionRoot, sibling, entry };
}

test('model.generate preserves instructions, isolates sessions and closes them', async (t) => {
  const dir = temp(t);
  const calls = [];
  const base = await listen(t, async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = await readJson(req);
    calls.push({
      method: req.method,
      path: url.pathname,
      search: url.search,
      body,
      authorization: req.headers.authorization || '',
    });
    if (url.pathname === '/v1/agent.new') return sendJson(res, 200, { ok: true, sessionId: body.sessionId });
    if (url.pathname === '/v1/agent.prompt') return sendJson(res, 200, { ok: true, text: '模型正文' });
    if (url.pathname === '/v1/agent.close') return sendJson(res, 200, { ok: true, sessionId: body.sessionId });
    return sendJson(res, 404, { ok: false, error: 'not_found' });
  });
  const runtime = createPublicRuntime({
    dataDir: join(dir, 'extension-data', 'novel-writer'),
    extensionRoot: join(dir, 'extensions', 'novel-writer'),
    env: { ROOST_API_URL: base, ROOST_API_TOKEN: 'token-secret' },
    config: {},
  });

  assert.equal(runtime.model.status().configured, true);
  assert.equal(runtime.model.status().provider, '');
  assert.equal(runtime.model.status().model, '');

  const out = await runtime.model.generate({
    taskId: 'task-1',
    stage: 'draft',
    system: 'SYS-ONE',
    messages: [
      { role: 'user', content: '第一段' },
      { role: 'assistant', content: '第二段' },
    ],
    maxTokens: 1234,
    temperature: 1.2,
  });
  assert.equal(out.text, '模型正文');

  const created = calls.find((call) => call.path === '/v1/agent.new');
  const prompted = calls.find((call) => call.path === '/v1/agent.prompt');
  const closed = calls.find((call) => call.path === '/v1/agent.close');
  assert.ok(created && prompted && closed);
  assert.ok(calls.indexOf(created) < calls.indexOf(prompted));
  assert.ok(calls.indexOf(prompted) < calls.indexOf(closed));
  assert.equal(created.authorization, 'Bearer token-secret');
  assert.equal(created.body.persist, false);
  assert.equal(created.body.clientId, 'novel-writer');
  assert.deepEqual(Object.keys(created.body.sections[0]).sort(), ['name', 'order', 'text']);
  assert.equal(created.body.sections[0].name, 'novel-writer-system');
  assert.equal(created.body.sections[0].text, 'SYS-ONE');
  assert.match(created.body.sessionId, /^novel:task-1:draft:/);
  assert.equal(prompted.search, '?wait=1');
  assert.equal(prompted.body.sessionId, created.body.sessionId);
  assert.match(prompted.body.text, /\[user\]\n第一段/);
  assert.match(prompted.body.text, /\[assistant\]\n第二段/);
  assert.equal(Object.hasOwn(prompted.body, 'maxTokens'), false);
  assert.equal(closed.body.sessionId, created.body.sessionId);

  await runtime.model.generate({
    taskId: 'task-1',
    stage: 'draft',
    system: 'SYS-TWO',
    messages: [{ role: 'user', content: '再来一次' }],
  });
  const sessions = calls.filter((call) => call.path === '/v1/agent.new').map((call) => call.body.sessionId);
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0], sessions[1]);
});

test('model.generate aborts promptly, discards late text and still closes the session', async (t) => {
  const dir = temp(t);
  const calls = [];
  let promptSeen = false;
  const base = await listen(t, async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = await readJson(req);
    calls.push({ path: url.pathname, body });
    if (url.pathname === '/v1/agent.new') return sendJson(res, 200, { ok: true, sessionId: body.sessionId });
    if (url.pathname === '/v1/agent.prompt') {
      promptSeen = true;
      await delay(150);
      return sendJson(res, 200, { ok: true, text: '迟到的正文' });
    }
    if (url.pathname === '/v1/agent.close') return sendJson(res, 200, { ok: true, sessionId: body.sessionId });
    return sendJson(res, 404, { ok: false, error: 'not_found' });
  });
  const runtime = createPublicRuntime({
    dataDir: join(dir, 'extension-data', 'novel-writer'),
    extensionRoot: join(dir, 'extensions', 'novel-writer'),
    env: { ROOST_API_URL: base, ROOST_API_TOKEN: 'token-secret' },
  });
  const controller = new AbortController();
  const pending = runtime.model.generate({
    taskId: 'abort-task',
    stage: 'draft',
    system: 'SYS',
    messages: [{ role: 'user', content: '正文提示' }],
    signal: controller.signal,
  });
  await waitFor(() => promptSeen);
  controller.abort(new Error('用户停止'));
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  const created = calls.find((call) => call.path === '/v1/agent.new');
  const closed = calls.find((call) => call.path === '/v1/agent.close');
  assert.ok(created && closed);
  assert.equal(closed.body.sessionId, created.body.sessionId);
});

test('model closes the known session when agent.new response is interrupted', async (t) => {
  const dir = temp(t);
  let newBody = null;
  let closeBody = null;
  let promptCalls = 0;
  const base = await listen(t, async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = await readJson(req);
    if (url.pathname === '/v1/agent.new') {
      newBody = body;
      await delay(200);
      return sendJson(res, 200, { ok: true, sessionId: body.sessionId });
    }
    if (url.pathname === '/v1/agent.prompt') {
      promptCalls += 1;
      return sendJson(res, 200, { ok: true, text: '不应提交' });
    }
    if (url.pathname === '/v1/agent.close') {
      closeBody = body;
      return sendJson(res, 200, { ok: true, sessionId: body.sessionId });
    }
    return sendJson(res, 404, { ok: false, error: 'not_found' });
  });
  const runtime = createPublicRuntime({
    dataDir: join(dir, 'extension-data', 'novel-writer'),
    extensionRoot: join(dir, 'extensions', 'novel-writer'),
    env: { ROOST_API_URL: base, ROOST_API_TOKEN: 'token-secret' },
  });
  const controller = new AbortController();
  const pending = runtime.model.generate({
    taskId: 'interrupted-new',
    stage: 'draft',
    messages: [{ role: 'user', content: '正文' }],
    signal: controller.signal,
  });
  await waitFor(() => Boolean(newBody));
  controller.abort(new Error('中断'));
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  await waitFor(() => Boolean(closeBody));
  assert.equal(closeBody.sessionId, newBody.sessionId);
  assert.equal(promptCalls, 0);
});

test('model rejects non-local API bases without leaking credentials or raw addresses', async (t) => {
  const dir = temp(t);
  let fetched = 0;
  const runtime = createPublicRuntime({
    dataDir: join(dir, 'extension-data', 'novel-writer'),
    extensionRoot: join(dir, 'extensions', 'novel-writer'),
    env: { ROOST_API_URL: 'http://example.com/v1', ROOST_API_TOKEN: 'SECRET-TOKEN' },
    fetchImpl: () => { fetched += 1; throw new Error('must not fetch'); },
  });
  await assert.rejects(runtime.model.generate({
    taskId: 'bad',
    stage: 'draft',
    messages: [{ role: 'user', content: 'x' }],
  }), (error) => {
    assert.equal(fetched, 0);
    assert.equal(error.message.includes('SECRET-TOKEN'), false);
    assert.equal(error.message.includes('example.com'), false);
    return true;
  });
});

test('official TTS exposes global values, rejects overrides and discards config drift', async (t) => {
  const dir = temp(t);
  const ttsPosts = [];
  let configGets = 0;
  let publicConfig = {
    tts: {
      enabled: true,
      provider: 'edge',
      edge: { voice: 'zh-CN-XiaoxiaoNeural' },
      speed: 1.25,
      maxChars: 80,
    },
  };
  let changeAfterSynthesis = false;
  const base = await listen(t, async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = await readJson(req);
    if (url.pathname === '/v1/config') {
      configGets += 1;
      return sendJson(res, 200, { ok: true, config: publicConfig, revision: 'r1' });
    }
    if (url.pathname === '/v1/tts') {
      ttsPosts.push(body);
      if (changeAfterSynthesis) {
        publicConfig = {
          tts: {
            enabled: true,
            provider: 'edge',
            edge: { voice: 'zh-CN-XiaoxiaoNeural' },
            speed: 1.3,
            maxChars: 80,
          },
        };
      }
      return sendJson(res, 200, {
        ok: true,
        audio: Buffer.from('FF-data').toString('base64'),
        contentType: 'audio/mpeg',
        bytes: 7,
      });
    }
    return sendJson(res, 404, { ok: false, error: 'not_found' });
  });
  const runtime = createPublicRuntime({
    dataDir: join(dir, 'extension-data', 'novel-writer'),
    extensionRoot: join(dir, 'extensions', 'novel-writer'),
    env: { ROOST_API_URL: base, ROOST_API_TOKEN: 'token-secret' },
  });

  const sources = await runtime.voice.listSources();
  assert.equal(sources.official.available, true);
  assert.equal(sources.official.configured, true);
  assert.equal(sources.official.provider, 'edge');
  assert.equal(sources.official.voice, 'zh-CN-XiaoxiaoNeural');
  assert.equal(sources.official.speed, 1.25);
  assert.equal(sources.official.savedSpeed, 1.25);
  assert.equal(sources.official.effectiveSpeed, 1.25);
  assert.equal(sources.official.globalSpeed, 1.25);
  assert.equal(sources.official.engineChecked, false);
  assert.equal(sources.official.supportsSpeedOverride, false);
  assert.ok(sources.official.limitations.some((line) => /全局/.test(line)));

  const snapshot = await runtime.voice.snapshot({ source: 'official' }, 'chapter-1');
  assert.equal(snapshot.speed, 1.25);
  assert.equal(snapshot.savedSpeed, 1.25);
  assert.equal(snapshot.effectiveSpeed, 1.25);
  assert.equal(snapshot.globalSpeed, 1.25);
  assert.equal(snapshot.fingerprint.length, 64);
  assert.equal(snapshot.chunkChars, 80);
  await assert.rejects(
    runtime.voice.snapshot({ source: 'official', speed: 1 }, 'chapter-2'),
    /实际语速/,
  );
  await assert.rejects(
    runtime.voice.snapshot({ source: 'official', speed: 1.5 }, 'chapter-3'),
    /实际语速/,
  );
  await assert.rejects(
    runtime.voice.snapshot({ source: 'official', voice: 'other-voice' }, 'chapter-4'),
    /全局音色/,
  );
  const matching = await runtime.voice.snapshot({
    source: 'official',
    speed: 1.25,
    voice: 'zh-CN-XiaoxiaoNeural',
  }, 'chapter-5');
  assert.equal(matching.speed, 1.25);

  const audio = await runtime.voice.synthesizeSegment('hello', snapshot, {});
  assert.equal(Buffer.isBuffer(audio.audio), true);
  assert.equal(audio.audio.toString('utf8'), 'FF-data');
  assert.equal(audio.contentType, 'audio/mpeg');
  assert.deepEqual(ttsPosts[0], { text: 'hello' });
  assert.ok(configGets >= 2);

  changeAfterSynthesis = true;
  const drifting = await runtime.voice.snapshot({ source: 'official' }, 'chapter-6');
  const postsBefore = ttsPosts.length;
  await assert.rejects(
    runtime.voice.synthesizeSegment('late', drifting, {}),
    /配置已更改/,
  );
  assert.equal(ttsPosts.length, postsBefore + 1);
});

test('MiMo reports saved versus effective speed and requires its masked key', async (t) => {
  const dir = temp(t);
  let publicConfig = {
    tts: {
      enabled: true,
      provider: 'mimo',
      speed: 1.25,
      mimo: { apiKey: '', voice: 'mimo_default' },
    },
  };
  const base = await listen(t, async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    await readJson(req);
    if (url.pathname === '/v1/config') {
      return sendJson(res, 200, { ok: true, config: publicConfig, revision: 'r1' });
    }
    return sendJson(res, 404, { ok: false, error: 'not_found' });
  });
  const runtime = createPublicRuntime({
    dataDir: join(dir, 'extension-data', 'novel-writer'),
    extensionRoot: join(dir, 'extensions', 'novel-writer'),
    env: { ROOST_API_URL: base, ROOST_API_TOKEN: 'token-secret' },
  });

  const incomplete = await runtime.voice.listSources();
  assert.equal(incomplete.official.configured, false);
  assert.equal(incomplete.official.savedSpeed, 1.25);
  assert.equal(incomplete.official.effectiveSpeed, 1);
  assert.equal(incomplete.official.speed, 1);
  assert.ok(incomplete.official.missing.includes('API Key'));
  assert.ok(incomplete.official.limitations.some((line) => /MiMo/.test(line)));
  await assert.rejects(
    runtime.voice.snapshot({ source: 'official' }, 'mimo-missing-key'),
    /API Key/,
  );

  publicConfig = {
    tts: {
      enabled: true,
      provider: 'mimo',
      speed: 1.25,
      mimo: { apiKey: '******', voice: 'mimo_default' },
    },
  };
  const complete = await runtime.voice.listSources();
  assert.equal(complete.official.configured, true);
  const snapshot = await runtime.voice.snapshot({ source: 'official', speed: 1 }, 'mimo-1');
  assert.equal(snapshot.savedSpeed, 1.25);
  assert.equal(snapshot.effectiveSpeed, 1);
  assert.equal(snapshot.speed, 1);
  await assert.rejects(
    runtime.voice.snapshot({ source: 'official', speed: 1.25 }, 'mimo-override'),
    /实际语速/,
  );
});

test('GPT-SoVITS completeness requires its public reference fields', async (t) => {
  const dir = temp(t);
  let publicConfig = {
    tts: {
      enabled: true,
      provider: 'gpt-sovits',
      speed: 1,
      gptSovits: {
        baseUrl: 'http://127.0.0.1:9880',
        referWavPath: '',
        promptText: '参考',
        promptLanguage: '中文',
        textLanguage: '中文',
      },
    },
  };
  const base = await listen(t, async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    await readJson(req);
    if (url.pathname === '/v1/config') {
      return sendJson(res, 200, { ok: true, config: publicConfig, revision: 'r1' });
    }
    return sendJson(res, 404, { ok: false, error: 'not_found' });
  });
  const runtime = createPublicRuntime({
    dataDir: join(dir, 'extension-data', 'novel-writer'),
    extensionRoot: join(dir, 'extensions', 'novel-writer'),
    env: { ROOST_API_URL: base, ROOST_API_TOKEN: 'token-secret' },
  });

  const incomplete = await runtime.voice.listSources();
  assert.equal(incomplete.official.configured, false);
  assert.ok(incomplete.official.missing.includes('参考音频'));
  publicConfig = {
    tts: {
      enabled: true,
      provider: 'gpt-sovits',
      speed: 1,
      gptSovits: {
        baseUrl: 'http://127.0.0.1:9880',
        referWavPath: 'ref.wav',
        promptText: '参考',
        promptLanguage: '中文',
        textLanguage: '中文',
      },
    },
  };
  const complete = await runtime.voice.listSources();
  assert.equal(complete.official.configured, true);
});

test('voice-reply discovery uses frozen profiles and never calls status', async (t) => {
  const dir = temp(t);
  const { extensionRoot } = writeVoiceExtension(dir);
  const state = resetVoiceState();
  const runtime = createPublicRuntime({
    dataDir: join(dir, 'extension-data', 'novel-writer'),
    extensionRoot,
    env: { ROOST_LAUNCHER_DIR: join(dir, 'launcher') },
  });

  const sources = await runtime.voice.listSources();
  assert.equal(sources.extension.available, true);
  assert.equal(sources.extension.configured, true);
  assert.equal(sources.extension.longForm, true);
  assert.deepEqual(sources.extension.profiles, [{ id: VOICE_PROFILE_ID, name: '方案一' }]);
  assert.equal(state.statusCalls, 0);

  const snapshot = await runtime.voice.snapshot({
    source: 'extension',
    profileId: VOICE_PROFILE_ID,
    speed: 0.8,
  }, 'voice-key');
  assert.equal(snapshot.source, 'extension');
  assert.equal(snapshot.profileId, VOICE_PROFILE_ID);
  assert.equal(snapshot.supportsSpeed, true);

  state.values.api = 'http://127.0.0.1:9999';
  state.values.speed = 1.7;
  const audio = await runtime.voice.synthesizeSegment('你好', snapshot);
  assert.equal(Buffer.isBuffer(audio.audio), true);
  assert.equal(audio.audio.toString('utf8'), 'wav-v1-你好');
  assert.equal(audio.contentType, 'audio/wav');
  assert.equal(state.last.profileId, VOICE_PROFILE_ID);
  assert.equal(state.last.values.api, 'http://127.0.0.1:9880');
  assert.equal(state.last.values.speed, 0.8);
  assert.equal(state.statusCalls, 0);
});

test('missing longForm fails extension narration discovery and snapshot', async (t) => {
  const dir = temp(t);
  const { extensionRoot } = writeVoiceExtension(dir, { includeLongForm: false });
  const state = resetVoiceState();
  const runtime = createPublicRuntime({
    dataDir: join(dir, 'extension-data', 'novel-writer'),
    extensionRoot,
    env: { ROOST_LAUNCHER_DIR: join(dir, 'launcher') },
  });

  const sources = await runtime.voice.listSources();
  assert.equal(sources.extension.available, false);
  assert.equal(sources.extension.configured, false);
  assert.equal(sources.extension.longForm, false);
  assert.equal(sources.extension.profiles.length, 1);
  assert.match(sources.extension.message, /长文合成/);
  await assert.rejects(runtime.voice.snapshot({
    source: 'extension',
    profileId: VOICE_PROFILE_ID,
  }, 'missing-long-form'), /长文合成能力/);
  assert.equal(state.statusCalls, 0);
});

test('voice-reply reloads a changed manifest version before new snapshots', async (t) => {
  const dir = temp(t);
  const first = writeVoiceExtension(dir, { version: '1.1.8', bundleVersion: 'v1' });
  const state = resetVoiceState();
  const runtime = createPublicRuntime({
    dataDir: join(dir, 'extension-data', 'novel-writer'),
    extensionRoot: first.extensionRoot,
    env: { ROOST_LAUNCHER_DIR: join(dir, 'launcher') },
  });

  const firstSources = await runtime.voice.listSources();
  assert.deepEqual(firstSources.extension.profiles, [{ id: VOICE_PROFILE_ID, name: '方案一' }]);
  const firstSnapshot = await runtime.voice.snapshot({
    source: 'extension',
    profileId: VOICE_PROFILE_ID,
  }, 'version-one');

  writeVoiceExtension(dir, { version: '2.0.0', bundleVersion: 'v2' });
  const secondSources = await runtime.voice.listSources();
  assert.deepEqual(secondSources.extension.profiles, [{ id: VOICE_PROFILE_ID, name: '方案二' }]);
  const secondSnapshot = await runtime.voice.snapshot({
    source: 'extension',
    profileId: VOICE_PROFILE_ID,
  }, 'version-two');
  const secondAudio = await runtime.voice.synthesizeSegment('更新', secondSnapshot);
  assert.equal(secondAudio.audio.toString('utf8'), 'wav-v2-更新');
  await assert.rejects(
    runtime.voice.synthesizeSegment('旧任务', firstSnapshot),
    /扩展已更新/,
  );
  assert.equal(state.statusCalls, 0);
});

test('artifacts keep owner checks, containment and cleanup', async (t) => {
  const dir = temp(t);
  const dataDir = join(dir, 'extension-data', 'novel-writer');
  const outputs = join(dataDir, 'outputs');
  mkdirSync(outputs, { recursive: true });
  const good = join(outputs, 'chapter.txt');
  writeFileSync(good, '正文');
  const runtime = createPublicRuntime({
    dataDir,
    extensionRoot: join(dir, 'extensions', 'novel-writer'),
    env: {},
  });

  const artifact = await runtime.artifacts.register({
    ownerKey: 'owner-a',
    bookId: 'book-a',
    kind: 'txt',
    path: good,
    fileName: 'chapter.txt',
    bytes: Buffer.byteLength('正文'),
  });
  assert.equal(runtime.artifacts.resolve(artifact.id, 'owner-a').path, good);
  assert.throws(() => runtime.artifacts.resolve(artifact.id, 'owner-b'), /不属于当前书库/);

  const outside = join(dir, 'outside.txt');
  writeFileSync(outside, 'outside');
  await assert.rejects(runtime.artifacts.register({
    ownerKey: 'owner-a',
    path: outside,
    fileName: 'outside.txt',
  }), /不在小说专属目录内/);
  await assert.rejects(runtime.artifacts.register({
    ownerKey: 'owner-a',
    path: join(outputs, '..', 'outside.txt'),
    fileName: 'outside.txt',
  }), /不在小说专属目录内/);

  let linked = false;
  try {
    symlinkSync(outside, join(outputs, 'link.txt'), 'file');
    linked = true;
  } catch {
    linked = false;
  }
  if (linked) {
    await assert.rejects(runtime.artifacts.register({
      ownerKey: 'owner-a',
      path: join(outputs, 'link.txt'),
      fileName: 'link.txt',
    }), /路径校验失败/);
  }

  const oldFile = join(outputs, 'old.txt');
  writeFileSync(oldFile, 'old');
  await runtime.artifacts.register({
    ownerKey: 'owner-a',
    path: oldFile,
    fileName: 'old.txt',
  });
  const removed = await runtime.artifacts.cleanup({ now: Date.now() + 60_000, maxAgeMs: 1 });
  assert.ok(removed.removed >= 1);
  assert.equal(existsSync(oldFile), false);

  let aliasLinked = false;
  const keepFile = join(outputs, 'keep.txt');
  const aliasFile = join(outputs, 'alias.txt');
  writeFileSync(keepFile, 'keep');
  try {
    symlinkSync(keepFile, aliasFile, 'file');
    aliasLinked = true;
  } catch {
    aliasLinked = false;
  }
  if (aliasLinked) {
    await runtime.artifacts.register({
      ownerKey: 'owner-a',
      path: aliasFile,
      fileName: 'alias.txt',
    });
    const aliasRemoved = await runtime.artifacts.cleanup({ now: Date.now() + 60_000, maxAgeMs: 1 });
    assert.ok(aliasRemoved.removed >= 1);
    assert.equal(existsSync(aliasFile), false);
    assert.equal(existsSync(keepFile), true);
  }
});

test('managed FFmpeg is found without a panel, with env and PATH fallbacks', async (t) => {
  const dir = temp(t);
  const extensionRoot = join(dir, 'extensions', 'novel-writer');
  mkdirSync(extensionRoot, { recursive: true });
  const platform = `${process.platform}-${process.arch}`;
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const managed = join(dir, 'deps', 'node_modules', '@ffmpeg-installer', platform, exe);
  mkdirSync(dirname(managed), { recursive: true });
  writeFileSync(managed, 'binary');

  const runtime = createPublicRuntime({
    dataDir: join(dir, 'extension-data', 'novel-writer'),
    extensionRoot,
    env: {},
  });
  assert.equal(runtime.ffmpegBinary(), managed);
  const status = runtime.dependencies.status();
  assert.equal(status.ready, true);
  assert.equal(status.source, 'managed');
  assert.equal(status.managed, true);
  assert.equal(status.packages[0].available, true);
  const install = await runtime.dependencies.install();
  assert.equal(install.ok, false);
  assert.match(install.message, /共享依赖/);

  const dataOnlyRoot = join(dir, 'data-only-root');
  const dataOnlyDir = join(dataOnlyRoot, 'extension-data', 'novel-writer');
  const dataOnlyManaged = join(dataOnlyRoot, 'deps', 'node_modules', '@ffmpeg-installer', platform, exe);
  mkdirSync(dirname(dataOnlyManaged), { recursive: true });
  writeFileSync(dataOnlyManaged, 'binary');
  const dataOnlyRuntime = createPublicRuntime({ dataDir: dataOnlyDir, env: {} });
  assert.equal(dataOnlyRuntime.ffmpegBinary(), dataOnlyManaged);
  assert.equal(dataOnlyRuntime.dependencies.status().depsDir, join(dataOnlyRoot, 'deps'));

  const injectedDeps = join(dir, 'injected-deps');
  const injected = join(injectedDeps, 'node_modules', '@ffmpeg-installer', platform, exe);
  mkdirSync(dirname(injected), { recursive: true });
  writeFileSync(injected, 'binary');
  const injectedRuntime = createPublicRuntime({
    dataDir: join(dir, 'other-data', 'novel-writer'),
    extensionRoot,
    env: { ROOST_DEPS_DIR: injectedDeps },
  });
  assert.equal(injectedRuntime.ffmpegBinary(), injected);

  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const systemBinary = join(binDir, exe);
  writeFileSync(systemBinary, 'binary');
  const pathRuntime = createPublicRuntime({
    dataDir: join(dir, 'third-data', 'novel-writer'),
    extensionRoot: join(dir, 'not-extensions', 'novel-writer'),
    env: { PATH: binDir, Path: binDir },
  });
  assert.equal(pathRuntime.ffmpegBinary(), systemBinary);
  assert.equal(pathRuntime.dependencies.status().source, 'system');
});

test('dispose aborts in-flight generations and clears snapshots', async (t) => {
  const dir = temp(t);
  let promptSeen = false;
  let closeSeen = false;
  const base = await listen(t, async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = await readJson(req);
    if (url.pathname === '/v1/agent.new') return sendJson(res, 200, { ok: true, sessionId: body.sessionId });
    if (url.pathname === '/v1/agent.prompt') {
      promptSeen = true;
      await delay(150);
      return sendJson(res, 200, { ok: true, text: '迟到' });
    }
    if (url.pathname === '/v1/agent.close') {
      closeSeen = true;
      return sendJson(res, 200, { ok: true, sessionId: body.sessionId });
    }
    return sendJson(res, 404, { ok: false, error: 'not_found' });
  });
  const runtime = createPublicRuntime({
    dataDir: join(dir, 'extension-data', 'novel-writer'),
    extensionRoot: join(dir, 'extensions', 'novel-writer'),
    env: { ROOST_API_URL: base, ROOST_API_TOKEN: 'token-secret' },
  });
  const pending = runtime.model.generate({
    taskId: 'dispose-task',
    stage: 'draft',
    messages: [{ role: 'user', content: 'x' }],
  });
  await waitFor(() => promptSeen);
  runtime.dispose();
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  await waitFor(() => closeSeen);
  await assert.rejects(runtime.model.generate({
    taskId: 'closed',
    stage: 'draft',
    messages: [{ role: 'user', content: 'x' }],
  }), /已关闭/);
});
