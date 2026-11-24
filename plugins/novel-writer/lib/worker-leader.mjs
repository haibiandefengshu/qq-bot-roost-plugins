import {
  closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { connect, createServer as createNetServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';

import { createTransportServer, ensureDataDir } from './local-transport.mjs';

const DEFAULT_RETRY_MS = 500;
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_GATE_TIMEOUT_MS = 10_000;

function alive(pid) {
  const number = Number(pid);
  if (!Number.isInteger(number) || number <= 0) return false;
  try {
    process.kill(number, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readLock(file) {
  try {
    const stat = statSync(file);
    let value = null;
    try { value = JSON.parse(readFileSync(file, 'utf8')); } catch {}
    return { stat, value };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function removeIfSameNonce(file, nonce) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (value?.nonce !== nonce) return false;
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

function gateName(lockFile) {
  const digest = createHash('sha256').update(resolve(lockFile)).digest('hex').slice(0, 24);
  if (process.platform === 'win32') return `\\\\.\\pipe\\novel-writer-${digest}`;
  return join(resolve(lockFile, '..'), `.novel-worker-${digest}.sock`);
}

function tryConnect(path) {
  return new Promise((resolveConnect) => {
    const socket = connect(path);
    const done = (value) => {
      socket.destroy();
      resolveConnect(value);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function holdGate(path) {
  return new Promise((resolveHold, reject) => {
    const server = createNetServer();
    const fail = (error) => {
      server.close(() => {});
      reject(error);
    };
    server.once('error', fail);
    server.listen(path, () => {
      server.off('error', fail);
      resolveHold(async () => {
        await new Promise((resolveClose) => server.close(() => resolveClose()));
      });
    });
  });
}

/**
 * OS-backed mutex used only to serialize leadership acquisition/reclamation.
 * The pipe/socket is released by the OS when the process exits, so a crashed
 * contender cannot leave an unrecoverable gate behind.
 */
async function acquireGate(lockFile, timeoutMs = DEFAULT_GATE_TIMEOUT_MS) {
  const path = gateName(lockFile);
  const deadline = Date.now() + Math.max(100, Number(timeoutMs) || DEFAULT_GATE_TIMEOUT_MS);
  while (Date.now() < deadline) {
    try {
      return await holdGate(path);
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error;
      if (process.platform !== 'win32') {
        const live = await tryConnect(path);
        if (!live) {
          try { unlinkSync(path); } catch {}
          continue;
        }
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
  return null;
}

/**
 * Elect one leader for a fixed data directory.
 *
 * Only the elected instance calls `createService`. Followers keep retrying so
 * they can take over if the current leader exits. A live leader is never
 * recovered against by a follower. Stale lock reclamation is serialized by an
 * OS-backed gate and re-reads the lock before unlinking it.
 */
export function createWorkerLeader({
  dataDir,
  createService,
  handler,
  retryMs = DEFAULT_RETRY_MS,
  staleMs = DEFAULT_STALE_MS,
  gateTimeoutMs = DEFAULT_GATE_TIMEOUT_MS,
  log = () => {},
  now = Date.now,
  isAlive = alive,
  serverOptions = {},
} = {}) {
  if (!dataDir) throw new Error('worker leader 需要 dataDir');
  if (typeof createService !== 'function') throw new Error('worker leader 需要 createService');
  if (typeof handler !== 'function') throw new Error('worker leader 需要 handler');

  const root = ensureDataDir(dataDir);
  const lockFile = join(root, 'worker.lock');
  const nonce = randomBytes(18).toString('base64url');
  let closed = false;
  let elected = false;
  let service = null;
  let server = null;
  let discovery = null;
  let retryTimer = null;
  let exitHook = null;
  let inFlight = null;
  let closePromise = null;

  function releaseLock() {
    return removeIfSameNonce(lockFile, nonce);
  }

  function scheduleRetry() {
    if (closed || elected || retryTimer || inFlight) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      Promise.resolve().then(tryElect).catch((error) => log(`领导权重试失败：${error?.message || error}`));
    }, Math.max(10, Number(retryMs) || DEFAULT_RETRY_MS));
    retryTimer.unref?.();
  }

  async function acquireLockUnderGate() {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const current = readLock(lockFile);
      if (current) {
        const { stat, value } = current;
        const ownerPid = Number(value?.pid);
        if (Number.isInteger(ownerPid) && ownerPid > 0 && isAlive(ownerPid)) {
          return false;
        }
        const age = Math.max(0, now() - Number(stat.mtimeMs || 0));
        const malformedAndRecent = !value && age < staleMs;
        if (malformedAndRecent) return false;

        /**
         * Re-read after the liveness decision. Another process may have
         * reclaimed and replaced the lock while isAlive() was running.

         * Never unlink a path that is no longer byte-for-byte the lock we
         * judged stale.
         */
        const confirm = readLock(lockFile);
        if (!confirm) continue;
        const before = `${stat.mtimeMs}:${stat.size}:${value ? JSON.stringify(value) : ''}`;
        const after = `${confirm.stat.mtimeMs}:${confirm.stat.size}:${confirm.value ? JSON.stringify(confirm.value) : ''}`;
        if (before !== after) continue;
        try { unlinkSync(lockFile); } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        continue;
      }

      let fd;
      try {
        fd = openSync(lockFile, 'wx', 0o600);
      } catch (error) {
        if (error?.code === 'EEXIST') continue;
        throw error;
      }
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce, at: now() }), { encoding: 'utf8' });
      } finally {
        closeSync(fd);
      }
      return true;
    }
    return false;
  }

  async function tryLock() {
    const releaseGate = await acquireGate(lockFile, gateTimeoutMs);
    if (!releaseGate) return false;
    try {
      if (closed) return false;
      return await acquireLockUnderGate();
    } finally {
      await releaseGate();
    }
  }

  async function elect() {
    if (closed || elected) return false;
    if (!await tryLock()) return false;
    if (closed) {
      releaseLock();
      return false;
    }
    elected = true;
    exitHook = () => { try { releaseLock(); } catch {} };
    process.once('exit', exitHook);
    let created = null;
    let createdServer = null;
    try {
      created = await createService({ leader: api, dataDir: root });
      if (closed) {
        await disposeService(created);
        releaseLock();
        elected = false;
        if (exitHook) process.off('exit', exitHook);
        exitHook = null;
        return false;
      }
      createdServer = createTransportServer({
        dataDir: root,
        handler,
        log,
        now,
        pid: process.pid,
        ...serverOptions,
      });
      const createdDiscovery = await createdServer.listen();
      if (closed) {
        await createdServer.close({ timeoutMs: serverOptions.closeTimeoutMs });
        createdServer = null;
        await disposeService(created);
        releaseLock();
        elected = false;
        if (exitHook) process.off('exit', exitHook);
        exitHook = null;
        return false;
      }
      service = created;
      server = createdServer;
      discovery = createdDiscovery;
      log(`worker 已成为领导者：${discovery.host}:${discovery.port}`);
      return true;
    } catch (error) {
      if (createdServer) await createdServer.close({ timeoutMs: serverOptions.closeTimeoutMs }).catch(() => {});
      server = null;
      discovery = null;
      await disposeService(created);
      service = null;
      elected = false;
      releaseLock();
      if (exitHook) process.off('exit', exitHook);
      exitHook = null;
      throw error;
    }
  }

  async function tryElect() {
    if (closed) return false;
    if (inFlight) return await inFlight;
    let won = false;
    let failure = null;
    const run = (async () => {
      try {
        won = await elect();
      } catch (error) {
        failure = error;
      }
    })();
    inFlight = run;
    try {
      await run;
    } finally {
      inFlight = null;
    }
    if (failure) log(`领导权启动失败，稍后重试：${failure?.message || failure}`);
    if (!won && !closed) scheduleRetry();
    return won;
  }

  async function disposeService(value) {
    if (!value) return;
    try {
      if (typeof value.dispose === 'function') await value.dispose();
      else if (typeof value.close === 'function') await value.close();
      else if (typeof value.shutdown === 'function') await value.shutdown();
      else if (typeof value === 'function') await value();
    } catch (error) {
      log(`关闭小说服务失败：${error?.message || error}`);
    }
  }

  async function closeOnce() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    if (inFlight) await inFlight.catch(() => {});
    if (server) {
      await server.close({ timeoutMs: serverOptions.closeTimeoutMs })
        .catch((error) => log(`关闭本地服务失败：${error?.message || error}`));
    }
    server = null;
    discovery = null;
    await disposeService(service);
    service = null;
    if (elected) releaseLock();
    elected = false;
    if (exitHook) process.off('exit', exitHook);
    exitHook = null;
  }

  const api = Object.freeze({
    get leader() { return elected; },
    get dataDir() { return root; },
    get service() { return service; },
    get discovery() { return discovery; },
    start: tryElect,
    close: () => {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = closeOnce();
      return closePromise;
    },
  });

  return api;
}
