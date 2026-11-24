import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const DISCOVERY_FILE = 'bridge.json';
export const TRANSPORT_VERSION = 1;
export const SCOPES = Object.freeze(['qq', 'panel']);
export const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
export const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
export const DEFAULT_CLOCK_WINDOW_MS = 120_000;
export const DEFAULT_MAX_NONCES = 5000;

const HEADER_SCOPE = 'x-novel-scope';
const HEADER_TIMESTAMP = 'x-novel-timestamp';
const HEADER_NONCE = 'x-novel-nonce';
const HEADER_SIGNATURE = 'x-novel-signature';
const HEADER_RESPONSE_TIMESTAMP = 'x-novel-response-timestamp';
const HEADER_RESPONSE_SIGNATURE = 'x-novel-response-signature';
const NONCE_RE = /^[A-Za-z0-9_-]{16,160}$/;
const QQ_KINDS = new Set(['group', 'c2c']);

function text(value, max = 256) {
  return String(value ?? '').trim().slice(0, max);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key, value) {
  return createHmac('sha256', key).update(value).digest('hex');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Reject both `..` traversal and absolute `relative(root, path)` results.
 * On Windows a cross-drive path has an absolute relative form, which must not
 * be accepted as "inside".
 */
export function isPathInside(root, candidate) {
  const rel = relative(resolve(root), resolve(String(candidate ?? '')));
  if (!rel) return true;
  if (isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

function realPath(file) {
  try { return (realpathSync.native || realpathSync)(file); }
  catch (error) {
    if (error?.code === 'ENOENT') return resolve(file);
    throw error;
  }
}

export function safeOutputPath(dataDir, candidate) {
  const outputs = join(resolve(dataDir), 'outputs');
  const path = resolve(String(candidate ?? ''));
  if (!isPathInside(outputs, path)) throw new Error('成果路径不在小说输出目录内');
  const realOutputs = realPath(outputs);
  const realFile = realPath(path);
  if (!isPathInside(realOutputs, realFile)) throw new Error('成果路径通过链接逃逸出小说输出目录');
  let stat;
  try { stat = statSync(realFile); }
  catch { throw new Error('成果文件不存在'); }
  if (!stat.isFile() || stat.size <= 0) throw new Error('成果文件不是有效普通文件');
  return realFile;
}

export function ownerKeyForInvocation(invocation) {
  return createHash('sha256')
    .update([invocation.botId, invocation.kind, invocation.chatId, invocation.userId].map(String).join('\0'))
    .digest('hex');
}

/** Validate a QQ invocation and drop every field that is not trusted identity. */
export function validateQqInvocation(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.source !== 'qq') return null;
  const kind = text(raw.kind, 16);
  const botId = text(raw.botId, 128);
  const chatId = text(raw.chatId, 256);
  const userId = text(raw.userId, 256);
  const messageId = text(raw.messageId, 512);
  const receivedAt = Number(raw.receivedAt);
  if (!QQ_KINDS.has(kind) || !botId || !chatId || !userId || !messageId) return null;
  if (!Number.isFinite(receivedAt) || receivedAt <= 0) return null;
  return Object.freeze({
    source: 'qq',
    requestId: '',
    pluginId: 'novel-chat',
    botId,
    kind,
    chatId,
    userId,
    messageId,
    receivedAt: Math.trunc(receivedAt),
    mentioned: raw.mentioned === true,
    eventId: text(raw.eventId, 512),
  });
}

export function buildPanelInvocation({ requestId = 'panel' } = {}) {
  return Object.freeze({
    source: 'panel',
    ownerVerified: true,
    requestId: text(requestId, 128) || 'panel',
  });
}

export function resolveNovelPaths({ extensionRoot, env = process.env } = {}) {
  const explicitRoot = text(env.NOVEL_WRITER_DATA_DIR, 4096);
  const explicitDsh = text(env.NOVEL_WRITER_DSH_DATA_DIR || env.DSH_ROOST_DATA, 4096);
  let dshDataDir = explicitDsh ? resolve(explicitDsh) : '';
  let dataDir = explicitRoot ? resolve(explicitRoot) : '';
  const root = extensionRoot ? resolve(extensionRoot) : '';
  if (!dshDataDir && root
      && basename(root) === 'novel-writer'
      && basename(dirname(root)) === 'extensions') {
    dshDataDir = dirname(dirname(root));
  }
  if (!dataDir && dshDataDir) dataDir = join(dshDataDir, 'extension-data', 'novel-writer');
  if (!dataDir && root) dataDir = join(root, '.novel-data');
  if (!dataDir) throw new Error('无法确定小说数据目录');
  if (!dshDataDir) {
    const parent = dirname(dirname(dataDir));
    dshDataDir = basename(parent) === 'extension-data' ? dirname(parent) : parent;
  }
  return Object.freeze({
    dshDataDir,
    dataDir,
    outputsDir: join(dataDir, 'outputs'),
    discoveryFile: join(dataDir, DISCOVERY_FILE),
    workerLockFile: join(dataDir, 'worker.lock'),
    workerLogFile: join(dataDir, 'worker.log'),
  });
}

export function ensureDataDir(dataDir) {
  mkdirSync(resolve(dataDir), { recursive: true, mode: 0o700 });
  return resolve(dataDir);
}

export function createScopeKeys() {
  return Object.freeze({
    qq: randomBytes(32).toString('base64url'),
    panel: randomBytes(32).toString('base64url'),
  });
}

function atomicWriteJson(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch {}
  }
}

export function readDiscovery(dataDir) {
  const file = join(resolve(dataDir), DISCOVERY_FILE);
  let value;
  try { value = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new Error('小说本地服务尚未启动');
    throw new Error('小说本地服务发现文件损坏');
  }
  if (!value || value.version !== TRANSPORT_VERSION) throw new Error('小说本地服务发现文件版本不匹配');
  const host = text(value.host, 64);
  const port = Number(value.port);
  if (host !== '127.0.0.1') throw new Error('小说本地服务地址不是回环地址');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('小说本地服务端口无效');
  const keys = value.keys && typeof value.keys === 'object' ? value.keys : {};
  for (const scope of SCOPES) {
    if (typeof keys[scope] !== 'string' || keys[scope].length < 32) throw new Error('小说本地服务凭据无效');
  }
  return Object.freeze({
    version: TRANSPORT_VERSION,
    pid: Number(value.pid) || 0,
    host,
    port,
    startedAt: Number(value.startedAt) || 0,
    keys: Object.freeze({ qq: keys.qq, panel: keys.panel }),
  });
}

export function writeDiscovery(dataDir, discovery) {
  const file = join(resolve(dataDir), DISCOVERY_FILE);
  atomicWriteJson(file, { ...discovery, version: TRANSPORT_VERSION });
  return file;
}

export function removeDiscoveryIfOwned(dataDir, pid = process.pid) {
  const file = join(resolve(dataDir), DISCOVERY_FILE);
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (Number(value?.pid) !== Number(pid)) return false;
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

function requestCanonical(method, path, timestamp, nonce, bodyHash) {
  return `${String(method).toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
}

function responseCanonical(timestamp, requestNonce, status, bodyHash) {
  return `response\n${timestamp}\n${requestNonce}\n${status}\n${bodyHash}`;
}

export function signRequestHeaders({ key, method = 'POST', path = '/rpc', body, timestamp, nonce }) {
  const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
  const ts = String(timestamp ?? Date.now());
  const value = nonce || randomBytes(18).toString('base64url');
  const signature = hmac(key, requestCanonical(method, path, ts, value, sha256(bodyBuffer)));
  return {
    [HEADER_TIMESTAMP]: ts,
    [HEADER_NONCE]: value,
    [HEADER_SIGNATURE]: signature,
  };
}

export function signResponseHeaders({ key, requestNonce, status, body, timestamp }) {
  const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
  const ts = String(timestamp ?? Date.now());
  return {
    [HEADER_RESPONSE_TIMESTAMP]: ts,
    [HEADER_RESPONSE_SIGNATURE]: hmac(key, responseCanonical(ts, requestNonce, status, sha256(bodyBuffer))),
  };
}

export function verifyResponseSignature({ key, requestNonce, status, body, signature, timestamp, now = Date.now(), windowMs = DEFAULT_CLOCK_WINDOW_MS }) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > windowMs) return false;
  const expected = hmac(key, responseCanonical(String(timestamp), requestNonce, status, sha256(body)));
  return safeEqual(expected, signature);
}

function createNonceGuard({ now = Date.now, windowMs = DEFAULT_CLOCK_WINDOW_MS, max = DEFAULT_MAX_NONCES } = {}) {
  const seen = new Map();
  function prune(at) {
    for (const [key, expiresAt] of seen) if (expiresAt <= at) seen.delete(key);
  }
  return {
    reserve(scope, nonce, timestamp) {
      const at = now();
      const ts = Number(timestamp);
      if (!NONCE_RE.test(String(nonce ?? ''))) return false;
      if (!Number.isFinite(ts) || Math.abs(at - ts) > windowMs) return false;
      const key = `${scope}:${nonce}`;
      if (seen.has(key)) return false;
      if (seen.size >= max) prune(at);
      if (seen.size >= max) return false;
      seen.set(key, at + windowMs);
      return true;
    },
    size: () => seen.size,
  };
}

function readBody(req, limit) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const onData = (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        req.off('data', onData);
        req.resume();
        reject(Object.assign(new Error('请求体过大'), { status: 413, code: 'body_too_large' }));
        return;
      }
      chunks.push(chunk);
    };
    const fail = (error) => {
      if (done) return;
      done = true;
      reject(error);
    };
    req.on('data', onData);
    req.on('end', () => {
      if (done) return;
      done = true;
      resolveBody(Buffer.concat(chunks));
    });
    req.on('error', fail);
  });
}

function sendJson(res, status, value, headers = {}) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': body.length,
    ...headers,
  });
  res.end(body);
}

function publicMessage(error) {
  return String(error?.message || error || '本地小说服务调用失败').replace(/[A-Za-z]:\\[^\s，；]+/g, '本地路径').slice(0, 400);
}

const IDEMPOTENT_ACTIONS = new Set(['health']);

export function createTransportServer({
  dataDir,
  handler,
  keys = createScopeKeys(),
  host = '127.0.0.1',
  port = 0,
  pid = process.pid,
  now = Date.now,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  clockWindowMs = DEFAULT_CLOCK_WINDOW_MS,
  maxNonces = DEFAULT_MAX_NONCES,
  log = () => {},
} = {}) {
  if (typeof handler !== 'function') throw new Error('本地小说服务需要 handler');
  if (host !== '127.0.0.1') throw new Error('本地小说服务只能绑定 127.0.0.1');
  const root = ensureDataDir(dataDir);
  const nonceGuard = createNonceGuard({ now, windowMs: clockWindowMs, max: maxNonces });
  const startedAt = now();
  let server = null;
  let info = null;
  const pending = new Set();
  const allowed = {
    qq: new Set(['health', 'qq']),
    panel: new Set(['health', 'panel']),
  };

  async function handle(req, res) {
    let scope = '';
    let key = '';
    let nonce = '';
    let requestTimestamp = '';
    let responseStatus = 500;
    try {
      const url = new URL(req.url || '/', `http://${host}`);
      if (req.method !== 'POST' || url.pathname !== '/rpc' || url.search || url.hash) {
        return sendJson(res, 404, { ok: false, message: 'Not found' });
      }
      const remote = String(req.socket?.remoteAddress || '');
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
        return sendJson(res, 403, { ok: false, message: '只接受本机连接' });
      }
      scope = text(req.headers[HEADER_SCOPE], 16);
      requestTimestamp = text(req.headers[HEADER_TIMESTAMP], 20);
      nonce = text(req.headers[HEADER_NONCE], 160);
      const signature = text(req.headers[HEADER_SIGNATURE], 128);
      if (!SCOPES.includes(scope) || !keys[scope]) {
        return sendJson(res, 401, { ok: false, message: '未知来源范围' });
      }
      key = keys[scope];
      const bodyBuffer = await readBody(req, maxBodyBytes);
      const expected = hmac(key, requestCanonical('POST', '/rpc', requestTimestamp, nonce, sha256(bodyBuffer)));
      if (!signature || !safeEqual(expected, signature)) {
        return sendJson(res, 401, { ok: false, message: '请求签名无效' });
      }
      if (!nonceGuard.reserve(scope, nonce, requestTimestamp)) {
        return sendJson(res, 401, { ok: false, message: '请求已过期或重复' });
      }
      let body;
      try { body = JSON.parse(bodyBuffer.toString('utf8')); }
      catch { return sendJson(res, 400, { ok: false, message: '请求体不是 JSON' }); }
      const action = text(body?.action, 40);
      if (!allowed[scope].has(action)) {
        return sendJson(res, 403, { ok: false, message: '该来源范围不能执行这个动作' });
      }
      let invocation = null;
      if (action === 'qq') {
        invocation = validateQqInvocation(body?.invocation);
        if (!invocation) return sendJson(res, 400, { ok: false, message: 'QQ 消息身份无效' });
        invocation = Object.freeze({ ...invocation, requestId: `rpc-${nonce}` });
      } else if (action === 'panel') {
        invocation = buildPanelInvocation({ requestId: `panel-${nonce}` });
      }

      let businessResult;
      if (action === 'health') {
        businessResult = { pid, version: TRANSPORT_VERSION, startedAt, scope };
      } else {
        const controller = new AbortController();
        const entry = { controller };
        pending.add(entry);
        let timer;
        try {
          businessResult = await Promise.race([
            Promise.resolve().then(() => handler({
              action,
              scope,
              payload: body?.payload ?? {},
              invocation,
              signal: controller.signal,
            })),
            new Promise((_, reject) => {
              let timedOut = false;
              const onAbort = () => {
                if (timedOut) return;
                clearTimeout(timer);
                reject(Object.assign(new Error('本地小说服务请求已取消'), {
                  name: 'AbortError',
                  status: 499,
                  code: 'aborted',
                }));
              };
              controller.signal.addEventListener('abort', onAbort, { once: true });
              timer = setTimeout(() => {
                timedOut = true;
                const error = new Error(`本地小说服务超过 ${Math.round(requestTimeoutMs / 1000)} 秒未返回`);
                error.status = 504;
                error.code = 'timeout';
                controller.abort(error);
                reject(error);
              }, requestTimeoutMs);
            }),
          ]);
        } finally {
          clearTimeout(timer);
          pending.delete(entry);
        }
      }
      const responseBody = Buffer.from(JSON.stringify({ ok: true, result: businessResult ?? null }), 'utf8');
      const headers = signResponseHeaders({ key, requestNonce: nonce, status: 200, body: responseBody, timestamp: now() });
      return sendJson(res, 200, responseBody, headers);
    } catch (error) {
      responseStatus = Number(error?.status) || 500;
      const responseBody = Buffer.from(JSON.stringify({ ok: false, message: publicMessage(error), code: text(error?.code, 60) }), 'utf8');
      const headers = key
        ? signResponseHeaders({ key, requestNonce: nonce, status: responseStatus, body: responseBody, timestamp: now() })
        : {};
      log(`本地小说服务请求失败：${publicMessage(error)}`);
      return sendJson(res, responseStatus, responseBody, headers);
    }
  }

  return Object.freeze({
    async listen() {
      if (server) return info;
      server = createHttpServer((req, res) => {
        handle(req, res).catch((error) => {
          log(`本地小说服务未处理异常：${publicMessage(error)}`);
          if (!res.headersSent) sendJson(res, 500, { ok: false, message: publicMessage(error) });
        });
      });
      await new Promise((resolveListen, reject) => {
        const onError = (error) => { server.off('listening', onListening); reject(error); };
        const onListening = () => { server.off('error', onError); resolveListen(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
      const address = server.address();
      info = Object.freeze({
        version: TRANSPORT_VERSION,
        pid,
        host,
        port: Number(address.port),
        startedAt,
        keys: Object.freeze({ qq: keys.qq, panel: keys.panel }),
      });
      writeDiscovery(root, info);
      log(`本地小说服务已监听 ${host}:${info.port}`);
      return info;
    },
    abortPending(reason = '本地小说服务正在关闭') {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      error.name = 'AbortError';
      for (const entry of pending) entry.controller.abort(error);
    },
    async close({ timeoutMs = 2000 } = {}) {
      if (!server) {
        removeDiscoveryIfOwned(root, pid);
        return;
      }
      const closing = server;
      server = null;
      for (const entry of pending) entry.controller.abort(Object.assign(new Error('本地小说服务正在关闭'), { name: 'AbortError' }));
      await new Promise((resolveClose) => {
        let settled = false;
        let timer = null;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolveClose();
        };
        timer = setTimeout(() => {
          closing.closeAllConnections?.();
          finish();
        }, Math.max(50, Number(timeoutMs) || 2000));
        timer.unref?.();
        closing.close(finish);
        closing.closeAllConnections?.();
      });
      removeDiscoveryIfOwned(root, pid);
    },
    address: () => info,
    discoveryFile: join(root, DISCOVERY_FILE),
  });
}

function isConnectFailure(error) {
  const values = [
    error?.code,
    error?.cause?.code,
    error?.message,
    error?.cause?.message,
  ].map((value) => String(value ?? ''));
  return values.some((value) => /ECONNREFUSED|ECONNRESET|ENOTFOUND|EADDRNOTAVAIL|EPIPE/i.test(value));
}

function parseError(body, status) {
  const error = new Error(text(body?.message, 400) || `本地小说服务返回 HTTP ${status}`);
  error.code = text(body?.code, 60) || 'transport_failed';
  error.status = status;
  return error;
}

export async function callTransport({
  dataDir,
  scope,
  action,
  payload = null,
  invocation = undefined,
  timeoutMs = 30_000,
  retryOnConnect = IDEMPOTENT_ACTIONS.has(action),
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  if (!SCOPES.includes(scope)) throw new Error('未知来源范围');
  if (typeof action !== 'string' || !action) throw new Error('缺少动作名');
  if (typeof fetchImpl !== 'function') throw new Error('运行环境没有 fetch');

  async function attempt(refreshed) {
    const discovery = readDiscovery(dataDir);
    const key = discovery.keys[scope];
    if (!key) throw new Error('本地小说服务缺少该范围凭据');
    const body = Buffer.from(JSON.stringify({
      action,
      payload: payload ?? null,
      ...(invocation === undefined ? {} : { invocation }),
    }), 'utf8');
    const nonce = randomBytes(18).toString('base64url');
    const timestamp = String(now());
    const signature = hmac(key, requestCanonical('POST', '/rpc', timestamp, nonce, sha256(body)));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('本地小说服务请求超时')), timeoutMs);
    let response;
    let responseBody;
    try {
      response = await fetchImpl(`http://${discovery.host}:${discovery.port}/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': body.length,
          [HEADER_SCOPE]: scope,
          [HEADER_TIMESTAMP]: timestamp,
          [HEADER_NONCE]: nonce,
          [HEADER_SIGNATURE]: signature,
        },
        body,
        signal: controller.signal,
      });
      responseBody = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (!refreshed && retryOnConnect && isConnectFailure(error)) {
        return await attempt(true);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    const responseSigned = response.headers.has(HEADER_RESPONSE_SIGNATURE);
    if (!responseSigned) {
      if (response.status === 401) throw new Error('小说本地服务鉴权失败');
      if (response.status === 413) throw new Error('小说请求体过大');
    }
    const responseSignature = response.headers.get(HEADER_RESPONSE_SIGNATURE) || '';
    const responseTimestamp = response.headers.get(HEADER_RESPONSE_TIMESTAMP) || '';
    if (!verifyResponseSignature({
      key,
      requestNonce: nonce,
      status: response.status,
      body: responseBody,
      signature: responseSignature,
      timestamp: responseTimestamp,
      now: now(),
    })) {
      if (!refreshed && IDEMPOTENT_ACTIONS.has(action)) {
        return await attempt(true);
      }
      throw new Error('本地小说服务响应未通过校验');
    }
    let parsed;
    try { parsed = JSON.parse(responseBody.toString('utf8')); }
    catch { throw new Error('本地小说服务返回了无效 JSON'); }
    if (!parsed || parsed.ok !== true) throw parseError(parsed, response.status);
    return parsed.result ?? null;
  }

  return await attempt(false);
}

export async function healthCheck({ dataDir, scope = 'panel', timeoutMs = 2000 } = {}) {
  try {
    return await callTransport({ dataDir, scope, action: 'health', timeoutMs, retryOnConnect: false });
  } catch {
    return null;
  }
}
