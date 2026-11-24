import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const DISCOVERY_FILE = 'bridge.json';
const HEADER = {
  scope: 'x-novel-scope',
  timestamp: 'x-novel-timestamp',
  nonce: 'x-novel-nonce',
  signature: 'x-novel-signature',
  responseTimestamp: 'x-novel-response-timestamp',
  responseSignature: 'x-novel-response-signature',
};
const SCOPES = new Set(['qq', 'panel']);

function text(value, max = 512) {
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

export function safeNovelOutputPath(dataDir, candidate) {
  const outputs = join(resolve(dataDir), 'outputs');
  const path = resolve(String(candidate ?? ''));
  if (!isPathInside(outputs, path)) throw new Error('小说成果路径不在认证输出目录内');
  const realOutputs = realPath(outputs);
  const realFile = realPath(path);
  if (!isPathInside(realOutputs, realFile)) throw new Error('小说成果路径通过链接逃逸出认证输出目录');
  const stat = statSync(realFile);
  if (!stat.isFile() || stat.size <= 0) throw new Error('小说成果文件无效');
  return realFile;
}

/**
 * Resolve the fixed extension data directory from a validated native dataDir
 * layout or an explicit administrator bridgeDir.
 *
 * dataDir must be <DSH root>/roost/data/bots/<bot>/plugins/novel-chat.
 * Message content is never consulted for bot identity.
 */
export function resolveBridgePaths({ dataDir = '', bridgeDir = '', env = process.env } = {}) {
  const explicit = text(bridgeDir || env.NOVEL_WRITER_BRIDGE_DIR, 4096);
  const native = resolve(String(dataDir || ''));
  const parts = native.split(sep);
  const valid = parts.length >= 7
    && parts.at(-1) === 'novel-chat'
    && parts.at(-2) === 'plugins'
    && parts.at(-4) === 'bots'
    && parts.at(-5) === 'data';
  let botId = '';
  let dshDataDir = '';
  if (valid) {
    botId = parts.at(-3);
    dshDataDir = parts.slice(0, parts.length - 6).join(sep);
  }
  if (explicit) {
    return Object.freeze({
      dataDir: resolve(explicit),
      botId: botId || '',
      dshDataDir: dshDataDir || '',
      source: 'config',
    });
  }
  if (!valid) throw new Error('原生小说插件数据目录布局无效，无法确定扩展数据目录');
  return Object.freeze({
    dataDir: join(dshDataDir, 'extension-data', 'novel-writer'),
    botId,
    dshDataDir,
    source: 'layout',
  });
}

/** Build QQ identity only from the kernel message and trusted bot id. */
export function deriveQqInvocation(msg, botId) {
  if (!msg || typeof msg !== 'object') throw new Error('没有真实 QQ 消息');
  const kind = text(msg.kind, 16);
  const chatId = text(msg.chatId, 256);
  const userId = text(msg.userId, 256);
  const messageId = text(msg.id, 512);
  const receivedAt = Number(msg.receivedAt);
  const bot = text(botId, 128);
  if (!['group', 'c2c'].includes(kind) || !chatId || !userId || !messageId || !bot) {
    throw new Error('真实 QQ 消息身份不完整');
  }
  if (!Number.isFinite(receivedAt) || receivedAt <= 0) throw new Error('真实 QQ 消息时间无效');
  return {
    source: 'qq',
    pluginId: 'novel-chat',
    botId: bot,
    kind,
    chatId,
    userId,
    messageId,
    receivedAt: Math.trunc(receivedAt),
    mentioned: msg.mentioned === true,
    eventId: text(msg.traceId, 512),
  };
}

function readDiscovery(dataDir) {
  const file = join(resolve(dataDir), DISCOVERY_FILE);
  let value;
  try { value = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new Error('小说本地服务尚未启动');
    throw new Error('小说本地服务发现文件损坏');
  }
  if (!value || value.version !== 1) throw new Error('小说本地服务发现文件版本不匹配');
  const host = text(value.host, 64);
  const port = Number(value.port);
  if (host !== '127.0.0.1') throw new Error('小说本地服务地址不是回环地址');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('小说本地服务端口无效');
  const keys = value.keys && typeof value.keys === 'object' ? value.keys : {};
  for (const scope of SCOPES) {
    if (typeof keys[scope] !== 'string' || keys[scope].length < 32) throw new Error('小说本地服务凭据无效');
  }
  return { host, port, keys };
}

function canonicalRequest(timestamp, nonce, bodyHash) {
  return `POST\n/rpc\n${timestamp}\n${nonce}\n${bodyHash}`;
}

function canonicalResponse(timestamp, nonce, status, bodyHash) {
  return `response\n${timestamp}\n${nonce}\n${status}\n${bodyHash}`;
}

function isConnectFailure(error) {
  return [error?.code, error?.cause?.code, error?.message, error?.cause?.message]
    .map((value) => String(value ?? ''))
    .some((value) => /ECONNREFUSED|ECONNRESET|ENOTFOUND|EADDRNOTAVAIL|EPIPE/i.test(value));
}

export async function callNovelTransport({
  dataDir,
  scope = 'qq',
  action,
  payload = null,
  invocation = undefined,
  timeoutMs = 30_000,
  retryOnConnect = false,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  if (!SCOPES.has(scope)) throw new Error('未知来源范围');
  if (!action) throw new Error('缺少动作名');

  async function attempt(refreshed) {
    const discovery = readDiscovery(dataDir);
    const key = discovery.keys[scope];
    const body = Buffer.from(JSON.stringify({
      action,
      payload: payload ?? null,
      ...(invocation === undefined ? {} : { invocation }),
    }), 'utf8');
    const nonce = randomBytes(18).toString('base64url');
    const timestamp = String(now());
    const signature = hmac(key, canonicalRequest(timestamp, nonce, sha256(body)));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('小说本地服务请求超时')), timeoutMs);
    let response;
    let responseBody;
    try {
      response = await fetchImpl(`http://${discovery.host}:${discovery.port}/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': body.length,
          [HEADER.scope]: scope,
          [HEADER.timestamp]: timestamp,
          [HEADER.nonce]: nonce,
          [HEADER.signature]: signature,
        },
        body,
        signal: controller.signal,
      });
      responseBody = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (!refreshed && retryOnConnect && isConnectFailure(error)) return await attempt(true);
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (!response.headers.has(HEADER.responseSignature) && response.status === 401) {
      throw new Error('小说本地服务鉴权失败');
    }
    const responseTimestamp = Number(response.headers.get(HEADER.responseTimestamp));
    const signatureValue = response.headers.get(HEADER.responseSignature) || '';
    if (!Number.isFinite(responseTimestamp)
        || Math.abs(now() - responseTimestamp) > 120_000
        || !safeEqual(
          hmac(key, canonicalResponse(String(responseTimestamp), nonce, response.status, sha256(responseBody))),
          signatureValue,
        )) {
      throw new Error('小说本地服务响应未通过校验');
    }
    let parsed;
    try { parsed = JSON.parse(responseBody.toString('utf8')); }
    catch { throw new Error('小说本地服务返回了无效 JSON'); }
    if (!parsed || parsed.ok !== true) {
      const error = new Error(text(parsed?.message, 400) || `本地小说服务返回 HTTP ${response.status}`);
      error.code = text(parsed?.code, 60);
      error.status = response.status;
      throw error;
    }
    return parsed.result ?? null;
  }

  return await attempt(false);
}

export function nativeBridgeSummary(ctx = {}) {
  const paths = resolveBridgePaths({
    dataDir: ctx.dataDir,
    bridgeDir: ctx.config?.bridgeDir,
  });
  return {
    botId: paths.botId,
    dataDir: paths.dataDir,
    discoveryFile: join(paths.dataDir, DISCOVERY_FILE),
    source: paths.source,
    basename: basename(dirname(join(paths.dataDir, DISCOVERY_FILE))),
  };
}
