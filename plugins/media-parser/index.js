import { createHash, randomUUID } from 'node:crypto';
import { createEngineHost } from './engine-host.js';
import { deliver } from './delivery.js';
import { createSettings, readConfig } from './settings.js';
import { extractLinks } from './links.js';
import { createTaskQueue } from './queue.js';
import { detectHostBoundaries, previewOutcome, registerPanel } from './panel.js';
import { createBiliClient, SAFE_MESSAGES } from './bili-client.js';
import { createBiliLogin } from './bili-login.js';
import { createBiliDmGroupCatalog } from './bili-dm-groups.js';

export const VERSION = '0.2.0';

export function engineStatus(engine) {
  const status = typeof engine?.status === 'function' ? engine.status() : engine?.status;
  return status && typeof status === 'object' ? status : { state: 'unknown', ready: false };
}

const CONFIG_SCHEMA = {
  enabled: { type: 'boolean', default: true, label: '自动解析' },
  privateEnabled: { type: 'boolean', default: true, label: '私聊解析' },
  requireMention: { type: 'boolean', default: false, label: '群聊要求 @' },
  engineMode: { type: 'select', default: 'managed', options: ['managed', 'external'], label: '引擎模式' },
  engineUrl: { type: 'text', default: 'http://127.0.0.1:3199', label: '本机引擎地址' },
  maxLinks: { type: 'number', default: 3, min: 1, max: 3, label: '每条消息最多链接数' },
  maxFileMiB: { type: 'number', default: 200, min: 1, max: 200, label: '文件上限 MiB', desc: '有效上限还受当前通道限制' },
  timeoutSeconds: { type: 'number', default: 300, min: 5, max: 300, label: '本轮解析与发送总预算秒' },
  concurrency: { type: 'number', default: 2, min: 1, max: 8, label: '全局同时解析任务' },
  queueLimit: { type: 'number', default: 10, min: 0, max: 100, label: '等待任务上限' },
  queueWaitSeconds: { type: 'number', default: 30, min: 1, max: 30, label: '排队等待上限秒' },
  dedupeSeconds: { type: 'number', default: 120, min: 0, max: 3600, label: '同会话链接去重秒' },
  sendCaption: { type: 'boolean', default: true, label: '发送正常标题及正文' },
  handleTextOnly: { type: 'boolean', default: false, label: '接管天生纯文字结果' },
  audioMode: { type: 'select', default: 'auto', options: ['auto', 'voice', 'file'], label: '音频输出' },
  cacheSeconds: { type: 'number', default: 1800, min: 60, max: 86400, label: '缓存保留秒' },
  hotComments: { type: 'number', default: 0, min: 0, max: 20, label: '热评条数' },
  translation: { type: 'boolean', default: false, label: '翻译（可调用模型）' },
  pythonPath: { type: 'text', default: '', label: 'Python 可执行路径（可选）' },
  ffmpegPath: { type: 'text', default: '', label: 'ffmpeg 路径（可选）' },
  externalCacheRoot: { type: 'text', default: '', label: '外部模式本地缓存根' },
  biliDmEnabled: { type: 'boolean', default: false, label: 'B站私信提醒' },
  biliDmPollSeconds: { type: 'number', default: 60, min: 60, max: 1800, label: '私信轮询间隔秒' },
  biliDmIncludeSystem: { type: 'boolean', default: false, label: '纳入已支持的系统私信' },
};

const DM_CONFIG_KEYS = Object.freeze(['biliDmEnabled', 'biliDmPollSeconds', 'biliDmIncludeSystem']);
const DM_SAFE_TEXT = Object.freeze({
  DM_MODULE_UNAVAILABLE: '私信模块尚未就绪，请等待审核模块载入或查看管理页。',
  DM_STATE_CORRUPT: '私信状态文件损坏，原文件已保留，请管理员检查数据目录。',
  DM_STATE_UNSUPPORTED: '私信状态版本高于当前插件，已保留原文件未做重置。',
  DM_STATE_READ_FAILED: '私信状态文件读取失败，已保留原文件。',
  DM_WRITE_FAILED: '私信状态保存失败，本轮进度未推进。',
  DM_CAPACITY: '待投递私信已达数量或体积上限，已暂停抓取并保留进度。',
  DM_GAP: '私信历史存在无法确认的缺口，已停止推进并保留续拉位置。',
  DM_AMBIGUOUS_CURSOR: '私信分页边界无法可靠确认，已保留续拉位置。',
  DM_NO_SERVER_TIME: '缺少可用于基线确认的服务器时间，暂不推进。',
  DM_BUDGET: '本轮请求预算已用完，稍后继续。',
  DM_AUTH: 'B 站登录未登录或已失效，请重新登录。',
  DM_NETWORK: '暂时无法连接 B 站，稍后重试。',
  DM_TIMEOUT: '请求 B 站超时，稍后重试。',
  DM_RATE_LIMIT: '请求过于频繁，已进入退避。',
  DM_HTTP: 'B 站服务暂时不可用，稍后重试。',
  DM_RESPONSE: 'B 站返回了无法识别的数据，已停止推进。',
  DM_API: 'B 站拒绝了私信读取请求。',
  DM_CANCELLED: '操作已取消。',
  DM_BASELINE: '正在建立历史基线。',
  DM_CATCHUP: '正在追赶新增私信。',
  DM_NO_COOKIE: '尚未登录 B 站。',
  DM_NO_OWNER: '尚未绑定接收私聊。',
  DM_DISABLED: '私信提醒已停用。',
  DM_PAUSED: '私信提醒已暂停。',
  DM_LOGOUT: '已退出 B 站共享登录。',
  DM_RECOVERED: '私信读取已恢复。',
  DM_CREDENTIAL_CHANGED: '共享凭据已变更，正在重新校验账号。',
  DM_CONTENT_INVALID: '单条私信内容超过安全上限，未自动推进进度。',
  DM_MESSAGE_ID_INVALID: '单条私信缺少可靠 ID，未自动推进进度。',
  DM_ACCOUNT_INVALID: '私信账号状态无效。',
  DM_BINDING_REQUIRED: '请先绑定接收私聊。',
  DM_BINDING_INVALID: '接收目标格式不合法。',
  DM_GROUP_INVALID: '所选群不存在、已停用或不接受该目标，请刷新群列表后重试。',
  DM_GROUP_UNAVAILABLE: '当前私信投递模块尚不支持群目标，请稍后重试。',
  DM_OWNER_REQUIRED: '仅机器人主人可在私聊中操作。',
  DM_STATE_NOT_READY: '私信状态尚未加载完成。',
  DM_STALE: '旧代次任务结果已丢弃。',
  DM_ERROR: '私信功能暂时不可用。',
  DM_CONFIG: '私信配置不完整。',
});
const SAFE_LOGIN_STATES = new Set([
  'idle', 'starting', 'waiting', 'scanned', 'success', 'expired', 'cancelled',
  'error', 'missing', 'valid', 'invalid', 'unavailable',
]);
const SAFE_LOGIN_ERROR_CODES = new Set(Object.keys(SAFE_MESSAGES));
const SAFE_DISCOVERY_PHASES = new Set(['idle', 'baseline', 'rescan', 'complete']);
const DM_STATE_LABELS = Object.freeze({
  disabled: '已停用', waiting_login: '等待登录', waiting_owner: '等待绑定',
  initializing: '初始化中', watching: '监听中', catching_up: '追赶中',
  backoff: '退避中', paused_capacity: '容量暂停', error: '错误',
  unavailable: '不可用',
});
const LOGIN_STATE_LABELS = Object.freeze({
  idle: '未开始', starting: '生成中', waiting: '等待扫码', scanned: '已扫码待确认',
  success: '已登录', expired: '已过期', cancelled: '已取消', error: '错误',
  missing: '未登录', valid: '有效', invalid: '已失效', unavailable: '不可用',
});

