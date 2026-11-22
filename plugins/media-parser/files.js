import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const HARD_FILE_BYTES = 200 * 1024 * 1024;

export class MediaFileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MediaFileError';
    this.code = code;
  }
}

export function assertActive({ signal, deadlineAt, isActive } = {}) {
  if (signal?.aborted || (typeof isActive === 'function' && !isActive())) {
    throw new MediaFileError('cancelled', '解析任务已取消');
  }
  if (Number.isFinite(deadlineAt) && Date.now() >= deadlineAt) {
    throw new MediaFileError('timeout', '解析任务已超过总时限');
  }
}

export function effectiveMaxBytes(config = {}) {
  const requested = Number(config.maxFileMiB);
  return Math.min(HARD_FILE_BYTES, requested > 0 ? Math.floor(requested * 1048576) : HARD_FILE_BYTES);
}

export function insideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function localReference(reference) {
  let value = String(reference ?? '').trim();
  if (!value || value.includes('\0') || /^(?:\\\\|\/\/)/.test(value)) {
    throw new MediaFileError('unsafe-path', '媒体路径不在允许的本地缓存中');
  }
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname || url.search || url.hash) throw new Error('非本地文件 URL');
      value = fileURLToPath(url);
    } catch {
      throw new MediaFileError('unsafe-path', '媒体 file URL 无效或指向网络共享');
    }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) {
    throw new MediaFileError('unsafe-path', '媒体引用不是受支持的本地路径');
  }
  if (/^(?:\\\\|\/\/)/.test(value)) throw new MediaFileError('unsafe-path', '不允许发送网络共享中的文件');
  return value;
}

/** Resolve both the root and the file; string prefix checks do not contain junctions. */
export async function validateLocalFile(reference, { cacheRoot, maxBytes = HARD_FILE_BYTES, ...active } = {}) {
  assertActive(active);
  if (!cacheRoot || /^(?:\\\\|\/\/)/.test(String(cacheRoot))) {
    throw new MediaFileError('cache-root', '尚未配置有效的本地媒体缓存根目录');
  }
  const source = localReference(reference);
  const declaredRoot = path.resolve(cacheRoot);
  const candidate = path.resolve(declaredRoot, source);
  if (!insideRoot(declaredRoot, candidate)) throw new MediaFileError('unsafe-path', '媒体路径超出本地缓存');
  try {
    const root = await fs.realpath(declaredRoot);
    const rootStat = await fs.stat(root);
    if (!rootStat.isDirectory()) throw new MediaFileError('cache-root', '媒体缓存根不是目录');
    const resolved = await fs.realpath(candidate);
    if (!insideRoot(root, resolved)) throw new MediaFileError('unsafe-path', '媒体真实路径超出本地缓存');
    const stat = await fs.lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new MediaFileError('not-file', '媒体来源不是普通文件');
    const actual = await fs.stat(resolved);
    if (!actual.isFile()) throw new MediaFileError('not-file', '媒体来源不是普通文件');
    if (actual.size > Math.min(HARD_FILE_BYTES, maxBytes)) {
      throw new MediaFileError('too-large', `媒体超过 ${(Math.min(HARD_FILE_BYTES, maxBytes) / 1048576).toFixed(0)} MiB 上限，已跳过`);
    }
    if (!actual.size) throw new MediaFileError('empty-file', '媒体文件为空');
    assertActive(active);
    return { path: resolved, root, size: actual.size, name: path.basename(resolved), owned: false };
  } catch (error) {
    if (error instanceof MediaFileError) throw error;
    throw new MediaFileError('unreadable', '媒体文件不存在或无法读取');
  }
}

function ipv4Parts(address) {
  return net.isIP(address) === 4 ? address.split('.').map(Number) : null;
}

