import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { deliver, createDelivery, flattenPlan, splitText, TEXT_LIMIT, passiveBudget, deliveryState } from '../delivery.js';
import { segment as s, outcome, harness } from './delivery-framework.mjs';

test('真实框架出口保留文字—图片—文字—视频顺序，首个确认后立即 claim', async (t) => {
  const h = await harness(t); if (!h) return;
  const image = await h.file();
  const video = await h.file('video.mp4');
  const input = outcome(s('text', '正文前'), s('image', image), s('text', '正文后'), s('video', video));
  const result = await deliver(input, h);
  assert.deepEqual(h.calls.map((call) => call.payload.content || call.payload.media.file_info), ['正文前', '1:image.png', '正文后', '2:video.mp4']);
  assert.deepEqual(result.sent, { text: 2, image: 1, video: 1, voice: 0, file: 0 });
  assert.deepEqual(h.claims, [1]);
  assert.equal(result.claimed, true);
  assert.ok(h.lifecycle.indexOf('hold:2') < h.lifecycle.indexOf('send'));
  assert.equal(h.lifecycle.at(-1), 'release:2');
  assert.ok(h.calls.every((call) => call.payload.msgId === h.msg.id));
});

test('forward 递归展开；4 张相邻图片显式 maxMedia=4，不使用默认 3 张截断', async (t) => {
  const h = await harness(t); if (!h) return;
  const images = await Promise.all([1, 2, 3, 4].map((index) => h.file(`${index}.png`)));
  const input = outcome();
  input.plan.messages = [{
    kind: 'forward', nodes: [{ type: 'node', data: { content: [
      s('image', images[0]), { type: 'forward', data: { content: [
        { type: 'node', data: { content: images.slice(1).map((file) => s('image', file)) } },
      ] } },
    ] } }],
  }];
  const result = await deliver(input, h);
  assert.equal(result.sent.image, 4);
  assert.equal(result.failed, 0);
  assert.equal(h.autos[0].opts.maxMedia, 4);
  assert.deepEqual(h.uploads.map((upload) => upload.filename), images);
  assert.equal(h.calls.length, 4);
});

test('图集超出群聊预算时发送简短提示，但不重复发送原链接', async (t) => {
  const h = await harness(t); if (!h) return;
  const images = await Promise.all(Array.from({ length: 7 }, (_, index) => h.file(`${index}.png`)));
  const result = await deliver(outcome(...images.map((image) => s('image', image))), h);
  assert.equal(result.sent.image, 4);
  assert.equal(result.skippedByType.image, 3);
  assert.equal(h.calls.length, 5);
  assert.match(h.calls.at(-1).payload.content, /部分内容未能发送/);
  assert.match(h.calls.at(-1).payload.content, /消息发送次数已达上限/);
  assert.doesNotMatch(h.calls.at(-1).payload.content, /已发送：|未发送：|原始链接/);
  assert.doesNotMatch(h.calls.at(-1).payload.content, /https?:\/\//);
  assert.ok(h.calls.every((call) => call.payload.msgId === h.msg.id));
});

test('带媒体的引擎正文会移除同来源原始链接，其他链接保持原样', async (t) => {
  const h = await harness(t); if (!h) return;
  const image = await h.file();
  const input = outcome(
    s('text', [
      '标题：测试视频',
      '原始链接：https://www.bilibili.com/video/BV1xx411c7mD?p=2',
      '参考：https://example.org/article',
    ].join('\n')),
    s('image', image),
  );
  await deliver(input, h);
  const caption = h.calls[0].payload.content;
  assert.doesNotMatch(caption, /bilibili\.com/);
  assert.match(caption, /example\.org\/article/);
  assert.doesNotMatch(caption, /^原始链接[：:]\s*$/m);
});

test('单聊实际预算是 4 次；已有 seqMap 回复会扣除预算', async (t) => {
  const h = await harness(t, { kind: 'c2c' }); if (!h) return;
  h.ctx.api.seqMap.set(h.msg.id, 2);
  assert.equal(passiveBudget(h.ctx, h.msg).remaining, 2);
  const image = await h.file();
  const result = await deliver(outcome(s('image', image), s('image', image), s('image', image)), h);
  assert.equal(result.sent.image, 1);
  assert.equal(result.skippedByType.image, 2);
  assert.equal(h.calls.length, 2);
});

test('单聊预算紧张时正文和媒体优先，摘要不挤掉最后一个文件', async (t) => {
  const h = await harness(t, { kind: 'c2c' }); if (!h) return;
  h.ctx.api.seqMap.set(h.msg.id, 2);
  const video = await h.file('large.mp4', 31 * 1048576);
  const result = await deliver(outcome(
    s('text', '⚠️ 链接中包含超过100MB的视频时将单独发送所有媒体'),
    s('text', '标题：测试视频'),
    s('video', video),
  ), h);
  assert.equal(result.sent.text, 1);
  assert.equal(result.sent.file, 1);
  assert.equal(result.skipped, 0);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].payload.content, '标题：测试视频');
  assert.equal(h.calls[1].payload.media.file_info, '4:large.mp4');
  assert.doesNotMatch(JSON.stringify(h.calls), /已发送：|未发送：|原始链接见本条分享消息/);
});