function dmText(code) {
  return DM_SAFE_TEXT[String(code || '')] || DM_SAFE_TEXT.DM_ERROR;
}

function dmFailure(code) {
  const error = new Error(dmText(code));
  error.code = code;
  return error;
}

function dmErrorCode(error) {
  const code = String(error?.code || '');
  if (code.startsWith('DM_')) return DM_SAFE_TEXT[code] ? code : 'DM_ERROR';
  if (code.startsWith('BILI_')) return code;
  return 'DM_ERROR';
}

function dmErrorText(error) {
  const code = dmErrorCode(error);
  if (code.startsWith('BILI_')) return SAFE_MESSAGES[code] || '请求失败。';
  return dmText(code);
}

function safeMask(mask) {
  const text = typeof mask === 'string' ? mask : '';
  return /^\*{2,4}.{0,4}$/.test(text) ? text : '';
}

function loginSafe(status, includePng = false) {
  const value = status && typeof status === 'object' ? status : {};
  const errorCode = SAFE_LOGIN_ERROR_CODES.has(String(value.errorCode ?? '')) ? String(value.errorCode) : null;
  const out = {
    state: SAFE_LOGIN_STATES.has(value.state) ? value.state : 'unavailable',
    expiresAt: Number.isFinite(value.expiresAt) ? value.expiresAt : null,
    errorCode,
    errorSummary: errorCode ? SAFE_MESSAGES[errorCode] || null : null,
    retryAfterMs: Number.isFinite(value.retryAfterMs) ? Math.max(0, value.retryAfterMs) : 0,
  };
  if (includePng && typeof value.pngDataUrl === 'string'
    && value.pngDataUrl.startsWith('data:image/png;base64,')
    && value.pngDataUrl.length <= 512 * 1024) {
    out.pngDataUrl = value.pngDataUrl;
  }
  return out;
}

function formatTime(value) {
  if (!Number.isFinite(value) || value <= 0) return '—';
  try { return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }); } catch { return '—'; }
}

async function defaultDmModules() {
  try {
    const [service, store, delivery] = await Promise.all([
      import('./bili-dm.js'),
      import('./bili-dm-store.js'),
      import('./bili-dm-delivery.js'),
    ]);
    if (typeof service.createBiliDmService !== 'function'
      || typeof store.createBiliDmStore !== 'function'
      || typeof delivery.createBiliDmDelivery !== 'function') {
      throw new Error('missing export');
    }
    return {
      createBiliDmService: service.createBiliDmService,
      createBiliDmStore: store.createBiliDmStore,
      createBiliDmDelivery: delivery.createBiliDmDelivery,
    };
  } catch {
    const error = new Error('私信模块尚未就绪');
    error.code = 'DM_MODULE_UNAVAILABLE';
    throw error;
  }
}

function safeReasonCode(value) {
  const code = String(value ?? '');
  return Object.prototype.hasOwnProperty.call(DM_SAFE_TEXT, code) ? code : '';
}

function maskGroup(target) {
  const value = String(target || '');
  if (!value) return '';
  return value.length <= 4 ? '***' : `***${value.slice(-4)}`;
}

function safeDestination(runtime) {
  try {
    const binding = runtime.dmStore?.binding?.() ?? {};
    if (binding.notifyKind === 'group' && binding.groupTarget) {
      return { kind: 'group', label: `群 ${maskGroup(binding.groupTarget)}` };
    }
  } catch {}
  return { kind: 'c2c', label: '主人私聊' };
}

function buildDmStatus(runtime, settings) {
  const cfg = settings.current();
  const login = loginSafe(runtime.biliLogin?.status?.() ?? { state: 'unavailable' }, false);
  const out = {
    destination: safeDestination(runtime),
    available: Boolean(runtime.dm && !runtime.dmFatal),
    moduleError: runtime.dmLoadError ? dmText(runtime.dmLoadError) : '',
    enabled: cfg.biliDmEnabled === true,
    pollSeconds: cfg.biliDmPollSeconds,
    includeSystem: cfg.biliDmIncludeSystem === true,
    login,
    state: 'unavailable',
    reasonCode: '',
    reasonText: '',
    lastCheckAt: null,
    lastSuccessAt: null,
    nextRetryAt: null,
    account: { loggedIn: false, verified: false },
    binding: { bound: false, mask: '', version: 0 },
    discovery: { phase: 'idle', baselineComplete: false, pages: 0, sessionCount: 0, gap: false },
    queue: {
      unfinished: 0, pending: 0, unknown: 0, failed: 0, sent: 0,
      pendingConversations: 0, gapConversations: 0,
    },
    polling: { seconds: cfg.biliDmPollSeconds, requestBudget: 20 },
    noticePending: false,
  };
  if (!runtime.dm) {
    if (runtime.dmLoading && !runtime.dmLoadError) out.state = 'initializing';
    return out;
  }
  let status;
  try { status = runtime.dm.status(); } catch { return out; }
  if (!status || typeof status !== 'object') return out;
  out.state = DM_STATE_LABELS[status.state] ? status.state : 'error';
  out.reasonCode = safeReasonCode(status.reasonCode);
  out.reasonText = out.reasonCode ? dmText(out.reasonCode) : '';
  out.lastCheckAt = Number.isFinite(status.lastCheckAt) ? status.lastCheckAt : null;
  out.lastSuccessAt = Number.isFinite(status.lastSuccessAt) ? status.lastSuccessAt : null;
  out.nextRetryAt = Number.isFinite(status.nextRetryAt) ? status.nextRetryAt : null;
  out.account = {
    loggedIn: status.account?.loggedIn === true,
    verified: status.account?.verified === true,
  };
  out.binding = {
    bound: status.binding?.bound === true,
    mask: safeMask(status.binding?.mask),
    version: Number.isFinite(status.binding?.version) ? status.binding.version : 0,
  };
  out.discovery = {
    phase: SAFE_DISCOVERY_PHASES.has(status.discovery?.phase) ? status.discovery.phase : 'unknown',
    baselineComplete: status.discovery?.baselineComplete === true,
    pages: Math.max(0, Number(status.discovery?.pages) || 0),
    sessionCount: Math.max(0, Number(status.discovery?.sessionCount) || 0),
    gap: status.discovery?.gap === true,
  };
  out.queue = {
    unfinished: Math.max(0, Number(status.queue?.unfinished) || 0),
    pending: Math.max(0, Number(status.queue?.pending) || 0),
    unknown: Math.max(0, Number(status.queue?.unknown) || 0),
    failed: Math.max(0, Number(status.queue?.failed) || 0),
    sent: Math.max(0, Number(status.queue?.sent) || 0),
    pendingConversations: Math.max(0, Number(status.queue?.pendingConversations) || 0),
    gapConversations: Math.max(0, Number(status.queue?.gapConversations) || 0),
  };
  const seconds = Number(status.polling?.seconds);
  out.polling = {
    seconds: Number.isFinite(seconds) && seconds >= 60 && seconds <= 1800 ? Math.floor(seconds) : cfg.biliDmPollSeconds,
    requestBudget: 20,
  };
  out.noticePending = status.noticePending === true;
  return out;
}

