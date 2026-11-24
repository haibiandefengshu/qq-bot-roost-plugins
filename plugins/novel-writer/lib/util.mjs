import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, statSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

export const VERSION = 1;
export const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000;
export const DRAFT_PAUSE_MS = 10 * 60 * 1000;
export const DRAFT_EXPIRE_MS = 7 * 24 * 60 * 60 * 1000;
export const AUDIO_SEGMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const OUTPUT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export function clip(value, max = 500) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

export function multilineClip(value, max = 60_000) {
  return String(value ?? '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim().slice(0, max);
}

export function safeName(value, fallback = 'novel') {
  let out = String(value ?? '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();
  if (!out || out === '.' || out === '..') out = fallback;
  return Array.from(out).slice(0, 90).join('');
}

export function safeExt(name, allowed = ['.txt', '.mp3', '.json']) {
  const ext = extname(String(name ?? '')).toLowerCase();
  return allowed.includes(ext) ? ext : '';
}

export function hash(...parts) {
  return createHash('sha256').update(parts.map(String).join('\0')).digest('hex');
}

export function ownerKey(invocation) {
  return hash(
    invocation.botId,
    invocation.kind,
    invocation.chatId,
    invocation.userId,
  );
}

export function isInside(root, file) {
  const rel = relative(resolve(root), resolve(file));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`));
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw new Error(`运行文件损坏：${basename(file)}；原文件已保留`);
  }
}

export function atomicJson(file, value) {
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    });
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch {}
  }
}

export function atomicBytes(file, bytes) {
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch {}
  }
}

function reapLock(lock) {
  const gate = `${lock}.reaping`;
  try { mkdirSync(gate); }
  catch (error) {
    if (error?.code === 'EEXIST') {
      try { if (Date.now() - statSync(gate).mtimeMs > 180_000) rmdirSync(gate); } catch {}
    }
    return;
  }
  try {
    const before = statSync(lock);
    let dead = false;
    let invalid = false;
    try {
      const value = JSON.parse(readFileSync(lock, 'utf8'));
      if (!Number.isInteger(value?.pid) || value.pid <= 0 || typeof value?.nonce !== 'string') invalid = true;
      else {
        try { process.kill(value.pid, 0); } catch (error) { dead = error?.code === 'ESRCH'; }
      }
    } catch { invalid = true; }
    if (dead || (invalid && Date.now() - before.mtimeMs > 180_000)) {
      const after = statSync(lock);
      if (after.ino === before.ino && after.size === before.size && after.mtimeMs === before.mtimeMs) unlinkSync(lock);
    }
  } catch {}
  finally { try { rmdirSync(gate); } catch {} }
}

export async function withLock(root, name, signal, fn) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = join(root, `${safeName(name, 'lock')}.lock`);
  const nonce = randomUUID();
  while (true) {
    signal?.throwIfAborted?.();
    let fd;
    try { fd = openSync(lock, 'wx', 0o600); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      reapLock(lock);
      await pause(50, undefined, { signal });
      continue;
    }
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce, at: Date.now() })); }
    finally { closeSync(fd); }
    break;
  }
  try { return await fn(); }
  finally {
    try {
      const value = JSON.parse(readFileSync(lock, 'utf8'));
      if (value?.nonce === nonce) unlinkSync(lock);
    } catch {}
  }
}

export function stripCommandPrefix(text, prefix = '/') {
  const value = String(text ?? '').trim();
  return value.startsWith(prefix) ? value.slice(prefix.length).trim() : value;
}

export function shortId(prefix) {
  return `${prefix}-${randomUUID()}`;
}