test('即时文字按 1500 字分段并在预算不足时明确省略', async (t) => {
  const h = await harness(t); if (!h) return;
  const input = outcome(s('text', '长'.repeat(8000)));
  const result = await deliver(input, { ...h, config: { handleTextOnly: true } });
  assert.equal(h.calls.length, 5);
  assert.ok(h.calls.every((call) => call.payload.content.length <= TEXT_LIMIT));
  assert.equal(result.skippedByType.text, 2);
  assert.match(h.calls.at(-1).payload.content, /部分内容未能发送/);
  assert.doesNotMatch(h.calls.at(-1).payload.content, /已发送：|未发送：|原始链接/);
  assert.equal(splitText('🙂'.repeat(1600)).join(''), '🙂'.repeat(1600));
});

test('天然纯文本默认放行；下载失败剩余文字仍有反馈', async (t) => {
  const h = await harness(t); if (!h) return;
  const plain = await deliver(outcome(s('text', '文章正文')), h);
  assert.equal(plain.claimed, false);
  assert.equal(h.calls.length, 0);
  const failedMedia = outcome(s('text', '视频介绍'));
  failedMedia.items = [{ videoCount: 1, videoModes: ['skip'], videoSkipReasons: ['视频超过大小限制'] }];
  const result = await deliver(failedMedia, h);
  assert.equal(result.claimed, true);
  assert.match(h.calls.at(-1).payload.content, /视频超过大小限制/);
});

test('null、任意非空对象和明确失败不能当作成功或 claim', async (t) => {
  for (const returned of [null, { ok: true }, {}]) {
    const h = await harness(t, { send: () => returned, ledger: false }); if (!h) return;
    const result = await deliver(outcome(s('image', await h.file())), { ...h, config: { sendCaption: false } });
    assert.equal(result.claimed, false);
    assert.equal(result.sent.image, 0);
    assert.equal(result.pending, 0);
    assert.deepEqual(h.claims, []);
    assert.ok(result.failed >= 1);
  }
});

test('媒体上传异常由真实 replyMedia 捕获为 null，onError 让适配器统计失败', async (t) => {
  const h = await harness(t, { upload: () => { throw new Error('模拟平台拒绝'); }, send: () => null, ledger: false }); if (!h) return;
  const result = await deliver(outcome(s('image', await h.file())), h);
  assert.equal(result.sent.image, 0);
  assert.equal(result.claimed, false);
  assert.equal(result.failedByType.image, 1);
  assert.ok(result.reasons.some((reason) => /未能发送/.test(reason)));
});

test('审核 pending 在第一次确认时 claim；账本 sent/pending/unknown 优先于 null 返回', async (t) => {
  const h = await harness(t, { send: () => ({ pending: true }) }); if (!h) return;
  const result = await deliver(outcome(s('image', await h.file())), h);
  assert.equal(result.sent.image, 0);
  assert.equal(result.pendingByType.image, 1);
  assert.equal(result.claimed, true);
  assert.deepEqual(h.claims, [1]);
  for (const state of ['sent', 'audited', 'pending', 'unknown']) {
    assert.equal((await deliveryState({ delivery: { get: () => ({ state }) } }, 'id', null)).state,
      state === 'sent' ? 'sent' : 'pending');
  }
});

test('稳定 requestId 重试沿用账本，不重发已确认动作', async (t) => {
  const h = await harness(t); if (!h) return;
  const input = outcome(s('text', '介绍'), s('image', await h.file()));
  const first = await deliver(input, { ...h, taskId: 'task-one' });
  const count = h.calls.length;
  const ids = first.actions.map((action) => action.requestId);
  const retry = await deliver(input, { ...h, taskId: 'task-two' });
  assert.deepEqual(retry.actions.map((action) => action.requestId), ids);
  assert.equal(h.calls.length, count);
});

test('图集投递键不受剩余预算和分组变化影响，重试不重复发送已发图片', async (t) => {
  const h = await harness(t); if (!h) return;
  const images = await Promise.all([1, 2, 3, 4].map((index) => h.file(`${index}.png`)));
  const input = outcome(...images.map((image) => s('image', image)));
  const first = await deliver(input, h);
  assert.equal(first.sent.image, 4);
  const count = h.calls.length;
  const retry = await deliver(input, h);
  assert.equal(retry.sent.image, 4);
  assert.equal(h.calls.length, count);
  assert.deepEqual(first.actions.map((action) => action.requestId), retry.actions.map((action) => action.requestId));
});

