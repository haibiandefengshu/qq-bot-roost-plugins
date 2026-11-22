import { randomUUID } from 'node:crypto';
import { redact, redactUrl } from './settings.js';

export class QueueError extends Error {
  constructor(code, message) { super(message); this.name = 'QueueError'; this.code = code; }
}

const EMPTY_SENT = () => ({ text: 0, image: 0, video: 0, voice: 0, file: 0 });
const isTerminal = (state) => !['queued', 'running'].includes(state);

export function createTaskQueue({ ctx, config = () => ({}), onChange = () => {}, sanitize = redact, now = Date.now, historyLimit = 200, repository = {} } = {}) {
  const pending = [];
  const running = new Map();
  const sessions = new Set();
  const dedupe = repository.dedupe ??= new Map();
  const history = repository.history ??= [];
  let closed = false;
  let historyLoaded = false;
  const storeKey = 'media-parser:tasks:v1';
  const ready = repository.ready ??= Promise.resolve(ctx?.storage?.get?.(storeKey, [])).then((saved) => {
    if (Array.isArray(saved)) {
      const restored = saved.slice(-historyLimit).map((record) => ({
        ...record,
        ...(!isTerminal(record.state) ? { state: 'cancelled', reason: '进程重启前任务未完成', endedAt: now() } : {}),
      }));
      history.unshift(...restored);
      history.splice(0, Math.max(0, history.length - historyLimit));
    }
  }).catch(() => {});
  ready.then(() => { historyLoaded = true; });

  const snapshot = () => ({
    running: running.size, waiting: pending.length, closed,
    totals: history.reduce((out, record) => {
      if (isTerminal(record.state)) out[record.state] = (out[record.state] ?? 0) + 1;
      for (const type of Object.keys(out.sent)) out.sent[type] += Number(record.sent?.[type]) || 0;
      return out;
    }, { sent: EMPTY_SENT() }),
  });
  const changed = () => {
    onChange(snapshot());
    if (!historyLoaded) { ready.then(changed); return; }
    const saved = history.slice(-historyLimit).map((record) => sanitize(record));
    repository.persistTail = (repository.persistTail ?? Promise.resolve()).then(() => ctx?.storage?.set?.(storeKey, saved)).catch(() => {});
  };
  const finishRecord = (entry, state, reason, result) => {
    entry.record.state = state;
    entry.record.endedAt = now();
    if (reason) entry.record.reason = sanitize(String(reason).slice(0, 500));
    if (result && typeof result === 'object') {
      if (result.sent) entry.record.sent = { ...EMPTY_SENT(), ...result.sent };
      for (const key of ['pending', 'failed', 'skipped', 'claimed']) if (result[key] !== undefined) entry.record[key] = result[key];
      if (result.reasons) entry.record.reasons = sanitize(result.reasons).slice(0, 30);
    }
    changed();
  };
  const pruneDedupe = () => {
    const at = now();
    for (const [key, expiry] of dedupe) if (expiry <= at) dedupe.delete(key);
    while (dedupe.size > 2000) dedupe.delete(dedupe.keys().next().value);
  };
  const cancelWaiting = (entry, code, reason) => {
    const index = pending.indexOf(entry);
    if (index < 0) return;
    pending.splice(index, 1);
    clearTimeout(entry.waitTimer);
    entry.controller.abort(new QueueError(code, reason));
    finishRecord(entry, code === 'QUEUE_WAIT_TIMEOUT' ? 'expired' : 'cancelled', reason);
    entry.reject(new QueueError(code, reason));
  };
  const pump = () => {
    if (closed) return;
    const cfg = config();
    const concurrency = Math.max(1, Number(cfg.concurrency) || 2);
    while (running.size < concurrency) {
      const index = pending.findIndex((entry) => !sessions.has(entry.session));
      if (index < 0) break;
      const [entry] = pending.splice(index, 1);
      clearTimeout(entry.waitTimer);
      if (now() >= entry.deadlineAt || now() >= entry.waitDeadlineAt) {
        finishRecord(entry, 'expired', '排队等待超时');
        entry.reject(new QueueError('QUEUE_WAIT_TIMEOUT', '排队等待超时'));
        continue;
      }
      entry.record.state = 'running'; entry.record.startedAt = now();
      running.set(entry.id, entry); sessions.add(entry.session); changed();
      let timer;
      const abortPromise = new Promise((_, reject) => {
        const abort = () => reject(entry.controller.signal.reason ?? new QueueError('CANCELLED', '任务已取消'));
        entry.controller.signal.addEventListener('abort', abort, { once: true });
        entry.removeAbort = () => entry.controller.signal.removeEventListener('abort', abort);
        timer = setTimeout(() => entry.controller.abort(new QueueError('TASK_TIMEOUT', '解析和发送总预算已到期')), Math.max(1, entry.deadlineAt - now()));
        timer.unref?.();
      });
      const active = () => !closed && !entry.controller.signal.aborted && now() < entry.deadlineAt;
      const work = Promise.resolve().then(() => {
        if (!active()) throw new QueueError('CANCELLED', '任务已取消');
        return entry.run({ id: entry.id, taskId: entry.id, signal: entry.controller.signal, deadlineAt: entry.deadlineAt, isActive: active });
      });
      // The aborted work is still observed; its late return cannot settle or send.
      work.catch(() => {});
      Promise.race([work, abortPromise]).then((result) => {
        const state = result?.claimed || result?.preview ? 'completed' : result?.failed ? 'failed' : 'skipped';
        finishRecord(entry, state, '', result);
        if (result?.claimed) {
          const expiry = now() + Math.max(0, Number(config().dedupeSeconds ?? 120)) * 1000;
          for (const link of entry.links) dedupe.set(`${entry.session}\0${link.key ?? link.url}`, expiry);
        }
        entry.resolve(result);
      }, (error) => {
        const code = error?.code;
        finishRecord(entry, code === 'TASK_TIMEOUT' ? 'expired' : entry.controller.signal.aborted ? 'cancelled' : 'failed', error?.message || '任务失败');
        entry.reject(error);
      }).finally(() => {
        clearTimeout(timer); entry.removeAbort?.();
        // Abort returns promptly to the caller, but an upload or server cleanup
        // may still be unwinding. Keep both locks until the actual work settles.
        const release = () => {
          running.delete(entry.id); sessions.delete(entry.session); changed(); pump();
        };
        work.then(release, release);
      });
    }
  };
  const api = {
    ready,
    snapshot,
    isIdle: () => running.size === 0 && pending.length === 0,
    filterFresh(session, links) {
      pruneDedupe();
      const reserved = new Set([...pending, ...running.values()].filter((x) => x.session === session).flatMap((x) => x.links.map((link) => link.key ?? link.url)));
      return links.filter((link) => !reserved.has(link.key ?? link.url) && !dedupe.has(`${session}\0${link.key ?? link.url}`));
    },
    enqueue({ session, links = [], receivedAt = now(), deadlineAt, run, kind = 'parse', manual = false } = {}) {
      if (closed) return Promise.reject(new QueueError('CLOSED', '插件已停用'));
      if (!session || typeof run !== 'function') return Promise.reject(new QueueError('INVALID_TASK', '任务参数不合法'));
      const cfg = config();
      const at = now();
      const waitDeadlineAt = Math.min(
        receivedAt + Math.max(1, Number(cfg.queueWaitSeconds) || 30) * 1000,
        deadlineAt ?? receivedAt + Math.max(5, Number(cfg.timeoutSeconds) || 300) * 1000,
      );
      const effectiveDeadline = deadlineAt ?? receivedAt + Math.max(5, Number(cfg.timeoutSeconds) || 300) * 1000;
      if (at >= waitDeadlineAt) return Promise.reject(new QueueError('QUEUE_WAIT_TIMEOUT', '消息已超过排队等待时间'));
      const canStart = running.size < Math.max(1, Number(cfg.concurrency) || 2) && !sessions.has(session);
      if (!canStart && pending.length >= Math.max(0, Number(cfg.queueLimit) || 0)) return Promise.reject(new QueueError('QUEUE_FULL', '解析队列已满，请稍后重试'));
      const id = randomUUID();
      const record = {
        id, kind, manual: Boolean(manual), state: 'queued', createdAt: at,
        platforms: [...new Set(links.map((link) => link.platform).filter(Boolean))],
        links: links.map((link) => redactUrl(link.url)), sent: EMPTY_SENT(), pending: 0, failed: 0, skipped: 0,
      };
      history.push(record);
      // Keep running records even when a long queue creates many historical rows.
      while (history.length > historyLimit) {
        const remove = history.findIndex((item) => isTerminal(item.state));
        if (remove < 0) break;
        history.splice(remove, 1);
      }
      const promise = new Promise((resolve, reject) => {
        const entry = { id, record, session, links, run, resolve, reject, deadlineAt: effectiveDeadline, waitDeadlineAt, controller: new AbortController() };
        pending.push(entry);
        entry.waitTimer = setTimeout(() => cancelWaiting(entry, 'QUEUE_WAIT_TIMEOUT', '排队等待超时'), Math.max(1, waitDeadlineAt - at));
        entry.waitTimer.unref?.();
        changed(); pump();
      });
      promise.taskId = id;
      return promise;
    },
    list({ page = 1, pageSize = 20 } = {}) {
      const size = Math.max(1, Math.min(50, Math.floor(Number(pageSize) || 20)));
      const p = Math.max(1, Math.floor(Number(page) || 1));
      const rows = history.slice().reverse();
      return { page: p, pageSize: size, total: rows.length, pages: Math.max(1, Math.ceil(rows.length / size)), rows: sanitize(rows.slice((p - 1) * size, p * size)) };
    },
    get(id) { return sanitize(history.find((record) => record.id === id) ?? null); },
    cancelAll(reason = '插件已停用', { close = true } = {}) {
      if (close) closed = true;
      for (const entry of [...pending]) cancelWaiting(entry, 'CANCELLED', reason);
      for (const entry of running.values()) entry.controller.abort(new QueueError('CANCELLED', reason));
      changed();
    },
    async flush() { await ready; await repository.persistTail; await ctx?.storage?.flush?.(); },
  };
  return api;
}
