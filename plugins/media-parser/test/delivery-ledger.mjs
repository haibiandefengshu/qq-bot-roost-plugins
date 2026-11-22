import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { deliver } from '../delivery.js';
import { framework, frameworkRoot, harness, segment as s, outcome } from './delivery-framework.mjs';

const outboundModule = framework ? await import(pathToFileURL(path.join(frameworkRoot, 'src', 'outbound.js')).href) : null;
const ledgerModule = framework ? await import(pathToFileURL(path.join(frameworkRoot, 'src', 'delivery.js')).href) : null;

async function realChannel(t, responder = () => ({ id: 'platform-message' })) {
  const h = await harness(t); if (!h) return null;
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE deliveries (
    request_id TEXT PRIMARY KEY, bot_id TEXT, kind TEXT, chat_id TEXT,
    reply_to TEXT, msg_seq INTEGER, digest TEXT, state TEXT,
    attempts INTEGER DEFAULT 0, created_at INTEGER, source TEXT,
    msg_id TEXT, code TEXT, settled_at INTEGER
  )`);
  const delivery = ledgerModule.createDeliveryLedger({ db, botId: 'test-bot' });
  h.ctx.delivery = { get: delivery.get };
  h.ctx.api.sendGroup = async (target, payload) => {
    h.calls.push({ target, payload });
    h.ctx.api.seqMap.set(payload.msgId, (h.ctx.api.seqMap.get(payload.msgId) || 0) + 1);
    return responder(payload);
  };
  const outbound = new outboundModule.Outbound({
    api: h.ctx.api, cfg: { outbound: { perSec: 1000, downgradeToActive: true } },
    delivery, quotaFile: path.join(h.directory, 'quota.json'), queueIdleMs: 1,
  });
  h.msg = framework.buildMessage('GROUP_AT_MESSAGE_CREATE', {
    id: 'real-ledger-message', content: 'share', group_openid: 'group-id',
    author: { member_openid: 'user-id' },
  }, { api: h.ctx.api, cfg: { commandPrefix: '/', id: 'test-bot' }, outbound });
  h.msg.pluginId = 'media-parser';
  t.after(() => db.close());
  return { ...h, outbound, ledger: delivery };
}

test('真实 Roost Outbound + SQLite 投递账本：审核 pending 有据可查且不重复发送', async (t) => {
  const h = await realChannel(t, () => ({ code: 304024 })); if (!h) return;
  const input = outcome(s('image', await h.file()));
  const result = await deliver(input, h);
  assert.equal(result.pendingByType.image, 1);
  assert.equal(result.sent.image, 0);
  assert.equal(result.claimed, true);
  const imageAction = result.actions.find((action) => action.type === 'image');
  assert.equal(h.ledger.get(imageAction.requestId).state, 'audited');
  const before = h.calls.length;
  const retried = await deliver(input, h);
  assert.equal(h.calls.length, before);
  assert.equal(retried.pendingByType.image, 1);
});

test('真实 Roost Outbound + SQLite 投递账本：明确失败不算成功，所有出口失败时不 claim', async (t) => {
  const h = await realChannel(t, () => { throw Object.assign(new Error('offline'), { code: 'offline' }); }); if (!h) return;
  const result = await deliver(outcome(s('image', await h.file())), h);
  assert.equal(result.sent.image, 0);
  assert.equal(result.pending, 0);
  assert.equal(result.claimed, false);
  assert.equal(h.msg.claimedBy, '');
  assert.equal(h.ledger.get(result.actions[0].requestId).state, 'failed');
});

test('真实 Roost Outbound 保持主动降级开启，并在 5 次被动预算内发送图集和简短提示', async (t) => {
  const h = await realChannel(t); if (!h) return;
  const images = await Promise.all(Array.from({ length: 8 }, (_, index) => h.file(`gallery-${index}.png`)));
  const result = await deliver(outcome(...images.map((image) => s('image', image))), h);
  assert.equal(result.sent.image, 4);
  assert.equal(h.calls.length, 5);
  assert.equal(h.outbound.passiveCount.get(h.msg.id), 5);
  assert.equal(h.outbound.stats.active, 0);
  assert.ok(h.calls.every((call) => call.payload.msgId === h.msg.id));
  assert.match(h.calls.at(-1).payload.content, /部分内容未能发送/);
  assert.match(h.calls.at(-1).payload.content, /消息发送次数已达上限/);
  assert.doesNotMatch(h.calls.at(-1).payload.content, /已发送：|未发送：|原始链接/);
});
