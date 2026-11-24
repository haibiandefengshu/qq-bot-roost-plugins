import { resolveNovelPaths } from './local-transport.mjs';
import { createPublicRuntime } from './public-runtime.mjs';
import { createWorkerLeader } from './worker-leader.mjs';
import { NovelService } from './service.mjs';

const DEFAULT_RETRY_MS = 500;
const DEFAULT_WATCHDOG_MS = 1000;
const MAX_RETRY_MS = 30_000;

function publicMessage(error) {
  return String(error?.message || error || '未知错误')
    .replace(/[A-Za-z]:\\[^\s，；]+/g, '本地路径')
    .slice(0, 400);
}

function pathContext({ dataDir, extensionRoot, env }) {
  if (dataDir) return { dataDir };
  return resolveNovelPaths({ extensionRoot, env });
}

function attachDisposal(service, log) {
  if (!service || typeof service !== 'object') return service;
  service.dispose = async function dispose() {
    if (service.__novelDisposed) return;
    try {
      if (typeof service.shutdown === 'function') {
        await service.shutdown();
      } else {
        try { clearInterval(service.cleanupTimer); } catch {}
        service.cleanupTimer = null;
        const controllers = service.controllers;
        if (controllers && typeof controllers.values === 'function') {
          for (const controller of controllers.values()) {
            try { controller.abort(); } catch {}
          }
          controllers.clear?.();
        }
      }
    } catch (error) {
      log(`停止小说任务失败：${publicMessage(error)}`);
    }
    try {
      if (typeof service.runtime?.dispose === 'function') await service.runtime.dispose();
      else if (typeof service.runtime?.close === 'function') await service.runtime.close();
    } catch (error) {
      log(`关闭小说运行时应失败：${publicMessage(error)}`);
    } finally {
      service.__novelDisposed = true;
    }
  };
  return service;
}

/**
 * Compose the single elected worker with the public runtime and NovelService.
 *
 * The caller gets a lifecycle object. `start()` may be called repeatedly; the
 * worker keeps retrying after a failed service construction and a watchdog
 * makes sure a follower can still recover after a failed takeover attempt.
 */
