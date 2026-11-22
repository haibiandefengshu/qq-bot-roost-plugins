import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createPlugin } from '../index.js';
import { fixture, deferred, tick } from './plugin-support.mjs';

const textOutcome = (text = '文章正文') => ({
  links: ['https://b23.tv/AbCdE'], items: [],
  plan: { messages: [{ kind: 'segments', segments: [{ type: 'text', data: { text } }] }] },
});

test('setup registers one command and priority 40 without blocking engine preparation', async (t) => {
  const preparing = deferred();
  const env = await fixture(t, { ensure: async ({ status }) => { await preparing.promise; Object.assign(status, { ready: true, phase: 'ready' }); return true; } });
  assert.equal(env.setupResult, undefined);
  assert.equal(env.commands.size, 1);
  assert.equal(env.commands.has('解析'), true);
  assert.equal(env.plugin.priority, 40);
  assert.equal(env.plugin.frameworkVersion, '>=1.1.5');
  assert.equal(env.disposers.length, 1);
  await env.runtime.ready; await tick();
  const automatic = env.makeMessage();
  assert.equal(await env.listeners.get('message')[0](automatic.msg), undefined);
  assert.equal(env.calls.parse.length, 0);
  assert.equal(automatic.msg.claimedBy, '');
  const manual = env.makeMessage({ args: ['https://b23.tv/AbCdE'], isCommand: true });
  await env.commands.get('解析').fn(manual.msg);
  assert.match(manual.replies.join(), /准备中/);
  assert.equal(env.logs.filter((row) => row.text.includes('本轮放行')).length, 1);
  await env.listeners.get('message')[0](env.makeMessage().msg);
  assert.equal(env.logs.filter((row) => row.text.includes('本轮放行')).length, 1);
  preparing.resolve(); await env.runtime.bootstrap;
});

test('automatic trigger ignores disabled, claimed, robot, gated, disabled group, private and mention cases', async (t) => {
  const env = await fixture(t);
  await env.runtime.bootstrap;
  const listener = env.listeners.get('message')[0];
  for (const message of [
    { claimedBy: 'special-plugin' }, { isBot: true }, { raw: { author: { bot: true } } },
    { kind: 'guild' }, { kind: 'dm' }, { isCommand: true },
  ]) await listener(env.makeMessage(message).msg);
  env.ctx.config.enabled = false; await listener(env.makeMessage().msg); env.ctx.config.enabled = true;
  env.ctx.config.privateEnabled = false; await listener(env.makeMessage({ kind: 'c2c' }).msg); env.ctx.config.privateEnabled = true;
  env.ctx.config.requireMention = true; await listener(env.makeMessage().msg); env.ctx.config.requireMention = false;
  env.ctx.gate.check = () => ({ ok: false }); await listener(env.makeMessage().msg); env.ctx.gate.check = () => ({ ok: true });
  env.ctx.getGroup = async () => ({ enabled: false }); await listener(env.makeMessage().msg);
  assert.equal(env.calls.parse.length, 0);
});

test('automatic processing sends an actual text-image-text-video plan in order and claims after first send', async (t) => {
  let outcome;
  const env = await fixture(t, { parse: async () => outcome });
  const image = path.join(env.cacheRoot, 'image.jpg'), video = path.join(env.cacheRoot, 'clip.mp4');
  await fs.writeFile(image, Buffer.from('test-image')); await fs.writeFile(video, Buffer.from('test-video'));
  outcome = {
    links: ['https://b23.tv/AbCdE'], items: [{ videoCount: 1, imageCount: 1 }],
    plan: { messages: [{ kind: 'segments', segments: [
      { type: 'text', data: { text: '第一段正文' } },
      { type: 'image', data: { file: image } },
      { type: 'text', data: { text: '第二段正文' } },
      { type: 'video', data: { file: video } },
    ] }] },
  };
  await env.runtime.bootstrap;
  const message = env.makeMessage();
  const result = await env.listeners.get('message')[0](message.msg);
  assert.equal(result, true);
  assert.deepEqual(message.messages.map((item) => item.type), ['text', 'image', 'text', 'video']);
  assert.equal(message.messages[0].source, '第一段正文');
  assert.equal(message.replies.length, 0);
  assert.equal(message.msg.claimedBy, 'media-parser');
  assert.equal(env.calls.model, 0);
  assert.equal(env.calls.parse[0].payload.quoteFirstText, false);
});

