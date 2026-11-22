import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSettings, DEFAULTS, MASK, readConfig, validateConfig, redact, redactUrl } from '../settings.js';

async function fixture(t, config = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-media-settings-'));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const ctx = { dataDir: dir, config: { ...DEFAULTS, ...config }, async setConfig(patch) { Object.assign(this.config, patch); return this.config; } };
  const settings = createSettings(ctx);
  await settings.ready;
  return { ctx, settings, dir };
}

test('flat defaults handle real config and testkit schema descriptors', () => {
  assert.deepEqual(readConfig({ config: {} }), { ...DEFAULTS });
  assert.equal(readConfig({ config: { enabled: { default: true }, maxFileMiB: 300 } }).maxFileMiB, 200);
  assert.equal(readConfig({ config: { timeoutSeconds: 900, maxLinks: 5 } }).timeoutSeconds, 300);
  assert.equal(readConfig({ config: { maxLinks: 5 } }).maxLinks, 3);
});

test('save accepts the same literal HTTP loopback addresses as EngineHost', () => {
  assert.equal(validateConfig({ engineUrl: 'http://127.0.0.1:3199/' }).engineUrl, 'http://127.0.0.1:3199');
  assert.equal(validateConfig({ engineUrl: 'http://[::1]:3199' }).engineUrl, 'http://[::1]:3199');
  for (const engineUrl of ['https://127.0.0.1:3199', 'http://localhost:3199', 'http://10.0.0.1:3199', 'http://127.0.0.1:3199/path', 'http://user:secret@127.0.0.1:3199']) {
    assert.throws(() => validateConfig({ engineUrl }));
  }
  assert.throws(() => validateConfig({ maxLinks: 4 }));
  assert.throws(() => validateConfig({ owner: true }));
});

test('advanced parameters persist across reload while secrets use a separate file and masks preserve them', async (t) => {
  const { ctx, settings, dir } = await fixture(t);
  await settings.saveAdvanced({
    message: { text_metadata: { render_to_image: true } },
    custom_future_parameter: { retained: 7 },
    bilibili_enhanced: { use_cookie: true, cookie: 'SESSDATA=private-value' },
    translation: { llm: { custom_provider: { api_key: 'private-key-1234', model: 'example' } } },
  });
  const advancedText = await fs.readFile(path.join(dir, 'engine-settings.json'), 'utf8');
  const secretText = await fs.readFile(path.join(dir, 'credentials.json'), 'utf8');
  assert.equal(advancedText.includes('private-value'), false);
  assert.equal(advancedText.includes('private-key-1234'), false);
  assert.equal(secretText.includes('SESSDATA=private-value'), true);
  assert.equal(settings.credentialHints()['bilibili_enhanced.cookie'].value, MASK);
  assert.equal(JSON.stringify(settings.advanced()).includes('private-key-1234'), false);
  await settings.saveAdvanced({ bilibili_enhanced: { cookie: MASK } });
  assert.equal((await fs.readFile(path.join(dir, 'credentials.json'), 'utf8')).includes('private-value'), true);
  const reloaded = createSettings(ctx); await reloaded.ready;
  assert.equal(reloaded.advanced().custom_future_parameter.retained, 7);
  assert.equal(reloaded.advanced().message.text_metadata.render_to_image, true);
});

test('flat translation uses enable, platform output modes use exact Python values, and prototype keys are rejected', async (t) => {
  const { settings } = await fixture(t);
  await settings.saveConfig({ translation: true, hotComments: 3, maxFileMiB: 75 });
  await settings.saveAdvanced({ parsers: { bilibili: '仅富媒体', zhihu: '仅文本' }, translation: { enabled: true } });
  const advanced = settings.advanced();
  assert.equal(advanced.translation.enable, true);
  assert.equal('enabled' in advanced.translation, false);
  assert.equal(advanced.message.hot_comments.count, 3);
  assert.equal(advanced.download.max_video_size_mb, 75);
  assert.equal(settings.platforms().find((x) => x.id === 'bilibili').mode, '仅富媒体');
  await assert.rejects(settings.saveAdvanced({ parsers: { bilibili: 'only-video' } }));
  await assert.rejects(settings.saveAdvanced(JSON.parse('{"__proto__":{"polluted":true}}')));
  assert.equal({}.polluted, undefined);
});

test('credential updates are serialized, masked in all projections and support explicit deletion', async (t) => {
  const { settings, dir } = await fixture(t);
  await Promise.all([
    settings.saveCredentials({ bilibili_enhanced: { cookie: 'bili-secret-value' } }),
    settings.saveCredentials({ pixiv: { cookie: 'pixiv-secret-value' } }),
  ]);
  const hints = settings.credentialHints();
  assert.equal(hints['bilibili_enhanced.cookie'].set, true);
  assert.equal(hints['pixiv.cookie'].set, true);
  assert.equal(settings.sanitize('raw bili-secret-value and pixiv-secret-value'), `raw ${MASK} and ${MASK}`);
  await settings.saveCredentials({ pixiv: { cookie: '' } });
  assert.equal(settings.credentialHints()['pixiv.cookie'].set, false);
  await assert.rejects(settings.saveCredentials({ parsers: { bilibili: '关闭' } }));
  assert.equal((await fs.readFile(path.join(dir, 'credentials.json'), 'utf8')).includes('bili-secret-value'), true);
});

test('redaction removes credential fields, auth query and proxy userinfo without changing ordinary resource query', () => {
  const value = redact({ cookie: 'private', api_key: 'private', url: 'https://xhslink.com/a?xsec_token=private&p=2' });
  assert.equal(value.cookie, MASK);
  assert.equal(value.api_key, MASK);
  assert.equal(value.url.includes('private'), false);
  assert.equal(value.url.includes('p=2'), true);
  assert.equal(redactUrl('https://alice:private@example.com/a?p=2'), 'https://example.com/a?p=2');
});
