/**
 * Native Roost plugin for the unified /小说 command.
 *
 * The model never receives the user's book identity. Every signed transport
 * request derives identity from the real Roost msg and the validated native
 * bot data directory; message content is never trusted for identity.
 */

import {
  callNovelTransport, deriveQqInvocation, resolveBridgePaths, safeNovelOutputPath,
} from './lib/local-rpc.js';

const TASK_POLL_MS = 1500;
const TASK_MAX_MS = 35 * 60 * 1000;

async function filePayload(msg) {
  const attachment = (msg.files || []).find((item) => /\.(?:txt|json)$/i.test(item.filename || item.url || ''));
  if (!attachment?.url) return {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(attachment.url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) throw new Error(`文件下载失败：HTTP ${response.status}`);
    const length = Number(response.headers.get('content-length') || 0);
    if (length > 5 * 1024 * 1024) throw new Error('导入文件超过 5 MB');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 5 * 1024 * 1024) throw new Error('导入文件超过 5 MB');
    return {
      fileBase64: bytes.toString('base64'),
      fileName: String(attachment.filename || 'import.txt').slice(0, 160),
    };
  } finally {
    clearTimeout(timer);
  }
}

function textOf(result) {
  if (!result || typeof result !== 'object') return '';
  return String(result.text || result.message || '');
}

function isPassiveUsable(receivedAt) {
  return Number(receivedAt) > 0 && Date.now() - Number(receivedAt) < 55 * 60 * 1000;
}

function classifyFileResult(sent, failure = '') {
  const status = String(sent?.state || sent?.status || '').toLowerCase();
  const incomplete = status === 'queued' || status === 'unknown';
  const dryRun = sent?.dryRun === true || status === 'dryrun' || status === 'dry-run';
  const pending = sent?.pending === true || status === 'pending' || status === 'sending';
  const hasResult = Boolean(sent) && typeof sent === 'object';
  const explicitFailure = Boolean(failure)
    || sent?.ok === false
    || sent?.sent === false
    || incomplete
    || dryRun
    || status === 'failed'
    || status === 'error';
  const success = hasResult
    && !failure
    && sent?.ok !== false
    && sent?.pending !== true
    && sent?.dryRun !== true
    && sent?.sent !== false
    && !pending
    && !incomplete
    && status !== 'failed'
    && status !== 'error';
  const state = success ? 'sent' : pending && !explicitFailure ? 'pending' : 'failed';
  let error = '';
  if (!success) {
    if (failure) error = failure;
    else if (!sent || typeof sent !== 'object') error = '文件发送未返回结果';
    else if (sent.ok === false) error = String(sent.error || sent.message || sent.reason || '发送返回 ok:false');
    else if (sent.sent === false) error = String(sent.error || sent.message || '发送返回 sent:false');
    else if (incomplete) error = `文件发送状态未完成：${status}`;
    else if (dryRun) error = '文件仅完成演练，未实际发送';
    else if (status === 'failed' || status === 'error') error = String(sent.error || sent.message || `文件发送状态：${status}`);
    else error = '发送未返回可确认的终态';
  }
  return { success, pending: state === 'pending', state, error };
}

function watchIds(result) {
  if (!result || typeof result !== 'object') return [];
  return [...new Set([
    ...(result.taskId ? [result.taskId] : []),
    ...(Array.isArray(result.watchTaskIds) ? result.watchTaskIds : []),
    ...(result.task?.id ? [result.task.id] : []),
  ].filter(Boolean))];
}