function dmStatusText(status, prefix) {
  const login = LOGIN_STATE_LABELS[status.login?.state] || '不可用';
  const listening = DM_STATE_LABELS[status.state] || '不可用';
  const binding = status.binding?.bound ? `已绑定 ${status.binding.mask}` : '未绑定';
  const destination = status.destination?.kind === 'group'
    ? `${status.destination.label}（自动通知唯一目标）` : '主人私聊';
  const lines = [
    `登录：${login}；监听：${listening}${status.reasonText ? `（${status.reasonText}）` : ''}`,
    `接收：${destination}；主人绑定：${binding}`,
    `待发送 ${status.queue?.unfinished || 0}；待核对 ${status.queue?.pending || 0}；未知 ${status.queue?.unknown || 0}`,
    `上次成功：${formatTime(status.lastSuccessAt)}；下次重试：${formatTime(status.nextRetryAt)}`,
  ];
  if (status.state === 'initializing') lines.push('正在建立历史基线，完成后才会监听新增私信；历史未读不会批量转发。');
  if (status.moduleError) lines.push(status.moduleError);
  lines.push(`下一步：${prefix}解析 私信 待发 / 领取；登录与状态也可在「解析管理」查看。`);
  return lines.join('\n');
}

function botKey(ctx) {
  return createHash('sha256').update(String(ctx.dataDir)).digest('hex').slice(0, 16);
}

export function isBotMessage(msg) {
  return Boolean(msg?.isBot || msg?.isSelf || msg?.self ||
    msg?.raw?.author?.bot || msg?.raw?.author?.is_bot || msg?.raw?.author?.is_you ||
    msg?.raw?.sender?.isBot);
}

function sessionKey(ctx, msg) {
  return `${botKey(ctx)}:${msg.kind}:${String(msg.chatId ?? msg.groupId ?? msg.userId ?? '')}`;
}

async function allowed(ctx, msg, cfg, manual) {
  if (!msg || isBotMessage(msg) || msg.claimedBy && msg.claimedBy !== 'media-parser') return false;
  if (!manual && (msg.isCommand || !cfg.enabled)) return false;
  if (!['group', 'c2c'].includes(msg.kind)) return false;
  if (msg.kind === 'c2c' && !cfg.privateEnabled) return false;
  if (msg.kind === 'group' && cfg.requireMention && !msg.mentioned && !manual) return false;
  if (typeof ctx.gate?.check === 'function' && (await ctx.gate.check(msg.chatId))?.ok === false) return false;
  if (msg.kind === 'group' && typeof ctx.getGroup === 'function') {
    const group = await ctx.getGroup(msg.groupId || msg.chatId);
    if (group?.enabled === false) return false;
  }
  // Roost itself applies whitelist, pause and cfg.plugins.groups before dispatch.
  // Do not invent a second per-group list in this plugin.
  return true;
}

function parsePayload(ctx, msg, links, taskId, cfg) {
  return {
    text: links.map((link) => link.url).join('\n'),
    userKey: sessionKey(ctx, msg), senderName: String(msg.userName ?? '').slice(0, 120),
    senderId: String(msg.userId ?? '').slice(0, 200), quoteFirstText: false,
    taskId, maxLinks: cfg.maxLinks,
  };
}