test('three links share one parse request and one original receipt-based deadline', async (t) => {
  const env = await fixture(t, { delivery: async () => ({ claimed: false, sent: {}, pending: 0, failed: 0, skipped: 0, reasons: [] }) });
  await env.runtime.bootstrap;
  const text = ['https://b23.tv/one', 'https://b23.tv/two?p=2', 'https://b23.tv/one', 'https://v.douyin.com/three', 'https://github.com/alice/repo'].join(' ');
  const { msg } = env.makeMessage({ content: text, receivedAt: Date.now() - 1000 });
  await env.listeners.get('message')[0](msg);
  assert.equal(env.calls.parse.length, 1);
  assert.deepEqual(env.calls.parse[0].payload.text.split('\n'), ['https://b23.tv/one', 'https://b23.tv/two?p=2', 'https://v.douyin.com/three']);
  assert.equal(env.calls.parse[0].options.deadlineAt, msg.receivedAt + 300_000);
  assert.equal(env.calls.parse[0].options.signal instanceof AbortSignal, true);
});

test('natural text-only links pass through; media failure text still produces one useful claim', async (t) => {
  let outcome = textOutcome();
  const env = await fixture(t, { parse: async () => outcome });
  await env.runtime.bootstrap;
  const plain = env.makeMessage();
  assert.equal(await env.listeners.get('message')[0](plain.msg), undefined);
  assert.equal(plain.messages.length, 0);
  assert.equal(plain.msg.claimedBy, '');
  outcome = textOutcome('原视频下载失败');
  outcome.items = [{ videoCount: 0, videoSkipReasons: ['平台暂不允许下载'] }];
  const failed = env.makeMessage();
  assert.equal(await env.listeners.get('message')[0](failed.msg), true);
  assert.equal(failed.messages.some((item) => item.type === 'text'), true);
  assert.equal(failed.msg.claimedBy, 'media-parser');
});

test('all actual delivery methods returning null leave an automatic message unclaimed', async (t) => {
  const env = await fixture(t, { config: { handleTextOnly: true }, parse: async () => textOutcome() });
  await env.runtime.bootstrap;
  const { msg } = env.makeMessage({ replyNow: async () => null });
  assert.equal(await env.listeners.get('message')[0](msg), undefined);
  assert.equal(msg.claimedBy, '');
  assert.equal(env.runtime.queue.list().rows[0].failed > 0, true);
});

test('engine recovery is owned by EngineHost; plugin never adds another retry', async (t) => {
  const env = await fixture(t, { parse: async () => { throw Object.assign(new Error('unreachable'), { code: 'ENGINE_UNREACHABLE' }); } });
  await env.runtime.bootstrap;
  await env.listeners.get('message')[0](env.makeMessage().msg);
  assert.equal(env.calls.parse.length, 1);
  assert.equal(env.calls.ensure, 1);
});

test('ensure false stays visibly failed and does not clear restart-required status', async (t) => {
  const env = await fixture(t, { ensure: async ({ status }) => { Object.assign(status, { phase: 'error', ready: false, lastError: 'dependency installation failed' }); return false; } });
  await env.runtime.bootstrap;
  assert.equal(env.runtime.engineReady(), false);
  assert.match(env.runtime.publicStatus().prepareError, /dependency installation failed/);
  env.runtime.restartRequired = true;
  await assert.rejects(env.runtime.ensure(), /dependency installation failed/);
  assert.equal(env.runtime.restartRequired, true);
});