/** Deliberately conservative: reserved/documentation/tunnel ranges are not download targets. */
export function isPublicAddress(raw) {
  let address = String(raw ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  if (address.includes('%')) return false;
  if (address.startsWith('::ffff:')) {
    const tail = address.slice(7);
    if (tail.includes('.')) address = tail;
    else {
      const words = tail.split(':');
      if (words.length !== 2 || words.some((word) => !/^[\da-f]{1,4}$/.test(word))) return false;
      const a = Number.parseInt(words[0], 16);
      const b = Number.parseInt(words[1], 16);
      address = `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
    }
  }
  const parts = ipv4Parts(address);
  if (parts) {
    const [a, b, c] = parts;
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || address === '168.63.129.16'
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (net.isIP(address) !== 6 || !/^[23][\da-f]{3}:/.test(address)) return false;
  const [first, second] = address.split(':').slice(0, 2).map((part) => Number.parseInt(part || '0', 16));
  return !(first === 0x2002 || first === 0x3fff || (first === 0x2001 && (second <= 0x1ff || second === 0xdb8)));
}

function networkURL(reference) {
  let url;
  try { url = new URL(reference); } catch { throw new MediaFileError('unsafe-url', '远端媒体地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || !url.hostname || /(?:^|\.)(?:localhost|local|internal|home|lan)$/i.test(url.hostname)) {
    throw new MediaFileError('unsafe-url', '远端媒体只允许无凭据的公共 HTTP(S) 地址');
  }
  return url;
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

async function pinnedAddress(url, lookup, signal) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literal = net.isIP(hostname);
  const addresses = literal ? [{ address: hostname, family: literal }]
    : await abortable(lookup(hostname, { all: true, verbatim: true }), signal);
  if (!Array.isArray(addresses) || !addresses.length || addresses.some((item) => !isPublicAddress(item.address))) {
    throw new MediaFileError('private-address', '远端媒体地址解析到非公共网络，已拒绝下载');
  }
  return addresses[0];
}

function openResponse(url, address, { signal, requestFn, headers }) {
  return new Promise((resolve, reject) => {
    const request = (requestFn ?? (url.protocol === 'https:' ? https.request : http.request))(url, {
      method: 'GET',
      agent: false,
      signal,
      headers,
      // The socket uses the address that was checked, rather than resolving the host again.
      lookup(_host, options, callback) {
        if (typeof options === 'function') callback = options;
        if (options?.all) callback(null, [{ address: address.address, family: Number(address.family) }]);
        else callback(null, address.address, Number(address.family));
      },
    }, resolve);
    request.once('error', reject);
    request.end();
  });
}

/** Only this directory receives plugin-created downloads and converted audio. */
export async function mediaWorkDir(dataDir) {
  if (!dataDir) throw new MediaFileError('data-dir', '插件数据目录不可用');
  const declared = path.resolve(dataDir);
  await fs.mkdir(declared, { recursive: true });
  const root = await fs.realpath(declared);
  const directory = path.join(root, 'delivery-cache');
  await fs.mkdir(directory, { recursive: true });
  const real = await fs.realpath(directory);
  if (!insideRoot(root, real)) throw new MediaFileError('unsafe-path', '插件媒体工作目录越界');
  return real;
}

/**
 * Bounded HTTP download. Cookies/Authorization are intentionally not forwarded:
 * authenticated platform downloads belong to the engine's per-platform sessions.
 * lookup/requestFn are injectable only to exercise DNS pinning without real network traffic.
 */
export async function downloadRemoteMedia(reference, {
  dataDir, maxBytes = HARD_FILE_BYTES, timeoutMs = 20_000, maxRedirects = 4,
  signal, deadlineAt, isActive, lookup = dns.lookup, requestFn,
} = {}) {
  const active = { signal, deadlineAt, isActive };
  assertActive(active);
  const controller = new AbortController();
  const cancel = () => controller.abort(new MediaFileError('cancelled', '媒体下载已取消'));
  signal?.addEventListener('abort', cancel, { once: true });
  const remaining = Number.isFinite(deadlineAt) ? deadlineAt - Date.now() : timeoutMs;
  const timer = setTimeout(() => controller.abort(new MediaFileError('timeout', '媒体下载超过总时限')),
    Math.max(1, Math.min(timeoutMs, remaining)));
  let temporary = '';
  let completed = '';
  try {
    const directory = await abortable(mediaWorkDir(dataDir), controller.signal);
    let url = networkURL(reference);
    for (let redirect = 0; redirect <= Math.min(8, Math.max(0, maxRedirects)); redirect += 1) {
      assertActive(active);
      const address = await pinnedAddress(url, lookup, controller.signal);
      const response = await openResponse(url, address, {
        signal: controller.signal, requestFn,
        headers: { Accept: '*/*', 'User-Agent': 'Roost-media-parser/0.1.0', 'Accept-Encoding': 'identity' },
      });
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.destroy();
        if (!response.headers.location || redirect >= maxRedirects) {
          throw new MediaFileError('redirect-limit', '远端媒体重定向次数过多');
        }
        url = networkURL(new URL(response.headers.location, url).href);
        continue;
      }
      if (response.statusCode !== 200) {
        response.destroy();
        throw new MediaFileError('http-error', `远端媒体下载失败（HTTP ${Number(response.statusCode) || 0}）`);
      }
      const limit = Math.min(HARD_FILE_BYTES, maxBytes);
      const declared = Number(response.headers['content-length']);
      if (Number.isFinite(declared) && declared > limit) {
        response.destroy();
        throw new MediaFileError('too-large', `远端媒体超过 ${(limit / 1048576).toFixed(0)} MiB 上限，已停止下载`);
      }
      const extension = path.extname(url.pathname).match(/^\.[a-z\d]{1,8}$/i)?.[0] ?? '.bin';
      const stem = `${createHash('sha256').update(String(reference)).digest('hex').slice(0, 20)}-${randomUUID()}`;
      temporary = path.join(directory, `${stem}.part`);
      completed = path.join(directory, `${stem}${extension}`);
      let size = 0;
      const limiter = new Transform({
        transform(chunk, _encoding, callback) {
          try {
            assertActive(active);
            size += chunk.length;
            if (size > limit) throw new MediaFileError('too-large', `远端媒体超过 ${(limit / 1048576).toFixed(0)} MiB 上限，已停止下载`);
            callback(null, chunk);
          } catch (error) { callback(error); }
        },
      });
      await pipeline(response, limiter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal: controller.signal });
      assertActive(active);
      if (controller.signal.aborted) throw controller.signal.reason;
      await fs.rename(temporary, completed);
      temporary = '';
      const file = await validateLocalFile(completed, { cacheRoot: directory, maxBytes: limit, ...active });
      completed = '';
      return { ...file, owned: true, sourceURL: String(reference) };
    }
    throw new MediaFileError('redirect-limit', '远端媒体重定向次数过多');
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof MediaFileError) throw error;
    throw new MediaFileError('download-failed', '远端媒体下载未完成');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    if (temporary) await fs.rm(temporary, { force: true }).catch(() => {});
    if (completed) await fs.rm(completed, { force: true }).catch(() => {});
  }
}

export async function resolveMediaFile(reference, { ctx, engine, config = {}, ...active } = {}) {
  const maxBytes = effectiveMaxBytes(config);
  if (/^https?:\/\//i.test(String(reference))) {
    return downloadRemoteMedia(reference, { dataDir: ctx?.dataDir, maxBytes, ...active });
  }
  return validateLocalFile(reference, { cacheRoot: engine?.cacheRoot, maxBytes, ...active });
}

export async function removeOwnedFile(file, dataDir) {
  if (!file?.owned || !file.path || !dataDir) return;
  try {
    const directory = await mediaWorkDir(dataDir);
    const real = await fs.realpath(file.path);
    if (insideRoot(directory, real)) await fs.unlink(real);
  } catch { /* an already removed task file needs no further work */ }
}