function makeRuntime(ctx, state, {
  engineFactory, delivery, dmModules = null,
  biliClientFactory = createBiliClient, biliLoginFactory = createBiliLogin,
}) {
  const previous = state.runtime;
  let previousHandoff = Promise.resolve();
  if (previous) {
    try { previous.deactivate?.('插件热重载，旧代次任务已取消'); } catch { /* old shutdown is best effort */ }
    if (previous.handoff && typeof previous.handoff.then === 'function') {
      previousHandoff = Promise.resolve(previous.handoff).catch(() => {});
    }
  }
  const generation = (Number(state.generation) || 0) + 1;
  state.generation = generation;
  let runtimeRef = null;
  const settings = createSettings(ctx, {
    initialBarrier: previousHandoff,
    isActive: () => runtimeRef?.isActive?.() === true,
  });
  const runtime = {
    generation, settings, active: true, engineEnabled: true, restartRequired: false,
    previews: new Map(), operations: new Map(), boundaries: null,
    prepareError: '', unavailableLogged: false,
    dm: null, dmStore: null, dmDelivery: null, biliLogin: null,
    dmLoadError: '', dmFatal: false, dmLoading: true, dmReady: null,
    dmGroups: null, cookieUnsubscribe: null,
    handoff: null, shutdown: null,
    isActive: () => runtime.active && state.runtime === runtime && state.generation === generation,
    engineReady: () => {
      const status = engineStatus(runtime.engine);
      return runtime.isActive() && runtime.engineEnabled &&
        (status.ready === true || status.state === 'ready' || status.phase === 'ready');
    },
    refresh: () => {
      if (!runtime.isActive()) return;
      const stats = runtime.queue.snapshot();
      const status = engineStatus(runtime.engine);
      ctx.setDashboard?.({
        metrics: [
          { label: '引擎', value: status.state ?? status.phase ?? (status.ready ? 'ready' : 'unknown') },
          { label: '运行任务', value: stats.running, unit: '个' },
          { label: '等待任务', value: stats.waiting, unit: '个' },
          { label: '完成', value: stats.totals.completed ?? 0, unit: '次' },
          { label: '失败', value: stats.totals.failed ?? 0, unit: '次' },
          { label: '跳过', value: stats.totals.skipped ?? 0, unit: '次' },
          { label: '媒体发送', value: Object.entries(stats.totals.sent).filter(([type]) => type !== 'text').reduce((sum, [, count]) => sum + count, 0), unit: '项' },
          { label: '缓存', value: Number(status.cacheBytes ?? status.cache?.bytes ?? 0) / 1024 / 1024, unit: 'MiB' },
        ],
        note: settings.sanitize(runtime.prepareError || '普通群聊及 C2C；默认解析不调用模型。查看「解析管理」了解中间件与 DSH 外接边界。'),
      });
    },
    publicStatus: () => settings.sanitize({
      version: VERSION, generation, active: runtime.isActive(),
      engine: engineStatus(runtime.engine), ready: runtime.engineReady(),
      queue: runtime.queue.snapshot(), platformCount: settings.platforms().length,
      prepareError: runtime.prepareError, restartRequired: runtime.restartRequired,
      operations: [...runtime.operations.values()].slice(-20), boundaries: runtime.boundaries,
    }),
    deactivate(reason) {
      if (!runtime.active) return runtime.shutdown ?? runtime.handoff ?? Promise.resolve();
      runtime.active = false;
      runtime.queue.cancelAll(reason);
      try { runtime.cookieUnsubscribe?.(); } catch { /* cookie subscription cleanup is best effort */ }
      runtime.cookieUnsubscribe = null;
      try { runtime.dm?.deactivate?.(); } catch { /* DM shutdown is best effort */ }
      try { runtime.biliLogin?.deactivate?.(); } catch { /* login shutdown is best effort */ }
      // The new generation only waits for the storage write tail, not for an
      // in-flight host send or network request. Already-entered host sends are
      // reconciled from the delivery ledger by the new generation.
      runtime.handoff = Promise.allSettled([
        Promise.resolve().then(() => settings.flush()),
        runtime.dmStore?.flush ? Promise.resolve().then(() => runtime.dmStore.flush()) : Promise.resolve(),
      ]).then(() => {});
      runtime.handoff.catch(() => {});
      runtime.shutdown = Promise.allSettled([runtime.handoff, runtime.queue.flush()]).then(() => {});
      runtime.shutdown.catch(() => {});
      return runtime.shutdown;
    },
  };
  state.runtime = runtime;
  runtimeRef = runtime;
  runtime.dmGroups = createBiliDmGroupCatalog({
    ctx,
    store: { binding: () => runtime.dmStore?.binding?.() ?? {} },
    isActive: runtime.isActive,
  });
  if (typeof settings.subscribeBiliCookie === 'function') {
    runtime.cookieUnsubscribe = settings.subscribeBiliCookie(() => {
      if (!runtime.isActive()) return;
      runtime.restartRequired = true;
      runtime.refresh();
    });
  }
  // The authority is state.runtime, but the engine host must belong to the
  // current module generation. Roost imports each reload from a new snapshot
  // and removes the previous snapshot; reusing an old host leaves its
  // PLUGIN_DIR pointing at deleted engine.tar.gz and service files. The host
  // still shares ctx.state.mediaParserEngine, so it can adopt the running
  // authenticated Python service without restarting it.
  state.engineHost = engineFactory({
    ctx,
    config: () => state.runtime?.settings.current() ?? readConfig(ctx),
  });
  runtime.engine = state.engineHost;
  const storage = state.storage ??= ctx.storage;
  runtime.queue = createTaskQueue({
    ctx: { storage }, repository: state.taskRepository ??= {},
    config: () => settings.current(), sanitize: settings.sanitize, onChange: () => runtime.refresh(),
  });
  runtime.ready = Promise.all([settings.ready, runtime.queue.ready]).then(() => runtime).catch((error) => {
    runtime.prepareError = settings.sanitize(error?.message || '插件配置读取失败');
    runtime.refresh();
    throw new Error(runtime.prepareError);
  });
  runtime.requireDm = () => {
    if (runtime.dmLoadError) throw dmFailure(runtime.dmLoadError);
    if (!runtime.dm) throw dmFailure('DM_MODULE_UNAVAILABLE');
    return runtime.dm;
  };
  runtime.safeDmStatus = () => buildDmStatus(runtime, settings);
  runtime.dmErrorText = (error) => dmErrorText(error);
  runtime.applyDmConfig = () => {
    try {
      if (runtime.dm && !runtime.dmFatal) runtime.dm.configChanged?.();
    } catch { /* configuration changes are reflected by the DM status */ }
  };
  runtime.verifyDmEnable = async () => {
    if (!runtime.biliLogin) return { ok: false, text: '登录模块暂时不可用，请稍后重试。' };
    let inspected;
    try { inspected = await runtime.biliLogin.inspect(); } catch {
      return { ok: false, text: '暂时无法确认 B 站登录，请稍后重试。' };
    }
    if (inspected?.state === 'missing') {
      return { ok: false, text: `尚未登录 B 站，请先使用 ${ctx.prefix || '/'}解析 私信 登录。` };
    }
    if (inspected?.state === 'invalid') {
      return { ok: false, text: 'B 站登录已失效，请重新登录。' };
    }
    if (inspected?.state !== 'valid') {
      return { ok: false, text: '暂时无法确认 B 站登录，请稍后重试。' };
    }
    if (!runtime.dmStore) return { ok: false, text: '私信模块尚未就绪，请稍后重试。' };
    let binding;
    try { binding = runtime.dmStore.binding(); } catch { return { ok: false, text: '私信绑定状态读取失败。' }; }
    if (!binding?.target) {
      return { ok: false, text: `尚未绑定接收私聊，请先使用 ${ctx.prefix || '/'}解析 私信 绑定。` };
    }
    return { ok: true };
  };
  runtime.dmSaveConfig = async (body) => {
    const source = body && typeof body === 'object' && body.config && typeof body.config === 'object'
      ? body.config : (body && typeof body === 'object' ? body : {});
    const patch = {};
    for (const key of DM_CONFIG_KEYS) {
      if (Object.prototype.hasOwnProperty.call(source, key)) patch[key] = source[key];
    }
    if (!Object.keys(patch).length) throw dmFailure('DM_CONFIG');
    if (patch.biliDmEnabled === true) {
      runtime.requireDm();
      const check = await runtime.verifyDmEnable();
      if (!runtime.isActive()) throw dmFailure('DM_STALE');
      if (!check.ok) {
        const error = new Error(check.text);
        error.code = 'DM_BINDING_REQUIRED';
        throw error;
      }
    }
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    const config = await settings.saveConfig(patch, { guard: () => runtime.isActive() });
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    runtime.applyDmConfig();
    return {
      ok: true,
      config: {
        biliDmEnabled: config.biliDmEnabled,
        biliDmPollSeconds: config.biliDmPollSeconds,
        biliDmIncludeSystem: config.biliDmIncludeSystem,
      },
    };
  };
  runtime.dmGroupOptions = async () => {
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    const result = await runtime.dmGroups.list();
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    return result;
  };
  runtime.dmSetTarget = async (body) => {
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    const source = body && typeof body === 'object' ? body : {};
    if (typeof source.sendToGroup !== 'boolean') throw dmFailure('DM_CONFIG');
    const sendToGroup = source.sendToGroup;
    let groupId = '';
    let group = null;
    if (sendToGroup) {
      if (typeof source.groupId !== 'string') throw dmFailure('DM_GROUP_INVALID');
      group = await runtime.dmGroups.resolve(source.groupId);
      if (!runtime.isActive()) throw dmFailure('DM_STALE');
      if (!group) throw dmFailure('DM_GROUP_INVALID');
      groupId = group.id;
    }
    let binding;
    try { binding = runtime.dmStore?.binding?.(); } catch { throw dmFailure('DM_STATE_CORRUPT'); }
    if (!binding?.target) throw dmFailure('DM_BINDING_REQUIRED');
    if (typeof ctx.isOwner !== 'function') throw dmFailure('DM_OWNER_REQUIRED');
    let owner = false;
    try { owner = await ctx.isOwner(binding.target) === true; } catch { owner = false; }
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    if (!owner) throw dmFailure('DM_OWNER_REQUIRED');
    if (!runtime.dmDelivery || typeof runtime.dmDelivery.configureTarget !== 'function') {
      throw dmFailure('DM_GROUP_UNAVAILABLE');
    }
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    const target = sendToGroup ? { kind: 'group', target: groupId } : { kind: 'c2c', target: '' };
    await runtime.dmDelivery.configureTarget(target, { guard: () => runtime.isActive() });
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    return { ok: true, selected: { sendToGroup, groupId } };
  };
  runtime.dmCheck = async () => {
    runtime.requireDm();
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    await runtime.dm.check();
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    return runtime.safeDmStatus();
  };
  runtime.dmSendTest = async (msg) => {
    runtime.requireDm();
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    let binding;
    try { binding = runtime.dmStore.binding(); } catch { throw dmFailure('DM_STATE_CORRUPT'); }
    if (!binding?.target) throw dmFailure('DM_BINDING_REQUIRED');
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    const result = await runtime.dmDelivery.sendTest(msg ?? undefined, { guard: () => runtime.isActive() });
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    return { ok: true, sent: Math.max(0, Number(result?.sent) || 0) };
  };
  runtime.dmLoginStatus = (includePng = false) => loginSafe(
    runtime.biliLogin?.status?.() ?? { state: 'unavailable' }, includePng,
  );
  runtime.dmLoginStart = async () => {
    if (!runtime.biliLogin) throw dmFailure('DM_MODULE_UNAVAILABLE');
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    const result = await runtime.biliLogin.start();
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    return loginSafe(result, true);
  };
  runtime.dmLoginCancel = async () => {
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    if (!runtime.biliLogin) return loginSafe({ state: 'unavailable' });
    return loginSafe(runtime.biliLogin.cancel());
  };
  runtime.dmLoginInspect = async () => {
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    if (!runtime.biliLogin) return loginSafe({ state: 'unavailable' });
    let result;
    try { result = await runtime.biliLogin.inspect(); } catch { return loginSafe({ state: 'error', errorCode: 'BILI_RESPONSE' }); }
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    return loginSafe(result);
  };
  runtime.dmLoginManual = async (body) => {
    if (!runtime.biliLogin) throw dmFailure('DM_MODULE_UNAVAILABLE');
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    const cookie = typeof body?.cookie === 'string' ? body.cookie.trim() : '';
    if (!cookie || cookie.length > 8192 || /[\0\r\n]/.test(cookie)) {
      const error = new Error('Cookie 格式不合法');
      error.code = 'BILI_AUTH';
      throw error;
    }
    const result = await runtime.biliLogin.manual(cookie);
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    return {
      ok: result?.ok === true,
      ...loginSafe(result),
    };
  };
  runtime.dmLoginLogout = async () => {
    if (!runtime.biliLogin) throw dmFailure('DM_MODULE_UNAVAILABLE');
    try { runtime.dm?.pause?.(); } catch { /* pause is retried by the config save */ }
    try { runtime.biliLogin.cancel?.(); } catch { /* logout clears the session */ }
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    if (settings.current().biliDmEnabled) {
      try {
        await settings.saveConfig({ biliDmEnabled: false }, { guard: () => runtime.isActive() });
      } catch (error) {
        throw dmFailure(dmErrorCode(error) === 'DM_STALE' ? 'DM_STALE' : 'DM_CONFIG');
      }
      if (!runtime.isActive()) throw dmFailure('DM_STALE');
    }
    runtime.applyDmConfig();
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    let bindingTarget = '';
    try { bindingTarget = String(runtime.dmStore?.binding?.()?.target || ''); } catch { bindingTarget = ''; }
    if (bindingTarget && typeof ctx.isOwner === 'function') {
      let owner = false;
      try { owner = await ctx.isOwner(bindingTarget) === true; } catch { owner = false; }
      if (!runtime.isActive()) throw dmFailure('DM_STALE');
      if (!owner) throw dmFailure('DM_OWNER_REQUIRED');
    }
    const result = await runtime.biliLogin.logout();
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    if (result?.ok !== true) {
      const code = String(result?.errorCode || 'BILI_COOKIE');
      const error = new Error('共享登录清除失败');
      error.code = code;
      throw error;
    }
    return {
      ok: true,
      state: SAFE_LOGIN_STATES.has(result?.state) ? result.state : 'idle',
      warning: '已清除本插件共享的 B 站登录，并暂停私信提醒；使用同一 Cookie 的增强解析也会受影响。不会注销 B 站其他设备。',
    };
  };
  const sendQrImage = async (msg, pngDataUrl) => {
    const prefix = 'data:image/png;base64,';
    if (typeof pngDataUrl !== 'string' || !pngDataUrl.startsWith(prefix)) return false;
    const buffer = Buffer.from(pngDataUrl.slice(prefix.length), 'base64');
    if (!buffer.length) return false;
    if (typeof msg?.replyImageBuffer === 'function') {
      await msg.replyImageBuffer(buffer);
      return true;
    }
    if (typeof msg?.replyImage === 'function') {
      await msg.replyImage(pngDataUrl);
      return true;
    }
    return false;
  };
  runtime.dmCommand = async (msg, args) => {
    const prefix = ctx.prefix || '/';
    const sub = String(Array.isArray(args) ? args[0] ?? '' : '').trim();
    const rest = Array.isArray(args) ? args.slice(1) : [];
    const help = () => [
      'B站私信提醒（仅机器人主人 QQ 私聊）',
      `${prefix}解析 私信 绑定｜登录｜状态｜开｜关｜检查｜测试｜待发｜领取｜查看 <编号> [页码]｜退出登录`,
      '首次启用会建立历史基线，不会批量转发旧未读；主动私聊受限时可使用「领取」。',
    ].join('\n');
    const reply = (text) => runtime.isActive() ? msg?.reply?.(text) : undefined;
    const stillOwner = async () => {
      if (!runtime.isActive()) return false;
      let owner = false;
      try { owner = await ctx.isOwner?.(String(msg.userId ?? '')) === true; } catch { owner = false; }
      return owner && runtime.isActive();
    };
    if (!runtime.isActive()) return undefined;
    if (msg?.kind !== 'c2c') {
      return reply('B站私信提醒操作请移到机器人主人 QQ 私聊中使用。');
    }
    const nativeUserId = String(msg.userId ?? '');
    const chatId = msg.chatId === undefined || msg.chatId === null ? nativeUserId : String(msg.chatId);
    if (!nativeUserId || chatId !== nativeUserId) {
      return reply('B站私信提醒只接受机器人主人的普通 QQ 私聊，当前会话不可用。');
    }
    if (typeof ctx.isOwner !== 'function') {
      return reply('当前宿主未提供主人校验，私信提醒命令已拒绝。');
    }
    let owner = false;
    try { owner = await ctx.isOwner(nativeUserId) === true; } catch { owner = false; }
    if (!runtime.isActive()) return undefined;
    if (!owner) return reply('仅机器人主人可在 QQ 私聊中使用私信提醒命令。');
    if (!sub || ['帮助', 'help', '用法'].includes(sub)) return reply(help());
    try {
      if (sub === '绑定') {
        runtime.requireDm();
        const result = await runtime.dmDelivery.bind(msg, { guard: () => runtime.isActive() });
        if (!runtime.isActive()) return undefined;
        return reply(`已绑定当前主人私聊作为接收目标（${result?.mask || '已脱敏'}）。下一步可发送 ${prefix}解析 私信 登录。`);
      }
      if (sub === '登录') {
        const status = await runtime.dmLoginStart();
        if (!runtime.isActive()) return undefined;
        if (!(await stillOwner())) return undefined;
        if (status.pngDataUrl && await sendQrImage(msg, status.pngDataUrl)) {
          if (!runtime.isActive()) return undefined;
          return reply('请使用 B 站手机客户端扫码并确认。二维码约 3 分钟后过期；也可在「解析管理」手动填写 Cookie。');
        }
        if (!runtime.isActive()) return undefined;
        if (['starting', 'waiting', 'scanned'].includes(status.state)) {
          return reply('登录二维码正在生成或等待扫码确认，请稍后发送 状态 查看。');
        }
        return reply(`登录未能开始：${status.errorSummary || dmText(status.errorCode || 'DM_ERROR')}`);
      }
      if (sub === '状态') {
        if (!(await stillOwner())) return undefined;
        return reply(dmStatusText(runtime.safeDmStatus(), prefix));
      }
      if (sub === '开') {
        runtime.requireDm();
        const check = await runtime.verifyDmEnable();
        if (!runtime.isActive()) return undefined;
        if (!check.ok) return reply(check.text);
        if (!(await stillOwner())) return undefined;
        await settings.saveConfig({ biliDmEnabled: true }, { guard: () => runtime.isActive() });
        if (!runtime.isActive()) return undefined;
        runtime.applyDmConfig();
        return reply('已启用 B 站私信提醒，正在初始化或恢复进度；基线完成前不会显示监听中，历史未读不会批量转发。');
      }
      if (sub === '关') {
        if (!(await stillOwner())) return undefined;
        await settings.saveConfig({ biliDmEnabled: false }, { guard: () => runtime.isActive() });
        if (!runtime.isActive()) return undefined;
        runtime.applyDmConfig();
        return reply('已暂停 B 站私信抓取和自动投递，账号、绑定和进度均已保留。');
      }
      if (sub === '检查') {
        const status = await runtime.dmCheck();
        if (!runtime.isActive()) return undefined;
        if (!(await stillOwner())) return undefined;
        return reply(dmStatusText(status, prefix));
      }
      if (sub === '测试') {
        const result = await runtime.dmSendTest(msg);
        if (!runtime.isActive()) return undefined;
        if (!(await stillOwner())) return undefined;
        return reply(result.sent > 0
          ? '已向绑定的主人私聊发送带明确标记的测试通知。'
          : '测试通知未确认送达，请查看私信状态并在需要时使用领取。');
      }
      if (sub === '待发') {
        if (!(await stillOwner())) return undefined;
        const status = runtime.safeDmStatus();
        return reply(`待发送：${status.queue.unfinished}；待核对：${status.queue.pending}；未知：${status.queue.unknown}。发送 ${prefix}解析 私信 领取 可主动领取。`);
      }
      if (sub === '领取') {
        runtime.requireDm();
        const result = await runtime.dmDelivery.claim(msg, { guard: () => runtime.isActive() });
        if (!runtime.isActive()) return undefined;
        if (result?.handled === true || Number(result?.sent) > 0) return undefined;
        if (!(await stillOwner())) return undefined;
        return reply(`暂无可领取内容或本次额度不足；稍后可再次发送 ${prefix}解析 私信 领取。`);
      }
      if (sub === '查看') {
        runtime.requireDm();
        const shortId = String(rest[0] || '').trim();
        if (!shortId) return reply(`用法：${prefix}解析 私信 查看 <编号> [页码]`);
        const pageNumber = Number(rest[1]);
        const page = Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : undefined;
        const result = await runtime.dmDelivery.view(msg, { shortId, page, guard: () => runtime.isActive() });
        if (!runtime.isActive()) return undefined;
        if (result?.handled === true) return undefined;
        if (!(await stillOwner())) return undefined;
        if (result?.ok === true && Number(result?.sent) > 0) {
          if (Number.isInteger(result.nextPage) && result.nextPage > 0 && Number(result.sent) < 4) {
            return reply(`如需继续查看，请发送 ${prefix}解析 私信 查看 ${shortId} ${result.nextPage}`);
          }
          return undefined;
        }
        return reply(result?.ok
          ? `没有可重复查看的内容；编号：${shortId}。`
          : '未找到保留期内的该编号，或它不属于当前账号。');
      }
      if (['退出登录', '退出', 'logout'].includes(sub)) {
        const result = await runtime.dmLoginLogout();
        if (!runtime.isActive()) return undefined;
        return reply(result.warning || '已清除本插件共享 B 站登录并暂停提醒。');
      }
      return reply(help());
    } catch (error) {
      if (!runtime.isActive()) return undefined;
      return reply(`私信操作失败：${dmErrorText(error)}`);
    }
  };
  let dmClient = null;
  if (typeof biliClientFactory === 'function') {
    try { dmClient = biliClientFactory(); } catch { runtime.dmLoadError = 'DM_MODULE_UNAVAILABLE'; }
  }
  if (dmClient && typeof biliLoginFactory === 'function') {
    try { runtime.biliLogin = biliLoginFactory({ settings, client: dmClient }); } catch { runtime.biliLogin = null; }
  }
  runtime.dmReady = (async () => {
    if (!dmClient) throw dmFailure('DM_MODULE_UNAVAILABLE');
    const modules = dmModules || await defaultDmModules();
    if (!runtime.isActive()) return runtime;
    const store = modules.createBiliDmStore({
      dataDir: ctx.dataDir,
      robotKey: botKey(ctx),
      initialBarrier: previousHandoff,
      isActive: () => runtime.isActive(),
    });
    const dmDelivery = modules.createBiliDmDelivery({ store, ctx });
    const service = modules.createBiliDmService({
      settings,
      client: dmClient,
      store,
      delivery: dmDelivery,
      isActive: () => runtime.isActive(),
      pollSeconds: settings.current().biliDmPollSeconds,
    });
    runtime.dmStore = store;
    runtime.dmDelivery = dmDelivery;
    runtime.dm = service;
    await store.ready;
    await service.ready;
    if (!runtime.isActive()) return runtime;
    if (settings.current().biliDmEnabled) service.start();
    return runtime;
  })();
  runtime.dmReady.then(() => {
    runtime.dmLoading = false;
    runtime.refresh();
  }).catch((error) => {
    runtime.dmLoading = false;
    if (!runtime.isActive()) return;
    const code = dmErrorCode(error);
    runtime.dmLoadError = code === 'DM_ERROR' ? 'DM_MODULE_UNAVAILABLE' : code;
    runtime.dmFatal = Boolean(runtime.dm);
    ctx.logger?.info?.(`私信提醒未就绪：${dmText(runtime.dmLoadError)}`);
    runtime.refresh();
  });
  runtime.dmReady.catch(() => {});
  runtime.ensure = async (repair = false) => {
    await runtime.ready;
    if (!runtime.isActive()) return;
    runtime.engineEnabled = true;
    if (runtime.preparePromise) return runtime.preparePromise;
    runtime.prepareError = '';
    runtime.preparePromise = Promise.resolve().then(() => runtime.engine.ensure({ repair })).then((out) => {
      if (out === false) throw new Error(engineStatus(runtime.engine).lastError || '引擎准备未成功，请查看依赖与进程状态');
      runtime.unavailableLogged = false; runtime.restartRequired = false; return out;
    }).catch((error) => {
      runtime.prepareError = settings.sanitize(error?.message || '引擎准备失败');
      ctx.logger?.warn?.(`引擎准备失败：${runtime.prepareError}`);
      throw error;
    }).finally(() => { runtime.preparePromise = null; runtime.refresh(); });
    return runtime.preparePromise;
  };
  runtime.startOperation = (action) => {
    if (['stop', 'restart'].includes(action) && settings.current().engineMode === 'external') {
      throw new Error('外部模式的进程不由本插件停止或重启，请在外部引擎处操作');
    }
    if (action === 'restart' && !runtime.queue.isIdle()) throw new Error('请等解析及发送任务空闲后再重启');
    const existing = [...runtime.operations.values()].find((task) => task.action === action && task.state === 'running');
    if (existing) return existing.id;
    const task = { id: randomUUID(), action, state: 'running', startedAt: Date.now() };
    runtime.operations.set(task.id, task);
    while (runtime.operations.size > 20) {
      const remove = [...runtime.operations.values()].find((item) => item.state !== 'running');
      if (!remove) break;
      runtime.operations.delete(remove.id);
    }
    if (action === 'stop') {
      runtime.engineEnabled = false;
      runtime.queue.cancelAll('管理员停止了引擎', { close: false });
    }
    Promise.resolve().then(async () => {
      await runtime.ready;
      if (!runtime.isActive()) throw new Error('插件已停用');
      if (['prepare', 'repair', 'start'].includes(action)) return runtime.ensure(action === 'repair');
      if (action === 'stop') return runtime.engine.stop();
      if (action === 'restart') {
        runtime.engineEnabled = true;
        const out = await runtime.engine.restart();
        if (out === false) throw new Error(engineStatus(runtime.engine).lastError || '引擎重启未成功');
        runtime.restartRequired = false; return out;
      }
      if (action === 'clean') return runtime.engine.clean();
    }).then((out) => {
      task.state = 'completed';
      if (out !== undefined) task.result = settings.sanitize(out);
    }).catch((error) => {
      task.state = 'failed'; task.error = settings.sanitize(error?.message || '维护失败');
    }).finally(() => {
      task.endedAt = Date.now(); runtime.refresh();
      storage?.set?.('media-parser:operations:v1', [...runtime.operations.values()].map((item) => settings.sanitize(item))).catch?.(() => {});
    });
    runtime.refresh();
    return task.id;
  };
  runtime.startPreview = (links) => {
    const cfg = settings.current();
    const promise = runtime.queue.enqueue({
      session: `${botKey(ctx)}:preview`, links, kind: 'preview',
      run: async ({ taskId, deadlineAt, signal, isActive }) => {
        const msg = { kind: 'preview', chatId: 'preview', userId: 'panel', userName: '管理预览' };
        const outcome = await runtime.engine.parse(parsePayload(ctx, msg, links, taskId, cfg), { deadlineAt, signal });
        if (!runtime.isActive() || !isActive()) throw new Error('预览任务已取消');
        runtime.previews.set(taskId, previewOutcome(outcome, settings.sanitize));
        while (runtime.previews.size > 20) runtime.previews.delete(runtime.previews.keys().next().value);
        return { preview: true, claimed: false };
      },
    });
    promise.catch(() => {});
    if (!promise.taskId) throw new Error('预览队列已满或已停止');
    return promise.taskId;
  };
  runtime.handle = async (msg, manual = false, text) => {
    try { await runtime.ready; } catch {
      if (manual && runtime.isActive()) await msg.reply('插件配置读取失败，请管理员查看解析管理页或数据目录中的配置文件。');
      return;
    }
    if (!runtime.isActive()) return;
    const cfg = settings.current();
    if (!await allowed(ctx, msg, cfg, manual)) return;
    const input = text === undefined ? msg : { ...msg, content: text };
    let links = extractLinks(input, cfg);
    if (!links.length) {
      if (manual) await msg.reply('没有发现已启用的受支持分享链接。可用 /解析 平台 查看平台。');
      return;
    }
    if (!runtime.engineReady()) {
      if (manual) await msg.reply(runtime.prepareError ? '解析引擎尚未就绪，请管理员查看「解析管理」中的准备错误并重试。' : '解析引擎准备中，请稍后重试。');
      else if (!runtime.unavailableLogged) {
        runtime.unavailableLogged = true;
        ctx.logger?.info?.('收到受支持链接，但引擎尚未就绪；本轮放行。');
      }
      return;
    }
    const session = sessionKey(ctx, msg);
    links = runtime.queue.filterFresh(session, links);
    if (!links.length) {
      if (manual) await msg.reply('这个会话中的链接正在处理或刚刚发送过，请稍后重试。');
      return;
    }
    const receivedAt = Number(msg.receivedAt) > 0 ? Number(msg.receivedAt) : Date.now();
    const deadlineAt = receivedAt + cfg.timeoutSeconds * 1000;
    try {
      const result = await runtime.queue.enqueue({
        session, links, receivedAt, deadlineAt, manual,
        run: async (task) => {
          const active = () => runtime.isActive() && runtime.engineEnabled && task.isActive();
          if (!active()) throw new Error('任务已取消');
          const payload = parsePayload(ctx, msg, links, task.taskId, cfg);
          // EngineHost owns its single unreachable-service recovery attempt.
          // Do not wrap that with a second retry or replay a delivered result.
          const outcome = await runtime.engine.parse(payload, { deadlineAt: task.deadlineAt, signal: task.signal });
          if (!active()) throw new Error('任务已取消');
          const delivered = await delivery(outcome, {
            ctx, msg, config: cfg, engine: runtime.engine,
            taskId: task.taskId, deadlineAt: task.deadlineAt,
            signal: task.signal, isActive: active,
          });
          // The delivery adapter claims at its first confirmed/pending send.
          // Never pre-claim a request whose whole delivery can still fail.
          return delivered;
        },
      });
      return result?.claimed ? true : undefined;
    } catch (error) {
      if (manual && runtime.isActive()) {
        const reason = error?.code === 'QUEUE_FULL' ? '解析队列已满，请稍后重试。'
          : ['QUEUE_WAIT_TIMEOUT', 'TASK_TIMEOUT'].includes(error?.code) ? '本次解析已超时，请稍后重新发送链接。'
            : error?.code === 'CANCELLED' ? '解析任务已取消。' : '本次解析失败，请稍后重试；管理员可查看管理页任务记录。';
        await msg.reply(reason);
      }
      if (runtime.isActive()) ctx.logger?.debug?.(`解析任务结束：${settings.sanitize(error?.code || error?.message || '失败')}`);
      return;
    } finally { runtime.refresh(); }
  };
  runtime.bootstrap = runtime.ready.then(async () => {
    runtime.boundaries = await detectHostBoundaries(ctx);
    if (runtime.isActive()) await runtime.ensure(false);
  }).catch(() => {}).finally(runtime.refresh);
  return runtime;
}

