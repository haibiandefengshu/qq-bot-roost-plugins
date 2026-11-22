import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const frameworkRoot = process.env.ROOST_TEST_ROOT || path.join(os.homedir(), '.dsh', 'dsh-roost', 'roost');
export const framework = await import(pathToFileURL(path.join(frameworkRoot, 'src', 'message.js')).href).catch(() => null);

export function segment(type, value) {
  return { type, data: type === 'text' ? { text: value } : { file: value } };
}

export function outcome(...segments) {
  return {
    links: ['https://www.bilibili.com/video/BV1xx411c7mD?p=2'],
    items: [],
    plan: { messages: [{ kind: 'segments', segments }] },
  };
}

export async function harness(t, options = {}) {
  if (!framework) { t.skip('未发现本机 Roost；设置 ROOST_TEST_ROOT 可运行真实框架契约测试'); return null; }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'media-delivery-'));
  const cacheRoot = path.join(directory, 'cache');
  await fs.mkdir(cacheRoot);
  const calls = [];
  const uploads = [];
  const ledger = new Map();
  const lifecycle = [];
  const api = {
    appId: 'test-bot', seqMap: new Map(),
    async uploadLocalFile(scene, target, filename, type) {
      uploads.push({ scene, target, filename, type, sharded: false });
      if (options.upload) return options.upload(filename, type);
      return { file_info: `${type}:${path.basename(filename)}` };
    },
    async uploadLocalFileSharded(scene, target, filename, type) {
      uploads.push({ scene, target, filename, type, sharded: true });
      if (options.upload) return options.upload(filename, type);
      return { file_info: `${type}:${path.basename(filename)}` };
    },
  };
  const outbound = {
    async send(params) {
      calls.push(params);
      lifecycle.push('send');
      const count = api.seqMap.get(params.payload.msgId) || 0;
      api.seqMap.set(params.payload.msgId, count + 1);
      if (ledger.get(params.requestId)?.state === 'sent') return { id: ledger.get(params.requestId).msg_id, reused: true };
      try {
        const returned = options.send ? await options.send(params, calls.length) : { id: `sent-${calls.length}` };
        if (options.ledger !== false) {
          if (returned?.pending) ledger.set(params.requestId, { state: 'audited' });
          else if (returned?.id) ledger.set(params.requestId, { state: 'sent', msg_id: returned.id });
        }
        return returned;
      } catch (error) {
        if (options.ledger !== false) ledger.set(params.requestId, { state: error.code === 'unknown' ? 'unknown' : 'failed' });
        throw error;
      }
    },
  };
  const kind = options.kind || 'group';
  const msg = framework.buildMessage(kind === 'c2c' ? 'C2C_MESSAGE_CREATE' : 'GROUP_AT_MESSAGE_CREATE', {
    id: options.id || 'message-id', content: 'https://www.bilibili.com/video/BV1xx411c7mD?p=2',
    group_openid: 'group-id', author: { member_openid: 'user-id', user_openid: 'user-id' },
  }, { api, cfg: { commandPrefix: '/', id: 'test-bot' }, outbound });
  msg.pluginId = 'media-parser';
  const claims = [];
  const originalClaim = msg.claim;
  msg.claim = () => { claims.push(calls.length); lifecycle.push('claim'); return originalClaim(); };
  msg.reply = () => { throw new Error('文案必须使用即时出口'); };
  const autos = [];
  const originalAuto = msg.replyAuto;
  msg.replyAuto = (text, opts) => { autos.push({ text, opts }); return originalAuto(text, opts); };
  const ctx = {
    dataDir: directory, api,
    delivery: { get: (id) => ledger.get(id) || null },
    logger: { warn() {}, debug() {}, info() {}, error() {} },
  };
  const engine = {
    cacheRoot,
    async holdFiles(files) { lifecycle.push(`hold:${files.length}`); },
    async releaseFiles(files) { lifecycle.push(`release:${files.length}`); },
  };
  t.after(async () => { await fs.rm(directory, { recursive: true, force: true }); });
  const file = async (name = 'image.png', size = 16) => {
    const filename = path.join(cacheRoot, name);
    await fs.writeFile(filename, Buffer.from('test-media-bytes'));
    await fs.truncate(filename, size);
    return filename;
  };
  return { directory, cacheRoot, calls, uploads, ledger, lifecycle, ctx, engine, msg, claims, file, autos };
}
