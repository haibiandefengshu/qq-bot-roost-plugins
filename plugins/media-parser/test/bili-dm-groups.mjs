import test from 'node:test';
import assert from 'node:assert/strict';
import { GROUP_EMPTY_HINT, createBiliDmGroupCatalog } from '../bili-dm-groups.js';
import { biliFixture } from './bili-integration-support.mjs';

function catalogFixture({ stats = { byChat: [] }, groups = {}, binding = {} } = {}) {
  const ctx = {
    state: {},
    ledger: { stats: typeof stats === 'function' ? stats : async () => stats },
    async getGroup(id) {
      const profile = Object.prototype.hasOwnProperty.call(groups, id) ? groups[id] : null;
      return profile ? { groupOpenid: id, ...profile } : null;
    },
  };
  return { ctx, groups, binding, create: (options = {}) => createBiliDmGroupCatalog({
    ctx, store: { binding: () => options.binding ?? binding }, ...options,
  }) };
}

test('group candidates come from bounded ledger stats and are revalidated by the host', async () => {
  const f = catalogFixture({
    stats: {
      byChat: {
        'group-known': { kind: 'group' },
        'group-disabled': { kind: 'group' },
        'private-user': { kind: 'c2c' },
      },
      file: 'PRIVATE-LEDGER-FILE',
      content: 'PRIVATE-CONTENT',
    },
    groups: {
      'group-known': { name: '已知群' },
      'group-disabled': { name: '停用群', enabled: false },
    },
  });
  const catalog = f.create();
  const listed = await catalog.list();
  assert.deepEqual(listed.groups, [{ id: 'group-known', name: '已知群' }]);
  assert.deepEqual(listed.selected, { sendToGroup: false, groupId: '' });
  assert.equal(JSON.stringify(listed).includes('PRIVATE'), false);
  assert.match(GROUP_EMPTY_HINT, /最近识别/);
});

test('ledger stats may be synchronous or asynchronous and array shaped', async () => {
  const groups = { 'group-one': { name: '一群' }, 'group-two': { name: '二群' } };
  const sync = await createBiliDmGroupCatalog({
    ctx: {
      state: {},
      ledger: { stats: () => ({ byChat: [{ kind: 'group', groupOpenid: 'group-one' }, { kind: 'c2c', groupOpenid: 'group-two' }] }) },
      async getGroup(id) { return groups[id] ? { groupOpenid: id, ...groups[id] } : null; },
    },
    store: { binding: () => ({}) },
  }).list();
  assert.deepEqual(sync.groups, [{ id: 'group-one', name: '一群' }]);
  const asyncResult = await createBiliDmGroupCatalog({
    ctx: {
      state: {},
      ledger: { stats: async () => ({ byChat: { 'group-two': { kind: 'GROUP' } } }) },
      async getGroup(id) { return groups[id] ? { groupOpenid: id, ...groups[id] } : null; },
    },
    store: { binding: () => ({}) },
  }).list();
  assert.deepEqual(asyncResult.groups, [{ id: 'group-two', name: '二群' }]);
});

test('ordinary group observers fill a bounded cache that survives catalog reloads', async () => {
  const f = catalogFixture({
    groups: {
      'group-observed': { name: '观察群' },
      'group-bot': { name: '机器人发言群' },
    },
  });
  const first = f.create();
  assert.equal(first.observe({ kind: 'group', groupId: 'group-observed' }), true);
  assert.equal(first.observe({ kind: 'c2c', userId: 'owner' }), false);
  assert.equal(first.observe({ kind: 'group', groupId: 'group-bot', isBot: true }), false);
  assert.equal(Array.isArray(f.ctx.state.mediaParserDmGroupIds), true);
  const reloaded = f.create();
  const listed = await reloaded.list();
  assert.deepEqual(listed.groups, [{ id: 'group-observed', name: '观察群' }]);

  for (let index = 0; index < 240; index += 1) first.observe({ kind: 'group', chatId: `group-${index}` });
  assert.equal(f.ctx.state.mediaParserDmGroupIds.length, 200);
  assert.equal(f.ctx.state.mediaParserDmGroupIds[0], 'group-239');
});

test('the persisted group destination is always reconsidered and validated on resolve', async () => {
  const f = catalogFixture({
    groups: {
      'group-target': { name: '目标群' },
      'group-disabled': { name: '停用群', enabled: false },
      'group-mismatch': { name: '错配群' },
    },
    binding: { target: 'owner-1', version: 3, notifyKind: 'group', groupTarget: 'group-target' },
  });
  const catalog = f.create();
  const listed = await catalog.list();
  assert.deepEqual(listed.selected, { sendToGroup: true, groupId: 'group-target' });
  assert.deepEqual(listed.groups, [{ id: 'group-target', name: '目标群' }]);
  assert.deepEqual(await catalog.resolve('group-target'), { id: 'group-target', name: '目标群' });
  assert.equal(await catalog.resolve('group-unknown'), null);
  assert.equal(await catalog.resolve('group-disabled'), null);
  const mismatch = await createBiliDmGroupCatalog({
    ctx: {
      state: {},
      ledger: { stats: async () => ({ byChat: [] }) },
      async getGroup() { return { groupOpenid: 'different-group', name: '错配群' }; },
    },
    store: { binding: () => ({}) },
  });
  assert.equal(await mismatch.resolve('group-mismatch'), null);
});

test('the runtime listener caches group ids without bodies and keeps them across a reload', async (t) => {
  const env = await biliFixture(t, {
    groups: { 'group-listened': { name: '监听群' } },
  });
  await env.runtime.ready;
  const listener = env.listeners.get('message')[0];
  const group = env.makeMessage({ kind: 'group', chatId: 'group-listened', content: 'PRIVATE-BODY' });
  group.msg.groupId = 'group-listened';
  await listener(group.msg);
  assert.equal(env.ctx.state.mediaParserDmGroupIds.includes('group-listened'), true);
  assert.equal(JSON.stringify(env.ctx.state.mediaParserDmGroupIds).includes('PRIVATE-BODY'), false);
  const fresh = await env.reload();
  const listed = await fresh.dmGroups.list();
  assert.deepEqual(listed.groups, [{ id: 'group-listened', name: '监听群' }]);
  await fresh.deactivate('test cleanup');
  await fresh.settings.flush();
});
