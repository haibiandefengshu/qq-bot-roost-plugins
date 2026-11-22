import { createHash, randomUUID } from 'node:crypto';
import { createEngineHost } from './engine-host.js';
import { deliver } from './delivery.js';
import { createSettings, readConfig } from './settings.js';
import { extractLinks } from './links.js';
import { createTaskQueue } from './queue.js';
import { detectHostBoundaries, previewOutcome, registerPanel } from './panel.js';

export const VERSION = '0.1.0';

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
};

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

function makeRuntime(ctx, state, { engineFactory, delivery }) {
  const previous = state.runtime;
  previous?.deactivate?.('插件热重载，旧代次任务已取消');
  const generation = (Number(state.generation) || 0) + 1;
  state.generation = generation;
  const settings = createSettings(ctx);
  const runtime = {
    generation, settings, active: true, engineEnabled: true, restartRequired: false,
    previews: new Map(), operations: new Map(), boundaries: null,
    prepareError: '', unavailableLogged: false,
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
      if (!runtime.active) return;
      runtime.active = false;
      runtime.queue.cancelAll(reason);
      runtime.queue.flush().catch(() => {});
    },
  };
  state.runtime = runtime;
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

export function createPlugin({ engineFactory = createEngineHost, delivery = deliver } = {}) {
  return {
    id: 'media-parser',
    name: '流媒体聚合解析',
    version: '0.1.0',
    description: '自动解析分享链接，按顺序发送视频、图集、音频与正文',
    shortDesc: '31 个平台入口，默认解析不调用模型',
    frameworkVersion: '>=1.1.5',
    supportPlatforms: ['group', 'c2c'],
    priority: 40,
    config: CONFIG_SCHEMA,
    setup(ctx) {
      ctx.state ??= {};
      const runtime = makeRuntime(ctx, ctx.state, { engineFactory, delivery });
      ctx.command('解析 [链接或操作]', { desc: '手动解析分享链接；状态、平台及群开关', usage: `${ctx.prefix || '/'}解析 <链接> | 状态 | 平台 | 开 | 关` }, async (msg) => {
        const args = Array.isArray(msg.args) ? msg.args : [];
        const action = String(args[0] ?? '').trim();
        if (!runtime.isActive() || isBotMessage(msg)) return;
        try { await runtime.ready; } catch {
          return msg.reply('插件配置读取失败，请管理员检查数据目录中的配置文件。');
        }
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
        { text: `${ctx.prefix || '/'}群插件 开|关 media-parser`, desc: '使用宿主的本群插件开关' },
      ]);
      ctx.on('message', (msg) => runtime.handle(msg));
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
