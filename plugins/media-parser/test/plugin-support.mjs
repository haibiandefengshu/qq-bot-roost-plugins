import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPlugin } from '../index.js';
import { DEFAULTS } from '../settings.js';

export const tick = () => new Promise((resolve) => setImmediate(resolve));
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export async function fixture(t, { config = {}, ensure, parse, delivery, state, directory } = {}) {
  const dir = directory ?? await fs.mkdtemp(path.join(os.tmpdir(), 'roost-media-plugin-'));
  const cacheRoot = path.join(dir, 'cache');
  await fs.mkdir(cacheRoot, { recursive: true });
  const store = new Map(), commands = new Map(), listeners = new Map(), routes = new Map(), pages = new Map(), disposers = [], scheduled = [];
  const calls = { model: 0, ensure: 0, parse: [], delivery: 0, stop: 0, restart: 0, clean: 0, factory: 0 };
  const logs = [];
  const ledger = new Map();
  const status = { phase: 'preparing', ready: false, version: '0.1.0', cache: { bytes: 0 } };
  const engine = {
    cacheRoot,
    status: () => ({ ...status }),
    async ensure(options) {
      calls.ensure++;
      if (ensure) return ensure({ options, status, calls });
      Object.assign(status, { phase: 'ready', ready: true }); return true;
    },
    async parse(payload, options) {
      calls.parse.push({ payload, options });
      if (parse) return parse(payload, options);
      return { links: payload.text.split('\n'), items: [], plan: { messages: [] } };
    },
    async health() { return { ...status }; },
    async platforms() { return []; },
    async stop() { calls.stop++; Object.assign(status, { phase: 'stopped', ready: false }); return true; },
    async restart() { calls.restart++; Object.assign(status, { phase: 'ready', ready: true }); return true; },
    async clean() { calls.clean++; return { removed: 0 }; },
    async cleanupFiles() { return { removed: 0 }; },
    async holdFiles() { return { ok: true }; },
    async releaseFiles() { return { ok: true }; },
  };
  const ctx = {
    id: 'media-parser', name: '流媒体聚合解析', version: '0.1.0', prefix: '/',
    dataDir: dir, state: state ?? {}, config: { ...DEFAULTS, ...config },
    logger: Object.fromEntries(['info', 'warn', 'error', 'debug'].map((level) => [level, (...args) => logs.push({ level, text: args.join(' ') })])),
    storage: {
      async get(key, fallback) { return store.has(key) ? store.get(key) : fallback; },
      async set(key, value) { store.set(key, structuredClone(value)); },
      async update(key, fn, fallback) { const value = await fn(store.get(key) ?? fallback); if (value !== undefined && value !== null) store.set(key, value); return store.get(key); },
      async delete(key) { store.delete(key); },
      async all() { return Object.fromEntries(store); },
      async flush() {},
    },
    api: { appId: 'test-bot', seqMap: new Map() },
    delivery: { get: async (key) => ledger.get(key) ?? null, fail: async (key, code) => ledger.set(key, { state: 'failed', code }) },
    gate: { check: () => ({ ok: true, reasons: [] }) },
    async getGroup() { return null; },
    async isGroupAdmin() { return false; },
    async can() { return false; },
    isOwner() { return false; },
    async setConfig(patch) { Object.assign(ctx.config, patch); return ctx.config; },
    command(pattern, meta, fn) { commands.set(pattern.split(/\s+/)[0], { meta, fn }); },
    on(event, fn) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); },
    menu() {},
    registerPage(page) { pages.set(page.key, page); return `media-parser:${page.key}`; },
    registerRoute(method, url, fn) { routes.set(`${method} ${url}`, fn); return `${method} ${url}`; },
    setDashboard(value) { ctx.dashboard = value; },
    onTeardown(fn) { disposers.push(fn); },
    schedule(name, ms, fn) { scheduled.push({ name, ms, fn }); },
    async callTool() { calls.model++; throw new Error('模型调用不应发生'); },
    registerTool() { calls.model++; throw new Error('不应注册供模型调用的解析工具'); },
  };
  const plugin = createPlugin({
    engineFactory: () => { calls.factory++; return engine; },
    ...(delivery ? { delivery: async (...args) => { calls.delivery++; return delivery(...args); } } : {}),
  });
  const setupResult = plugin.setup(ctx);
  const runtime = ctx.state.runtime;
  const makeMessage = ({
    content = 'https://b23.tv/AbCdE', kind = 'group', chatId = 'group-one', userId = 'user-one', ...other
  } = {}) => {
    const messages = [], replies = [];
    const msg = {
      id: randomUUID(), kind, chatId, userId,
      groupId: kind === 'group' ? chatId : '', userName: '测试发送者',
      content, args: [], mentioned: false, isCommand: false,
      receivedAt: Date.now(), raw: {}, pluginId: 'media-parser', claimedBy: '',
      claim() { this.claimedBy ||= 'media-parser'; return true; },
      async reply(text) { replies.push(String(text)); this.replied = true; return null; },
      ...other,
    };
    const send = async (type, source, opts = {}) => {
      messages.push({ type, source, opts });
      ctx.api.seqMap.set(msg.id, (ctx.api.seqMap.get(msg.id) ?? 0) + 1);
      const result = { id: `sent-${messages.length}` };
      if (opts.requestId) ledger.set(opts.requestId, { state: 'sent' });
      return result;
    };
    msg.replyNow ??= (text, opts) => send('text', text, opts);
    msg.replyImage ??= (file, opts) => send('image', file, opts);
    msg.replyVideo ??= (file, opts) => send('video', file, opts);
    msg.replyVoice ??= (file, opts) => send('voice', file, opts);
    msg.replyFile ??= (file, opts) => send('file', file, opts);
    msg.replyAuto ??= async (text, opts) => {
      let result = null;
      for (const match of String(text).matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) result = await msg.replyImage(match[1], { ...opts, local: true });
      return result;
    };
    return { msg, messages, replies };
  };
  const route = async (method, url, { body = null, query = {}, params = {} } = {}) => {
    const fn = routes.get(`${method} ${url}`);
    if (!fn) throw new Error(`missing route ${method} ${url}`);
    const out = await fn({ body, query, params, method, json: (code, data) => ({ __response: { code, data } }) });
    return out?.__response ?? { code: 200, data: out };
  };
  t.after(async () => {
    for (const dispose of disposers) dispose();
    await runtime.queue.flush();
    await runtime.settings.flush();
    await runtime.pageReady;
    if (!directory) await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, cacheRoot, ctx, plugin, runtime, engine, status, calls, commands, listeners, routes, pages, disposers, scheduled, logs, makeMessage, route, setupResult, ledger };
}