test('teardown and hot reload abort the old generation and prevent a late parse from sending', async (t) => {
  const parse = deferred();
  let deliveryCalls = 0;
  const env = await fixture(t, { parse: async () => parse.promise, delivery: async () => { deliveryCalls++; return { claimed: true }; } });
  await env.runtime.bootstrap;
  const message = env.makeMessage();
  const old = env.listeners.get('message')[0](message.msg);
  await tick();
  assert.equal(env.calls.parse.length, 1);
  const oldGeneration = env.runtime.generation;
  env.plugin.teardown(env.ctx);
  await old;
  assert.equal(env.calls.parse[0].options.signal.aborted, true);
  let reloadFactoryCalls = 0;
  const next = createPlugin({
    engineFactory: () => {
      reloadFactoryCalls++;
      return { ...env.engine };
    },
    delivery: async () => ({ claimed: false }),
  });
  next.setup(env.ctx);
  const freshRuntime = env.ctx.state.runtime;
  await freshRuntime.bootstrap;
  assert.equal(freshRuntime.generation, oldGeneration + 1);
  assert.equal(reloadFactoryCalls, 1);
  assert.notEqual(freshRuntime.engine, env.engine);
  assert.equal(freshRuntime.engine.cacheRoot, env.engine.cacheRoot);
  parse.resolve(textOutcome());
  await tick(); await tick();
  assert.equal(deliveryCalls, 0);
  assert.equal(message.messages.length, 0);
  freshRuntime.deactivate('test cleanup'); await freshRuntime.queue.flush(); await freshRuntime.settings.flush();
});

test('manual status and platforms disclose no secrets, channels are explicit, and group toggle delegates to host authority', async (t) => {
  const env = await fixture(t);
  await env.runtime.bootstrap;
  await env.runtime.settings.saveCredentials({ bilibili_enhanced: { cookie: 'hidden-credential-value' } });
  const command = env.commands.get('解析').fn;
  const status = env.makeMessage({ args: ['状态'], isCommand: true });
  await command(status.msg); assert.match(status.replies.join(), /支持平台：31/);
  const platforms = env.makeMessage({ args: ['平台'], isCommand: true });
  await command(platforms.msg); assert.equal(platforms.replies[0].split('\n').length, 31);
  const channel = env.makeMessage({ args: ['状态'], kind: 'guild' });
  await command(channel.msg); assert.match(channel.replies.join(), /未支持频道/);
  const ordinary = env.makeMessage({ args: ['关'] });
  await command(ordinary.msg); assert.match(ordinary.replies.join(), /管理员权限/);
  let checkedGroup;
  env.ctx.isGroupAdmin = async (groupId) => { checkedGroup = groupId; return true; };
  const admin = env.makeMessage({ args: ['关'] });
  await command(admin.msg);
  assert.equal(checkedGroup, admin.msg.groupId);
  assert.match(admin.replies.join(), /群插件 关 media-parser/);
  assert.equal(env.ctx.config.enabled, true);
  assert.equal(JSON.stringify(env.runtime.publicStatus()).includes('hidden-credential-value'), false);
  assert.equal(env.calls.model, 0);
});

test('robot and conversation keys separate bots, group and private contexts without trusting sender labels', async (t) => {
  const env = await fixture(t);
  await env.runtime.bootstrap;
  const group = env.makeMessage({ chatId: 'same', userName: 'not-an-identity' });
  const privateMsg = env.makeMessage({ kind: 'c2c', chatId: 'same' });
  await env.listeners.get('message')[0](group.msg);
  await env.listeners.get('message')[0](privateMsg.msg);
  assert.notEqual(env.calls.parse[0].payload.userKey, env.calls.parse[1].payload.userKey);
  assert.match(env.calls.parse[0].payload.userKey, /:group:same$/);
  assert.match(env.calls.parse[1].payload.userKey, /:c2c:same$/);
});