export function createWorkerRuntime({
  dataDir = '',
  extensionRoot = '',
  env = process.env,
  config = {},
  log = () => {},
  retryMs = DEFAULT_RETRY_MS,
  watchdogMs = DEFAULT_WATCHDOG_MS,
  createLeader = createWorkerLeader,
  createService = null,
  publicRuntimeFactory = createPublicRuntime,
} = {}) {
  const say = typeof log === 'function' ? log : () => {};
  let closed = false;
  let startPromise = null;
  let retryTimer = null;
  let watchdogTimer = null;
  let retryAttempt = 0;
  let lastError = '';
  let leader = null;
  let paths = null;
  let root = '';
  let closePromise = null;

  async function buildService() {
    if (closed) throw new Error('小说 worker 正在关闭');
    let value;
    if (createService) {
      value = attachDisposal(await createService({ dataDir: root, paths }), say);
    } else {
      const runtime = await publicRuntimeFactory({
        dataDir: root,
        extensionRoot,
        env,
        config,
        log: say,
      });
      try {
        value = attachDisposal(new NovelService({ runtime, config, log: say }), say);
      } catch (error) {
        try { await runtime.dispose?.(); } catch {}
        throw error;
      }
    }
    if (closed) {
      try { await value?.dispose?.(); } catch {}
      throw new Error('小说 worker 正在关闭');
    }
    return value;
  }

  function ensureLeader() {
    if (leader) return leader;
    paths = pathContext({ dataDir, extensionRoot, env });
    root = paths.dataDir;
    leader = createLeader({
      dataDir: root,
      retryMs,
      log: say,
      createService: buildService,
      handler: async (request) => {
        const service = leader?.service;
        if (!service) throw new Error('小说 worker 尚未就绪');
        if (request?.signal?.aborted) {
          throw Object.assign(new Error('操作已取消'), { name: 'AbortError' });
        }
        const payload = request?.payload && typeof request.payload === 'object'
          ? request.payload
          : {};
        const invocation = request?.invocation;
        if (request?.action === 'qq') {
          if (request.scope !== 'qq' || invocation?.source !== 'qq') {
            throw new Error('QQ 请求身份无效');
          }
          const owner = service.store.key(invocation);
          const op = String(payload.op || '').trim();
          if (op === 'watch') {
            return await service.watch(owner, String(payload.taskId || ''), invocation);
          }
          if (op === 'deliver') return await service.deliver(owner, payload);
          if (op === 'outbox') {
            const task = payload.taskId ? service.store.task(String(payload.taskId)) : null;
            const tasks = task ? [task] : service.store.tasksFor(owner);
            return await service.outboxFor(owner, tasks, invocation);
          }
          if (payload.direct === true) return await service.handleDirect(payload, invocation);
          return await service.handleQq(payload, invocation);
        }
        if (request?.action === 'panel') {
          if (request.scope !== 'panel'
              || invocation?.source !== 'panel'
              || invocation.ownerVerified !== true) {
            throw new Error('面板请求身份无效');
          }
          return await service.handlePanel(payload, invocation);
        }
        throw new Error('未知小说动作');
      },
    });
    return leader;
  }

  function watchdogDelay() {
    const base = Math.max(200, Number(watchdogMs) || DEFAULT_WATCHDOG_MS);
    return Math.min(MAX_RETRY_MS, base);
  }

  function scheduleRetry() {
    if (closed || retryTimer) return;
    const delay = Math.min(MAX_RETRY_MS, Math.max(50, retryMs) * (2 ** Math.min(6, retryAttempt)));
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!closed) Promise.resolve().then(start).catch(() => {});
    }, delay);
    retryTimer.unref?.();
  }

  function startWatchdog() {
    if (watchdogTimer || closed) return;
    watchdogTimer = setInterval(() => {
      if (closed || startPromise) return;
      const current = ensureLeader();
      if (current.leader) return;
      Promise.resolve().then(start).catch(() => {});
    }, watchdogDelay());
    watchdogTimer.unref?.();
  }

  async function start() {
    if (closed) return false;
    if (startPromise) return await startPromise;
    startPromise = (async () => {
      try {
        const current = ensureLeader();
        const elected = await current.start();
        if (elected) {
          retryAttempt = 0;
          lastError = '';
        }
        return elected;
      } catch (error) {
        retryAttempt += 1;
        lastError = publicMessage(error);
        say(`小说 worker 启动失败：${lastError}`);
        scheduleRetry();
        return false;
      } finally {
        startPromise = null;
      }
    })();
    return await startPromise;
  }

  return Object.freeze({
    start: async () => {
      startWatchdog();
      return await start();
    },
    close: async () => {
      if (closePromise) return await closePromise;
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      if (watchdogTimer) clearInterval(watchdogTimer);
      watchdogTimer = null;
      const current = leader;
      const pending = startPromise;
      closePromise = (async () => {
        const signaled = current
          ? current.close().catch((error) => say(`关闭小说 worker 失败：${publicMessage(error)}`))
          : Promise.resolve();
        if (pending) await pending.catch(() => {});
        if (leader) {
          await leader.close().catch((error) => say(`关闭迟到的 worker 失败：${publicMessage(error)}`));
        }
        await signaled;
        leader = null;
      })();
      return await closePromise;
    },
    get leader() { return leader?.leader === true; },
    get service() { return leader?.service || null; },
    get discovery() { return leader?.discovery || null; },
    get dataDir() { return root || dataDir; },
    get lastError() { return lastError; },
    async health() {
      const current = ensureLeader();
      return { leader: current.leader === true, dataDir: root, lastError };
    },
  });
}