test('全部媒体先检查：超硬限和失踪文件会汇总，关闭文案仍发送失败说明', async (t) => {
  const h = await harness(t); if (!h) return;
  const big = await h.file('too-large.mp4', 200 * 1048576 + 1);
  const result = await deliver(outcome(s('text', '不应发送的标题'), s('video', big), s('image', `${h.cacheRoot}/missing.png`)), {
    ...h, config: { sendCaption: false, maxFileMiB: 300 },
  });
  assert.equal(h.uploads.length, 0);
  assert.equal(h.calls.length, 1);
  assert.equal(result.sent.text, 1);
  assert.equal(result.skipped, 2);
  assert.match(h.calls[0].payload.content, /200 MiB/);
  assert.match(h.calls[0].payload.content, /不存在或无法读取/);
  assert.doesNotMatch(h.calls[0].payload.content, /不应发送的标题/);
});

test('超过视频软限制使用框架文件分片出口且不额外占用文字摘要', async (t) => {
  const h = await harness(t); if (!h) return;
  const result = await deliver(outcome(s('video', await h.file('large.mp4', 31 * 1048576))), h);
  assert.equal(result.sent.video, 0);
  assert.equal(result.sent.file, 1);
  assert.equal(h.uploads[0].type, 4);
  assert.equal(h.uploads[0].sharded, true);
  assert.equal(h.calls.length, 1);
  assert.ok(result.reasons.some((reason) => /以文件发送/.test(reason)));
  assert.doesNotMatch(JSON.stringify(h.calls), /以文件发送|已发送：|未发送：/);
});

test('语音经过适配后使用真实 replyVoice 并进入语音成功统计', async (t) => {
  const h = await harness(t); if (!h) return;
  const audio = await h.file('audio.silk');
  const adapted = createDelivery({ prepareVoice: async (file) => ({ type: 'voice', file, reason: '' }) });
  const result = await adapted(outcome(s('record', audio)), h);
  assert.equal(result.sent.voice, 1);
  assert.equal(result.sent.file, 0);
  assert.equal(h.uploads[0].type, 3);
});

test('无转换依赖的音频使用完整文件出口，失败说明不会逐项刷屏', async (t) => {
  const h = await harness(t); if (!h) return;
  const adapted = createDelivery({
    prepareVoice: async (file) => ({ type: 'file', file, reason: '语音转换不可用，以完整音频文件发送' }),
  });
  const result = await adapted(outcome(s('record', await h.file('song.mp3')), s('record', await h.file('song2.mp3'))), h);
  assert.equal(result.sent.file, 2);
  assert.equal(h.calls.length, 3);
  assert.match(h.calls.at(-1).payload.content, /完整音频/);
});

test('取消、超时、过期和无支持会话不会出现迟到发送', async (t) => {
  const h = await harness(t); if (!h) return;
  const image = await h.file();
  const controller = new AbortController();
  const adapted = createDelivery({ resolveFile: async (...args) => {
    const { resolveMediaFile } = await import('../files.js');
    const file = await resolveMediaFile(...args);
    controller.abort();
    return file;
  } });
  await adapted(outcome(s('text', '尚未发送'), s('image', image)), { ...h, signal: controller.signal });
  assert.equal(h.calls.length, 0);
  assert.equal(h.claims.length, 0);
  h.msg.receivedAt = Date.now() - 286000;
  await deliver(outcome(s('image', image)), h);
  assert.equal(h.calls.length, 0);
  h.msg.kind = 'guild';
  const unsupported = await deliver(outcome(s('image', image)), h);
  assert.equal(unsupported.claimed, false);
  assert.match(unsupported.reasons.join(''), /未支持/);
});

test('完整计划验证在所有发送之前拒绝过深、过大、无效结构', async (t) => {
  const h = await harness(t); if (!h) return;
  const input = outcome(s('text', '不能先发送这一段'));
  let nested = { type: 'text', data: { text: '尾段' } };
  for (let index = 0; index < 15; index += 1) nested = { type: 'node', data: { content: [nested] } };
  input.plan.messages.push({ kind: 'forward', nodes: [nested] });
  await deliver(input, { ...h, config: { handleTextOnly: true } });
  assert.equal(h.calls.length, 0);
  assert.throws(() => flattenPlan(outcome(...Array.from({ length: 600 }, () => s('text', 'a')))), /节点上限/);
  assert.throws(() => flattenPlan(outcome(s('text', '字'.repeat(400000)))), /正文超过/);
});