export function createNovelChatPlugin(overrides = {}) {
  const transport = {
    callNovelTransport,
    deriveQqInvocation,
    resolveBridgePaths,
    safeNovelOutputPath,
    ...overrides,
  };

  return {
    id: 'novel-chat',
    name: '小说对话',
    version: '1.1.1',
    description: '注册统一 /小说 命令，通过本机认证传输传递真实消息身份并接收小说扩展生成的 TXT 与 MP3',
    priority: 120,
    config: {
      enabled: { type: 'boolean', label: '启用 /小说', default: true },
      bridgeDir: {
        type: 'string',
        label: '小说扩展数据目录（管理员）',
        default: '',
        hint: '留空时从机器人 extensions 布局自动推导；仅在自定义部署时填写。',
      },
    },

    setup(ctx) {
      const handledMessages = new Set();
      const inFlight = new Map();
      const watchTimers = new Set();
      let stopped = false;
      let bridge = null;

      const bridgePaths = () => {
        if (!bridge) {
          bridge = transport.resolveBridgePaths({
            dataDir: ctx.dataDir,
            bridgeDir: ctx.config?.bridgeDir,
            env: process.env,
          });
        }
        return bridge;
      };

      const qqCall = async (msg, payload) => {
        const paths = bridgePaths();
        return await transport.callNovelTransport({
          dataDir: paths.dataDir,
          scope: 'qq',
          action: 'qq',
          payload,
          invocation: transport.deriveQqInvocation(msg, paths.botId),
          retryOnConnect: false,
        });
      };

      const schedule = (fn, delay) => {
        if (stopped) return null;
        const timer = setTimeout(() => {
          watchTimers.delete(timer);
          if (!stopped) return fn();
          return undefined;
        }, delay);
        timer.unref?.();
        watchTimers.add(timer);
        return timer;
      };

      const sendOutbox = async (msg, items) => {
        for (const item of items || []) {
          if (stopped) return;
          if (!item?.path || !item?.artifactId) continue;
          let failure = '';
          let sent = null;
          try {
            const safe = transport.safeNovelOutputPath(bridgePaths().dataDir, item.path);
            sent = await msg.replyFile(safe, {
              local: true,
              requestId: String(item.requestId || ''),
              allowActiveFallback: false,
              onError: (error) => { failure = String(error?.message || error); },
            });
          } catch (error) {
            failure = String(error?.message || error);
          }
          if (stopped) return;
          const outcome = classifyFileResult(sent, failure);
          const { success, pending, state } = outcome;
          if (item.taskId) {
            try {
              await qqCall(msg, {
                op: 'deliver',
                taskId: item.taskId,
                artifactId: item.artifactId,
                state,
                resultId: String(sent?.id || ''),
                error: outcome.error,
              });
            } catch {}
          }
          if (stopped) return;
          if (!success) {
            const hint = pending
              ? `QQ 正在处理这个文件；${item.taskId ? '可在稍后发送 /小说 领取。' : '请稍后重试 /小说 发送。'}`
              : `文件发送失败：${outcome.error}；${item.taskId ? '发送 /小说 领取 获取新的回复窗口。' : '请重新发送 /小说 发送。'}`;
            if (isPassiveUsable(msg.receivedAt)) await msg.replyNow(hint).catch(() => {});
          }
        }
      };

      const startWatch = (msg, taskId, seen = new Set()) => {
        if (stopped || !taskId || seen.has(taskId)) return;
        seen.add(taskId);
        const startedAt = Date.now();
        const poll = async () => {
          if (stopped || Date.now() - startedAt > TASK_MAX_MS) return;
          let result;
          try {
            result = await qqCall(msg, { op: 'watch', taskId });
          } catch {
            schedule(poll, 5000);
            return;
          }
          if (stopped) return;
          const task = result?.task;
          if (task && ['queued', 'running'].includes(task.status)) {
            schedule(poll, TASK_POLL_MS);
            return;
          }
          if (result?.text && isPassiveUsable(msg.receivedAt)) {
            await msg.replyNow(result.text).catch(() => {});
            if (stopped) return;
          }
          await sendOutbox(msg, result?.outbox || []);
          if (stopped) return;
          if (task && task.status !== 'cancelled') {
            for (const followUp of task.followUps || []) startWatch(msg, followUp, seen);
          }
          if (!task || !['done', 'error', 'cancelled', 'interrupted', 'conflict'].includes(task.status)) {
            schedule(poll, 5000);
          }
        };
        schedule(poll, 900);
      };

      const rememberHandled = (key) => {
        if (!key) return;
        handledMessages.add(key);
        if (handledMessages.size > 1000) handledMessages.delete(handledMessages.values().next().value);
      };
      const keyOf = (msg) => msg?.id ? `${msg.kind || 'message'}:${String(msg.id)}` : '';
      const once = async (msg, task) => {
        const key = keyOf(msg);
        if (!key) return { value: await task(), duplicate: false };
        if (handledMessages.has(key)) {
          msg.claim();
          return { duplicate: true };
        }
        const pending = inFlight.get(key);
        if (pending) {
          await pending.catch(() => {});
          if (handledMessages.has(key)) {
            msg.claim();
            return { duplicate: true };
          }
          return { duplicate: false, skipped: true };
        }
        const job = (async () => {
          const outcome = await task();
          if (outcome?.remember) rememberHandled(key);
          return outcome;
        })();
        inFlight.set(key, job);
        try { return { ...(await job), duplicate: false }; }
        finally {
          if (inFlight.get(key) === job) inFlight.delete(key);
        }
      };

      const replyResult = async (msg, result) => {
        if (stopped) return result?.handled === true;
        if (result?.ok === false) {
          await msg.reply(textOf(result) || '小说扩展调用失败。');
          return true;
        }
        const text = textOf(result);
        if (text) await msg.reply(text);
        if (stopped) return result?.handled === true;
        await sendOutbox(msg, result?.outbox || []);
        if (stopped) return result?.handled === true;
        for (const id of watchIds(result)) startWatch(msg, id);
        return result?.handled === true;
      };

      ctx.onTeardown?.(() => {
        stopped = true;
        for (const timer of watchTimers) clearTimeout(timer);
        watchTimers.clear();
      });

      ctx.command('小说 [内容...]', {
        desc: '小说创作、书库、TXT 与朗读',
        usage: '小说 [帮助|新建|书架|续写|朗读|任务…]',
      }, async (msg) => {
        if (!ctx.config?.enabled) return;
        const outcome = await once(msg, async () => {
          try {
            const extra = msg.args[0] === '导入' ? await filePayload(msg) : {};
            const result = await qqCall(msg, {
              command: '小说',
              args: msg.args,
              text: msg.content,
              ...extra,
            });
            if (stopped) return { value: true, remember: true };
            await replyResult(msg, result);
            msg.claim();
            return { value: true, remember: true };
          } catch (error) {
            if (!stopped) {
              await msg.reply(`小说功能暂时不可用：${String(error?.message || error).slice(0, 240)}`);
              msg.claim();
            }
            return { value: true, remember: true };
          }
        });
        return outcome.duplicate || outcome.value === true;
      });

      ctx.on('message', async (msg) => {
        if (!ctx.config?.enabled || msg.isCommand) return false;
        if (msg.kind !== 'c2c' && !(msg.kind === 'group' && msg.mentioned)) return false;
        const outcome = await once(msg, async () => {
          try {
            const extra = await filePayload(msg);
            const result = await qqCall(msg, {
              command: '小说',
              direct: true,
              text: msg.content,
              args: [],
              ...extra,
            });
            if (stopped) return { value: true, remember: true };
            if (result?.handled !== true) return { value: false, remember: false };
            await replyResult(msg, result);
            msg.claim();
            return { value: true, remember: true };
          } catch {
            return { value: false, remember: false };
          }
        });
        return outcome.duplicate || outcome.value === true;
      });

      ctx.menu('小说', [
        { cmd: '小说', desc: '打开小说总菜单、当前书籍和填写状态' },
        { cmd: '小说 帮助 创作', desc: '查看续写、重写和大纲用法' },
      ]);
    },
  };
}

export default createNovelChatPlugin();
