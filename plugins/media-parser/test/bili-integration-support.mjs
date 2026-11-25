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

function engine(control) {
  const status = { phase: 'preparing', ready: false, version: '0.1.0', cache: { bytes: 0 } };
  return {
    status: () => ({ ...status }),
    async ensure() {
      control.calls.ensure += 1;
      if (control.ensureUnavailable) {
        Object.assign(status, { phase: 'error', ready: false, lastError: 'python unavailable' });
        return false;
      }
      Object.assign(status, { phase: 'ready', ready: true });
      return true;
    },
    async parse() { control.calls.parse += 1; return { links: [], items: [], plan: { messages: [] } }; },
    async health() { return { ...status }; },
    async platforms() { return []; },
    async stop() { control.calls.stop += 1; Object.assign(status, { phase: 'stopped', ready: false }); return true; },
    async restart() { control.calls.restart += 1; Object.assign(status, { phase: 'ready', ready: true }); return true; },
    async clean() { control.calls.clean += 1; return { removed: 0 }; },
    async cleanupFiles() { return { removed: 0 }; },
    async holdFiles() { return { ok: true }; },
    async releaseFiles() { return { ok: true }; },
  };
}

export async function biliFixture(t, {
  config = {}, owner = true, isOwnerProvided = true, bindingTarget = 'owner-1',
  ensureUnavailable = false, serviceStatus = {}, loginState = {}, directory,
  groups = {}, ledgerStats = null,
} = {}) {
  const dir = directory ?? await fs.mkdtemp(path.join(os.tmpdir(), 'roost-bili-integration-'));
  await fs.mkdir(dir, { recursive: true });
  const calls = {
    ensure: 0, parse: 0, stop: 0, restart: 0, clean: 0,
    bind: [], claim: [], sendTest: [], view: [], configureTarget: [], reconcile: 0, pump: 0,
    serviceStart: 0, serviceCheck: 0, servicePause: 0, serviceDeactivate: 0,
    serviceConfigChanged: 0, serviceFlush: 0, storeFlush: 0, deliveryDeactivate: 0,
    loginStart: 0, loginCancel: 0, loginInspect: 0, loginManual: [], loginLogout: 0,
    loginDeactivate: 0,
  };
  const logs = [];
  const commands = new Map();
  const listeners = new Map();
  const routes = new Map();
  const pages = new Map();
  const disposers = [];
  const ledger = new Map();
  const control = { calls, ensureUnavailable };
  const storeControl = { flushGate: null, bindingTarget };
  let state = {
    accounts: {},
    binding: {
      target: bindingTarget, version: bindingTarget ? 1 : 0,
      notifyKind: 'c2c', groupTarget: '', groupName: '',
    },
    currentUid: '123',
  };
  const store = {
    ready: Promise.resolve(),
    binding: () => ({ ...state.binding }),
    read: (fn) => fn(state),
    async transaction(fn) {
      const draft = structuredClone(state);
      const result = await fn(draft);
      state = draft;
      return result;
    },
    async flush() {
      calls.storeFlush += 1;
      if (storeControl.flushGate) await storeControl.flushGate.promise;
    },
    async setCurrentUid(uid) { state.currentUid = uid; },
    statusCounters: () => ({
      unfinished: 1, pending: 0, unknown: 0, failed: 0, sent: 0,
      pendingConversations: 0, gapConversations: 0,
    }),
    limits: { maxUnfinished: 1000, maxFileBytes: 20 * 1024 * 1024, maxSends: 2, windowMs: 60000 },
    loadError: () => null,
    async ensureAccount() {},
  };
  const deliveryControl = {
    claimResult: { sent: 1, remaining: 0 },
    testResult: { sent: 1, states: ['sent'] },
    viewResult: { ok: true, sent: 1 },
  };
  const dmDelivery = {
    async bind(msg) {
      calls.bind.push({ userId: msg.userId, chatId: msg.chatId, kind: msg.kind });
      return { ok: true, bound: true, version: 2, mask: `***${String(msg.userId).slice(-4)}` };
    },
    async pump() { calls.pump += 1; },
    async reconcile() { calls.reconcile += 1; },
    async claim(msg) { calls.claim.push({ userId: msg.userId, chatId: msg.chatId }); return { ...deliveryControl.claimResult }; },
    async sendTest(msg) {
      calls.sendTest.push(msg ? { userId: msg.userId, chatId: msg.chatId } : { mode: 'stored-binding' });
      return { ...deliveryControl.testResult };
    },
    async configureTarget(target, { guard } = {}) {
      calls.configureTarget.push({ kind: target?.kind, target: target?.target });
      if (guard !== undefined && (typeof guard !== 'function' || guard() !== true)) {
        const error = new Error('stale delivery generation');
        error.code = 'DM_STALE';
        throw error;
      }
      const kind = target?.kind === 'group' ? 'group' : 'c2c';
      state = {
        ...state,
        binding: {
          ...state.binding,
          notifyKind: kind,
          groupTarget: kind === 'group' ? String(target?.target || '') : '',
          groupName: kind === 'group' ? String(groups?.[target?.target]?.name || '') : '',
          version: Number(state.binding?.version || 0) + 1,
        },
      };
      return { ok: true };
    },
    async view(msg, options) {
      calls.view.push({ userId: msg.userId, shortId: options?.shortId, page: options?.page });
      return { ...deliveryControl.viewResult };
    },
    status: () => ({ state: 'bound', binding: { bound: true, mask: '***0001' }, queue: {} }),
    deactivate() { calls.deliveryDeactivate += 1; },
    async flush() {},
  };
  let currentStatus = {
    state: 'watching', reasonCode: '', nextRetryAt: null, lastCheckAt: 1_700_000_000_000, lastSuccessAt: 1_700_000_000_000,
    account: { loggedIn: true, verified: true },
    binding: { bound: Boolean(bindingTarget), mask: bindingTarget ? `***${bindingTarget.slice(-4)}` : '', version: bindingTarget ? 1 : 0 },
    discovery: { phase: 'complete', baselineComplete: true, pages: 2, sessionCount: 3, gap: false },
    queue: { unfinished: 1, pending: 0, unknown: 0, failed: 0, sent: 0, pendingConversations: 0, gapConversations: 0 },
    polling: { seconds: 60, requestBudget: 20 },
    noticePending: false,
    ...serviceStatus,
  };
  const dmService = {
    ready: Promise.resolve(),
    start() { calls.serviceStart += 1; return currentStatus; },
    async check() { calls.serviceCheck += 1; return currentStatus; },
    pause() { calls.servicePause += 1; return currentStatus; },
    async logout() { return currentStatus; },
    deactivate() { calls.serviceDeactivate += 1; return currentStatus; },
    configChanged() { calls.serviceConfigChanged += 1; return currentStatus; },
    async flush() { calls.serviceFlush += 1; },
    status: () => currentStatus,
    consumeNotice: () => null,
  };
  const login = {
    state: 'valid', expiresAt: null, pngDataUrl: null, errorCode: null, errorSummary: null, retryAfterMs: 0,
    inspectState: 'valid', startGate: null, deactivated: false,
    status() { return { ...this }; },
    async start() {
      calls.loginStart += 1;
      if (this.startGate) await this.startGate;
      if (this.deactivated) {
        this.state = 'cancelled';
        this.pngDataUrl = null;
        return this.status();
      }
      this.state = 'waiting';
      this.expiresAt = Date.now() + 180000;
      this.pngDataUrl = `data:image/png;base64,${Buffer.from('synthetic-qr').toString('base64')}`;
      return this.status();
    },
    cancel() {
      calls.loginCancel += 1;
      this.state = 'cancelled';
      this.pngDataUrl = null;
      return this.status();
    },
    async inspect() {
      calls.loginInspect += 1;
      return { state: this.inspectState };
    },
    async manual(cookie) {
      calls.loginManual.push(cookie);
      this.state = 'success';
      this.pngDataUrl = null;
      return { ok: true, state: 'valid' };
    },
    async logout() {
      calls.loginLogout += 1;
      this.state = 'idle';
      return { ok: true, state: 'idle' };
    },
    deactivate() { calls.loginDeactivate += 1; this.deactivated = true; },
    async flush() {},
    ...loginState,
  };
  const modules = {
    createBiliDmStore: () => store,
    createBiliDmDelivery: () => dmDelivery,
    createBiliDmService: () => dmService,
  };
  const retained = { get: async (key) => ledger.get(key) ?? null };
  const ctx = {
    id: 'media-parser', name: '流媒体聚合解析', version: '0.2.0', prefix: '/',
    dataDir: dir, state: {}, config: { ...DEFAULTS, ...config },
    logger: Object.fromEntries(['info', 'warn', 'error', 'debug'].map((level) => [level, (...args) => logs.push({ level, text: args.join(' ') })])),
    storage: {
      async get(_key, fallback) { return fallback; },
      async set() {},
      async update(_key, _fn, fallback) { return fallback; },
      async delete() {},
      async all() { return {}; },
      async flush() {},
    },
    api: { appId: 'test-bot', seqMap: new Map() },
    delivery: retained,
    ledger: { stats: async () => ledgerStats ?? { byChat: [] } },
    gate: { check: () => ({ ok: true }) },
    async getGroup(id) {
      const profile = groups && Object.prototype.hasOwnProperty.call(groups, id) ? groups[id] : null;
      if (!profile) return null;
      return { groupOpenid: id, enabled: profile.enabled !== false, ...profile };
    },
    async isGroupAdmin() { return false; },
    async can() { return false; },
    async setConfig(patch) { Object.assign(ctx.config, patch); return ctx.config; },
    command(pattern, meta, fn) { commands.set(pattern.split(/\s+/)[0], { meta, fn }); },
    on(event, fn) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); },
    menu() {},
    registerPage(page) { pages.set(page.key, page); return `media-parser:${page.key}`; },
    registerRoute(method, url, fn) { routes.set(`${method} ${url}`, fn); return `${method} ${url}`; },
    setDashboard(value) { ctx.dashboard = value; },
    onTeardown(fn) { disposers.push(fn); },
    schedule() {},
    async callTool() { throw new Error('model must not be used'); },
    registerTool() { throw new Error('model tool must not be registered'); },
  };
  if (isOwnerProvided) ctx.isOwner = async (userId) => Boolean(owner && userId === bindingTarget);
  const plugin = createPlugin({
    engineFactory: () => engine(control),
    delivery: async () => ({ claimed: false, sent: {}, pending: 0, failed: 0, skipped: 0, reasons: [] }),
    dmModules: modules,
    biliClientFactory: () => ({
      async nav() { return { mid: '123', uname: '', serverTime: Date.now() }; },
      async sessions() { return { sessions: [], hasMore: false, serverTime: Date.now() }; },
      async messages() { return { messages: [], hasMore: false, minSeqno: null, maxSeqno: null, eInfos: [], serverTime: Date.now() }; },
    }),
    biliLoginFactory: () => login,
  });
  plugin.setup(ctx);
  const runtime = ctx.state.runtime;
  const makeMessage = ({
    content = 'https://b23.tv/AbCdE', kind = 'c2c', chatId = bindingTarget, userId = bindingTarget, ...other
  } = {}) => {
    const replies = [], sent = [];
    const msg = {
      id: randomUUID(), kind, chatId, userId,
      groupId: kind === 'group' ? chatId : '', userName: 'test-user',
      content, args: [], mentioned: false, isCommand: true,
      receivedAt: Date.now(), raw: {}, pluginId: 'media-parser', claimedBy: '',
      claim() { this.claimedBy ||= 'media-parser'; return true; },
      async reply(text) { replies.push(String(text)); return null; },
      async replyNow(text, options = {}) {
        sent.push({ type: 'text', text, options });
        return { id: `sent-${sent.length}` };
      },
      async replyImageBuffer(buffer, options = {}) { sent.push({ type: 'image-buffer', buffer, options }); return { id: 'img' }; },
      async replyImage(file, options = {}) { sent.push({ type: 'image', file, options }); return { id: 'img' }; },
      ...other,
    };
    return { msg, replies, sent };
  };
  const run = (args, options = {}) => {
    const message = makeMessage({ ...options, args });
    return commands.get('解析').fn(message.msg).then(() => message);
  };
  const route = async (method, url, { body = null, query = {}, params = {} } = {}) => {
    const fn = routes.get(`${method} ${url}`);
    if (!fn) throw new Error(`missing route ${method} ${url}`);
    const out = await fn({ body, query, params, method, json: (code, data) => ({ __response: { code, data } }) });
    return out?.__response ?? { code: 200, data: out };
  };
  const reload = async (options = {}) => {
    const next = createPlugin({
      engineFactory: () => engine(control),
      delivery: async () => ({ claimed: false, sent: {}, pending: 0, failed: 0, skipped: 0, reasons: [] }),
      dmModules: modules,
      biliClientFactory: () => ({ nav: async () => ({ mid: '123', uname: '', serverTime: Date.now() }) }),
      biliLoginFactory: () => login,
    });
    next.setup(ctx);
    const fresh = ctx.state.runtime;
    if (options.awaitDm !== false) await fresh.dmReady;
    return fresh;
  };
  t.after(async () => {
    for (const dispose of disposers) dispose();
    if (runtime.isActive()) await runtime.deactivate('test cleanup');
    await runtime.queue.flush();
    await runtime.settings.flush();
    await runtime.pageReady;
    if (!directory) await fs.rm(dir, { recursive: true, force: true });
  });
  const env = {
    dir, ctx, plugin, runtime, calls, commands, listeners, routes, pages, disposers, logs,
    store, storeControl, dmDelivery, deliveryControl, login, dmService, modules,
    makeMessage, run, route, reload, ledger,
    setServiceStatus(patch) { currentStatus = { ...currentStatus, ...patch }; return currentStatus; },
  };
  await runtime.dmReady;
  await runtime.pageReady;
  return env;
}