export function createPlugin({
  engineFactory = createEngineHost, delivery = deliver,
  dmModules = null, biliClientFactory = createBiliClient, biliLoginFactory = createBiliLogin,
} = {}) {
  return {
    id: 'media-parser',
    name: '流媒体聚合解析',
    version: '0.2.0',
    description: '自动解析分享链接，可选 B 站私信提醒；默认不调用模型',
    shortDesc: '31 个平台入口，可选 B 站私信提醒',
    frameworkVersion: '>=1.1.5',
    supportPlatforms: ['group', 'c2c'],
    priority: 40,
    config: CONFIG_SCHEMA,
    setup(ctx) {
      ctx.state ??= {};
      const runtime = makeRuntime(ctx, ctx.state, {
        engineFactory, delivery, dmModules, biliClientFactory, biliLoginFactory,
      });
      ctx.command('解析 [链接或操作]', { desc: '手动解析分享链接；状态、平台、私信与群开关', usage: `${ctx.prefix || '/'}解析 <链接> | 状态 | 平台 | 私信 | 开 | 关` }, async (msg) => {
        const args = Array.isArray(msg.args) ? msg.args : [];
        const action = String(args[0] ?? '').trim();
        if (!runtime.isActive() || isBotMessage(msg)) return;
        try { await runtime.ready; } catch {
          return msg.reply('插件配置读取失败，请管理员检查数据目录中的配置文件。');
        }
        if (action === '私信') return runtime.dmCommand(msg, args.slice(1));
        if (['guild', 'dm'].includes(msg.kind)) return msg.reply('当前发送适配未支持频道或频道私信。');
        if (action === '状态') {
          const status = runtime.publicStatus();
          return msg.reply(`解析引擎：${status.ready ? '就绪' : '准备中或未就绪'}\n支持平台：${status.platformCount}\n运行任务：${status.queue.running}，等待：${status.queue.waiting}\n详细状态与维护操作请查看管理面板「解析管理」。`);
        }
        if (action === '平台') return msg.reply(runtime.settings.platforms().map((platform) => `${platform.enabled ? '●' : '○'} ${platform.name}：${platform.mode}`).join('\n'));
        if (['开', '关'].includes(action)) {
          if (msg.kind !== 'group') return msg.reply('群级自动解析开关只能在普通群聊中使用。');
          const groupId = msg.groupId || msg.chatId;
          const can = typeof ctx.isGroupAdmin === 'function' ? await ctx.isGroupAdmin(groupId, msg.userId) : typeof ctx.can === 'function' && await ctx.can(msg, 'admin');
          if (!can) return msg.reply('需要当前群管理员权限。');
          // Current ctx exposes no setter for cfg.plugins.groups. Delegating to the
          // existing core command is the only supported way to use its authority.
          return msg.reply(`请使用宿主群插件开关：${ctx.prefix || '/'}群插件 ${action} media-parser\n或在面板的分群插件设置中操作。这会修改本群的同一个插件开关。`);
        }
        if (!action) return msg.reply(`用法：${ctx.prefix || '/'}解析 <分享链接>\n${ctx.prefix || '/'}解析 状态 / 平台\n群级启停请用 ${ctx.prefix || '/'}群插件 开|关 media-parser。`);
        return runtime.handle(msg, true, args.join(' '));
      });
      ctx.menu('自动解析', [
        { text: '直接发送受支持的分享链接', desc: '默认不要求 @，私聊也可用；最多三个不同链接' },
        { text: `${ctx.prefix || '/'}解析 状态`, desc: '查看公开状态' },
        { text: `${ctx.prefix || '/'}解析 平台`, desc: '查看平台输出模式' },
        { text: `${ctx.prefix || '/'}解析 私信`, desc: 'B站私信提醒：主人私聊中绑定、登录、启停、待发与领取' },
        { text: `${ctx.prefix || '/'}群插件 开|关 media-parser`, desc: '使用宿主的本群插件开关' },
      ]);
      ctx.on('message', (msg) => {
        runtime.dmGroups?.observe(msg);
        return runtime.handle(msg);
      });
      registerPanel(ctx, runtime);
      ctx.onTeardown?.(() => runtime.deactivate('插件已停用'));
      ctx.schedule?.('media-parser-dashboard', 5000, runtime.refresh);
      runtime.refresh();
      return undefined;
    },
    teardown(ctx) {
      ctx.state?.runtime?.deactivate('插件已停用');
    },
  };
}

export default createPlugin();
