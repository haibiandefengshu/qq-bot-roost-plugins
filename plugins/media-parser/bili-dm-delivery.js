import { createHash } from 'node:crypto';
import {
  BiliDmStoreError, MAX_NOTIFICATIONS, makeRequestId, makeSegmentKey,
} from './bili-dm-store.js';
import { shortMessageId } from './bili-dm-content.js';

export const DM_TEXT_LIMIT = 1500;
export const PASSIVE_C2C_BUDGET = 4;
export const PASSIVE_C2C_WINDOW_MS = 60 * 60 * 1000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_CALLS = 2;
const MAX_MESSAGES_PER_PUMP = 20;
const MAX_NOTICES_PER_PUMP = 2;
const FAILED_BACKOFF_MS = 60_000;
const VIEW_PAGE_SIZE = 3;
const MAX_VIEW_CACHE = 200;
const SHORT_ID_RE = /^[0-9A-F]{12,64}$/;
const SEGMENT_BLOCK_STATES = new Set(['sending', 'pending', 'unknown']);
const SAFE_STATUS_CODES = new Set([
  'DM_STATE_CORRUPT', 'DM_STATE_UNSUPPORTED', 'DM_STATE_READ_FAILED', 'DM_STATE_NOT_READY',
  'DM_WRITE_FAILED', 'DM_CAPACITY', 'DM_STALE', 'DM_ACCOUNT_INVALID', 'DM_BINDING_REQUIRED',
  'DM_OWNER_REQUIRED', 'DM_RATE_LIMIT', 'DM_AUTH', 'DM_NETWORK', 'DM_MODULE_UNAVAILABLE',
  'DM_CONFIG', 'DM_MESSAGE_ID_INVALID', 'DM_BINDING_INVALID', 'DM_GROUP_INVALID',
  'DM_GROUP_UNAVAILABLE', 'DM_TIMEOUT', 'DM_HTTP', 'DM_RESPONSE', 'DM_API', 'DM_CANCELLED',
  'DM_BUDGET', 'DM_GAP', 'DM_AMBIGUOUS_CURSOR', 'DM_NO_SERVER_TIME', 'DM_CREDENTIAL_CHANGED',
  'DM_NO_COOKIE', 'DM_NO_OWNER', 'DM_DISABLED', 'DM_PAUSED', 'DM_LOGOUT', 'DM_RECOVERED',
  'DM_CONTENT_INVALID', 'DM_BASELINE', 'DM_CATCHUP', 'DM_ERROR',
]);
const NOTICE_TEXT = new Map([
  ['DM_NETWORK', '暂时无法连接 B 站，稍后会自动重试。'],
  ['DM_AUTH', 'B 站登录状态已失效，请重新登录。'],
  ['DM_NO_COOKIE', '尚未配置 B 站登录信息。'],
  ['DM_NO_OWNER', '尚未绑定接收通知的主人。'],
  ['DM_OWNER_REQUIRED', '当前账号不是机器人主人，已暂停通知。'],
  ['DM_BINDING_REQUIRED', '尚未绑定接收通知的目标。'],
  ['DM_RATE_LIMIT', '发送频率已达上限，稍后会自动重试。'],
  ['DM_CAPACITY', '待处理私信数量已达上限，已暂停继续拉取。'],
  ['DM_STATE_CORRUPT', '本地私信状态异常，需要检查状态文件。'],
  ['DM_STATE_UNSUPPORTED', '本地私信状态版本过高，需要更新插件。'],
  ['DM_STATE_READ_FAILED', '本地私信状态读取失败，需要检查文件权限。'],
  ['DM_WRITE_FAILED', '本地私信状态写入失败，需要检查磁盘空间。'],
  ['DM_RECOVERED', '私信读取已恢复。'],
]);

const passiveUsed = new WeakMap();

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stableHash(parts) {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 40);
}

function safeStatusCode(value) {
  const code = String(value ?? '');
  return SAFE_STATUS_CODES.has(code) ? code : 'DM_STATE_CORRUPT';
}

function storedErrorCode(state, returned) {
  if (state === 'sent') return '';
  if (returned?.dry === true) return 'dry';
  if (state === 'pending') return 'pending';
  if (state === 'unknown') return 'unknown';
  if (state === 'failed') return 'failed';
  return 'unknown';
}

function conversationOf(message) {
  if (!message) return '';
  if (typeof message.conversationKey === 'string' && message.conversationKey) {
    return message.conversationKey;
  }
  return `${message.sessionType}:${message.talkerId}`;
}

function seq(value) {
  return typeof value === 'string' && /^\d+$/.test(value) ? value : '0';
}

function compare(left, right) {
  const a = BigInt(seq(left));
  const b = BigInt(seq(right));
  return a === b ? 0 : a > b ? 1 : -1;
}

function segmentKind(segment) {
  return segment?.targetKind === 'group' ? 'group' : 'c2c';
}

function bindingDestination(binding) {
  const ownerTarget = String(binding?.target || '');
  const kind = binding?.notifyKind === 'group' ? 'group' : 'c2c';
  const target = kind === 'group' ? String(binding?.groupTarget || '') : ownerTarget;
  return {
    ownerTarget,
    kind,
    target,
    version: Number(binding?.version) || 0,
  };
}

function sameDestination(left, right) {
  return Boolean(left && right)
    && left.ownerTarget === right.ownerTarget
    && left.kind === right.kind
    && left.target === right.target
    && Number(left.version) === Number(right.version);
}

function safeGroupId(value) {
  const text = String(value ?? '');
  if (!text || text.length > 512 || /[\u0000-\u001f]/.test(text)) return '';
  return text;
}

function safeGroupName(value) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.slice(0, 128);
}

function gateAllows(value) {
  if (value === undefined || value === null) return true;
  if (value === false) return false;
  if (typeof value === 'string') {
    const text = value.toLowerCase();
    if (['no', 'false', 'blocked', 'denied', 'forbidden', 'disabled'].includes(text)) return false;
    return true;
  }
  if (isObject(value)) {
    if (value.ok === false || value.allowed === false || value.enabled === false) return false;
  }
  return true;
}

function noticeBody(code) {
  const text = NOTICE_TEXT.get(code) || '私信状态已更新，请稍后在插件面板查看。';
  return `【B站私信·状态】\n${text}`;
}

function fallbackChunks(text, limit) {
  const chunks = [];
  let rest = text;
  while (rest.length > limit) {
    let end = limit;
    const last = rest.charCodeAt(end - 1);
    const next = rest.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
    if (end <= 0) end = limit;
    chunks.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function graphemesOf(text) {
  if (typeof Intl?.Segmenter !== 'function') return null;
  try {
    const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });
    return [...segmenter.segment(text)].map((item) => item.segment);
  } catch {
    return null;
  }
}

export function splitOriginalText(text, size) {
  const value = String(text ?? '');
  const limit = Math.max(1, Math.floor(Number(size) || DM_TEXT_LIMIT));
  if (!value) return [''];
  const graphemes = graphemesOf(value);
  if (!graphemes) return fallbackChunks(value, limit);
  const chunks = [];
  let current = '';
  for (const grapheme of graphemes) {
    if (grapheme.length > limit) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(...fallbackChunks(grapheme, limit));
      continue;
    }
    if (current && current.length + grapheme.length > limit) {
      chunks.push(current);
      current = '';
    }
    current += grapheme;
  }
  if (current) chunks.push(current);
  if (!chunks.length) chunks.push('');
  return chunks;
}

export function formatShanghai(timestampSeconds) {
  const seconds = Number(timestampSeconds);
  const value = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Number(timestampSeconds) || 0;
  const date = new Date(value + 8 * 60 * 60 * 1000);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} `
    + `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function senderLine(record) {
  const uid = String(record.senderUid || '');
  const name = String(record.senderName || '');
  if (name) return `来自：${name}（UID：${uid || '未知'}）`;
  return `来自：UID：${uid || '未知'}`;
}

export function buildSegmentBodies(record, {
  limit = DM_TEXT_LIMIT, label = '【B站私信】',
} = {}) {
  const header = `${label}\n${senderLine(record)}\n时间：${formatShanghai(record.sentAt)}\n`
    + `编号：DM-${shortMessageId(record.key || record.messageId || record.msgKey || record.seqno)}\n\n`;
  const text = String(record.text ?? '');
  const markerRoom = 16;
  const bodyLimit = Math.max(1, Math.floor(limit) - header.length - markerRoom);
  let chunks = splitOriginalText(text, bodyLimit);
  if (chunks.length > 1) {
    const markerMax = `[${chunks.length}/${chunks.length}]\n`.length;
    chunks = splitOriginalText(text, Math.max(1, Math.floor(limit) - header.length - markerMax));
  }
  return chunks.map((chunk, index) => {
    const marker = chunks.length > 1 ? `[${index + 1}/${chunks.length}]\n` : '';
    return `${header}${marker}${chunk}`;
  });
}

function messageSegments(account, messageKey) {
  return Object.values(account.segments || {})
    .filter((segment) => segment.messageKey === messageKey)
    .sort((left, right) => left.index - right.index);
}

function createSegments(draft, account, message, binding, now) {
  const kind = binding.targetKind === 'group' ? 'group' : 'c2c';
  const existing = messageSegments(account, message.key)
    .filter((segment) => segment.state !== 'superseded');
  if (existing.some((segment) => segment.target === binding.target
    && segment.bindingVersion === binding.version && segmentKind(segment) === kind)) {
    return existing.filter((segment) => segment.target === binding.target
      && segment.bindingVersion === binding.version && segmentKind(segment) === kind);
  }
  const bodies = buildSegmentBodies(message, { label: message.label || '【B站私信】' });
  const created = [];
  for (let index = 0; index < bodies.length; index += 1) {
    const key = makeSegmentKey({
      messageKey: message.key,
      bindingVersion: binding.version,
      target: binding.target,
      index,
      targetKind: kind,
    });
    if (account.segments[key]) {
      created.push(account.segments[key]);
      continue;
    }
    const requestId = makeRequestId({
      robotKey: draft.robotKey,
      accountUid: account.uid,
      target: binding.target,
      bindingVersion: binding.version,
      messageKey: message.key,
      index,
      targetKind: kind,
    });
    const segment = {
      key,
      messageKey: message.key,
      accountUid: account.uid,
      target: binding.target,
      targetKind: kind,
      bindingVersion: binding.version,
      index,
      total: bodies.length,
      body: bodies[index],
      requestId,
      state: 'planned',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      nextRetryAt: 0,
      lastErrorCode: '',
      sentAt: null,
      supersededBy: '',
    };
    account.segments[key] = segment;
    created.push(segment);
  }
  return created;
}

function recomputeMessage(draft, account, messageKey, now) {
  const message = account.messages[messageKey];
  if (!message || message.status === 'suppressed') return;
  const segments = messageSegments(account, messageKey)
    .filter((segment) => segment.state !== 'superseded');
  if (!segments.length) return;
  const states = new Set(segments.map((segment) => segment.state));
  if (segments.every((segment) => segment.state === 'sent')) {
    message.status = 'sent';
    message.deliveryState = 'sent';
    message.completedAt ||= now;
    return;
  }
  message.status = 'unfinished';
  if (states.has('unknown')) message.deliveryState = 'unknown';
  else if (states.has('pending')) message.deliveryState = 'pending';
  else if (states.has('sending')) message.deliveryState = 'sending';
  else if (states.has('failed')) message.deliveryState = 'failed';
  else message.deliveryState = 'queued';
}

function reserveRate(draft, at, limits) {
  const windowMs = Number(limits.windowMs) || RATE_WINDOW_MS;
  const max = Number(limits.maxSends) || RATE_MAX_CALLS;
  const recent = (draft.deliveryRate.calls || [])
    .map(Number).filter((value) => Number.isFinite(value) && at - value < windowMs);
  if (recent.length >= max) {
    throw new BiliDmStoreError('DM_RATE_LIMIT', '主动发送频率已达上限', {
      retryAfterMs: Math.max(0, windowMs - (at - Math.min(...recent))),
    });
  }
  recent.push(at);
  draft.deliveryRate.calls = recent;
}

function normalizeReach(value) {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  if (typeof value === 'string') {
    const text = value.toLowerCase();
    if (['yes', 'ok', 'true', 'reachable', 'available', 'allowed'].includes(text)) return 'yes';
    if (['no', 'false', 'blocked', 'unreachable', 'forbidden', 'denied'].includes(text)) return 'no';
    return 'unknown';
  }
  if (isObject(value)) {
    const candidate = value.verdict ?? value.state ?? value.status ?? value.reachable
      ?? value.canC2C ?? value.allowed ?? value.ok;
    return normalizeReach(candidate);
  }
  return 'unknown';
}

function normalizeQuota(value) {
  if (value === true) return null;
  if (value === false) return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Math.max(0, Math.floor(Number(value)));
  }
  if (isObject(value)) {
    const candidate = value.left ?? value.remaining ?? value.quota ?? value.value ?? value.count;
    if (candidate === undefined) return null;
    return normalizeQuota(candidate);
  }
  return null;
}

function classifyError(error) {
  if (!error) return 'unknown';
  const code = String(error.code || error.name || '').toLowerCase();
  const text = String(error.message || '').toLowerCase();
  const combined = `${code} ${text}`;
  if (/(pending|audited|audit|review)/.test(combined)) return 'pending';
  if (/(dry)/.test(combined)) return 'failed';
  if (/(offline|expired|quota|limit|rate|reach|unreachable|blocked|permission|forbidden|denied|reply-expired)/.test(combined)) {
    return 'failed';
  }
  if (/(cancel|cancelled)/.test(combined)) return 'failed';
  return 'unknown';
}

function classifyReturned(returned) {
  if (typeof returned === 'string' && returned.trim()) return 'sent';
  if (typeof returned === 'number' && Number.isFinite(returned)) return 'sent';
  if (!isObject(returned)) return 'unknown';
  if (returned.dry === true) return 'failed';
  if (returned.pending === true) return 'pending';
  if (returned.ok === false || returned.success === false) return 'failed';
  const rawState = returned.state ?? returned.status;
  const id = returned.id ?? returned.msgId ?? returned.messageId;
  const hasId = (typeof id === 'string' && id.trim())
    || (typeof id === 'number' && Number.isFinite(id));
  if (rawState !== undefined && rawState !== null && String(rawState).trim() !== '') {
    const state = String(rawState).toLowerCase();
    if (state === 'sent' || state === 'success' || state === 'succeeded') return 'sent';
    if (state === 'pending' || state === 'audited' || state === 'audit') return 'pending';
    if (state === 'unknown') return 'unknown';
    if (state === 'failed' || state === 'fail') return 'failed';
    return 'unknown';
  }
  return hasId ? 'sent' : 'unknown';
}

function ledgerState(row) {
  if (typeof row === 'string') {
    const text = row.toLowerCase();
    return ['sent', 'success', 'pending', 'audited', 'unknown', 'failed', 'fail'].includes(text)
      ? (text === 'success' ? 'sent' : (text === 'fail' ? 'failed' : text))
      : '';
  }
  if (!isObject(row)) return '';
  const state = String(row.state || row.status || '').toLowerCase();
  if (state === 'sent' || state === 'success') return 'sent';
  if (state === 'pending' || state === 'audited') return 'pending';
  if (state === 'unknown') return 'unknown';
  if (state === 'failed' || state === 'fail') return 'failed';
  if (row.sent === true) return 'sent';
  return '';
}

async function readLedger(ctx, requestId) {
  try {
    const value = ctx?.delivery?.get?.(requestId);
    return value && typeof value.then === 'function' ? await value : (value ?? null);
  } catch {
    return null;
  }
}

async function classify(ctx, requestId, returned, error) {
  const row = await readLedger(ctx, requestId);
  const fromLedger = ledgerState(row);
  if (fromLedger === 'sent') return 'sent';
  if (fromLedger === 'pending') return 'pending';
  if (fromLedger === 'unknown') return 'unknown';
  if (fromLedger === 'failed') return 'failed';
  if (error) return classifyError(error);
  return classifyReturned(returned);
}

function maskTarget(target) {
  const value = String(target || '');
  if (!value) return '';
  return value.length <= 4 ? '***' : `***${value.slice(-4)}`;
}

function passiveBudget(msg, limit = PASSIVE_C2C_BUDGET, ctx = null, at = Date.now()) {
  const receivedAt = Number(msg?.receivedAt);
  const ageKnown = Number.isFinite(receivedAt) && receivedAt > 0;
  const expired = ageKnown && (at < receivedAt || at - receivedAt > PASSIVE_C2C_WINDOW_MS);
  const observed = Number(msg?.kind === 'c2c' ? msg?.api?.seqMap?.get?.(msg?.id) : 0) || 0;
  const external = Number(msg?.ctx?.api?.seqMap?.get?.(msg?.id)) || 0;
  const host = Number(ctx?.api?.seqMap?.get?.(msg?.id)) || 0;
  const tracked = passiveUsed.get(msg) || 0;
  const used = Math.max(observed, external, host, tracked);
  const available = expired ? 0 : Math.max(0, limit - used);
  return { limit, used, remaining: available, expired };
}

function reservePassive(msg) {
  passiveUsed.set(msg, (passiveUsed.get(msg) || 0) + 1);
}

function retryAt(attempts, now) {
  const level = Math.max(0, Math.min(5, Number(attempts) - 1));
  return now + Math.min(30 * 60_000, FAILED_BACKOFF_MS * (2 ** level));
}

export function createBiliDmDelivery({
  store, ctx, now = () => Date.now(), maxMessages = MAX_MESSAGES_PER_PUMP,
} = {}) {
  if (!store || typeof store.transaction !== 'function' || typeof store.read !== 'function') {
    throw new TypeError('createBiliDmDelivery requires a Bili DM store');
  }
  if (!ctx || typeof ctx.push !== 'function' || typeof ctx.isOwner !== 'function') {
    throw new TypeError('createBiliDmDelivery requires the native host context');
  }

  let tail = Promise.resolve();
  let disposed = false;
  const viewCache = new Map();

  function viewCacheGet(key) {
    const row = viewCache.get(key);
    if (!row) return null;
    viewCache.delete(key);
    viewCache.set(key, row);
    return JSON.parse(JSON.stringify(row));
  }

  function viewCacheSet(key, value) {
    viewCache.set(key, JSON.parse(JSON.stringify(value)));
    while (viewCache.size > MAX_VIEW_CACHE) {
      viewCache.delete(viewCache.keys().next().value);
    }
  }

  function withLock(fn) {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  }

  async function ownerOk(target) {
    try { return await Promise.resolve(ctx.isOwner(target)) === true; } catch { return false; }
  }

  function bindingSnapshot() {
    return store.read((state) => ({
      ...bindingDestination(state.binding),
      uid: state.currentUid || '',
    }));
  }

  function guardOk(guard) {
    if (disposed) return false;
    if (guard === undefined) return true;
    try { return typeof guard === 'function' && guard() === true; } catch { return false; }
  }

  async function groupReady(target, { gate = true } = {}) {
    const groupId = safeGroupId(target);
    if (!groupId || typeof ctx.getGroup !== 'function') return null;
    let profile;
    try { profile = await Promise.resolve(ctx.getGroup(groupId)); } catch { return null; }
    if (!profile || typeof profile !== 'object' || profile.enabled === false) return null;
    const owned = profile.groupOpenid ?? profile.groupId ?? profile.chatId;
    if (owned === undefined || safeGroupId(owned) !== groupId) return null;
    if (gate && typeof ctx.gate?.check === 'function') {
      let allowed;
      try {
        allowed = await Promise.resolve(ctx.gate.check(groupId, { kind: 'group', target: groupId }));
      } catch {
        return null;
      }
      if (!gateAllows(allowed)) return null;
    }
    return {
      id: groupId,
      name: safeGroupName(profile.name ?? profile.note ?? ''),
    };
  }

  async function ownerFence({ guard, uid, target, version } = {}) {
    if (!guardOk(guard)) return false;
    let current;
    try { current = bindingSnapshot(); } catch { return false; }
    if (uid && current.uid !== uid) return false;
    if (!target || current.ownerTarget !== target || current.version !== Number(version)) return false;
    if (!(await ownerOk(target))) return false;
    if (!guardOk(guard)) return false;
    try { current = bindingSnapshot(); } catch { return false; }
    if (uid && current.uid !== uid) return false;
    if (current.ownerTarget !== target || current.version !== Number(version)) return false;
    return true;
  }

  async function destinationReady(destination, { gate = true } = {}) {
    if (!destination?.target) return false;
    if (!(await ownerOk(destination.ownerTarget))) return false;
    if (destination.kind === 'group') {
      if (!(await groupReady(destination.target, { gate }))) return false;
    }
    return true;
  }

  async function fenceReady({ guard, uid, destination } = {}) {
    if (!guardOk(guard) || !destination) return false;
    let current;
    try { current = bindingSnapshot(); } catch { return false; }
    if (uid && current.uid !== uid) return false;
    if (!sameDestination(current, destination)) return false;
    if (!(await destinationReady(destination))) return false;
    if (!guardOk(guard)) return false;
    try { current = bindingSnapshot(); } catch { return false; }
    if (uid && current.uid !== uid) return false;
    if (!sameDestination(current, destination)) return false;
    return true;
  }

  function releaseReservedRate(draft, at) {
    const calls = Array.isArray(draft.deliveryRate?.calls) ? draft.deliveryRate.calls : [];
    for (let index = calls.length - 1; index >= 0; index -= 1) {
      if (Number(calls[index]) === Number(at)) {
        calls.splice(index, 1);
        break;
      }
    }
    draft.deliveryRate.calls = calls;
  }

  async function revertUnsent(uid, segmentKey, at, { notification = false } = {}) {
    try {
      await store.transaction((draft) => {
        let row;
        let messageKey = '';
        if (notification) {
          row = (draft.notifications || []).find((item) => item?.key === segmentKey);
        } else {
          row = draft.accounts?.[uid]?.segments?.[segmentKey];
          messageKey = row?.messageKey || '';
        }
        if (!row || row.state !== 'sending') return { reverted: false };
        row.state = 'planned';
        row.attempts = Math.max(0, Number(row.attempts || 0) - 1);
        row.updatedAt = at;
        row.nextRetryAt = 0;
        row.lastErrorCode = '';
        releaseReservedRate(draft, at);
        if (!notification && messageKey) recomputeMessage(draft, draft.accounts[uid], messageKey, at);
        return { reverted: true };
      });
      return true;
    } catch {
      return false;
    }
  }

  async function reconcileUnlocked({ guard } = {}) {
    if (disposed) return { checked: 0, changed: 0 };
    const targets = store.read((state) => {
      const rows = [];
      for (const account of Object.values(state.accounts || {})) {
        for (const segment of Object.values(account.segments || {})) {
          if (['sending', 'pending', 'unknown'].includes(segment.state)) {
            rows.push({
              key: segment.key, requestId: segment.requestId, state: segment.state, notification: false,
            });
          }
        }
      }
      for (const row of Array.isArray(state.notifications) ? state.notifications : []) {
        if (row && ['sending', 'pending', 'unknown'].includes(row.state)) {
          rows.push({
            key: row.key, requestId: row.requestId, state: row.state, notification: true,
          });
        }
      }
      return rows;
    });
    if (!targets.length) return { checked: 0, changed: 0 };
    const resolved = [];
    for (const target of targets) {
      const row = await readLedger(ctx, target.requestId);
      let next = '';
      const state = ledgerState(row);
      if (state === 'sent') next = 'sent';
      else if (state === 'pending') next = 'pending';
      else if (state === 'failed') next = 'failed';
      else if (state === 'unknown') next = 'unknown';
      else if (target.state === 'sending') next = 'unknown';
      else next = target.state;
      if (next !== target.state) resolved.push({ ...target, next });
    }
    if (!resolved.length) return { checked: targets.length, changed: 0 };
    const at = now();
    await store.transaction((draft) => {
      let changed = 0;
      for (const item of resolved) {
        if (item.notification) {
          const row = (draft.notifications || []).find((value) => value?.key === item.key);
          if (!row || row.state !== item.state) continue;
          row.state = item.next;
          row.updatedAt = at;
          if (item.next === 'sent') row.sentAt ||= at;
          if (item.next === 'unknown') row.lastErrorCode = 'ledger_unknown';
          if (item.next === 'failed') {
            row.lastErrorCode = 'ledger_failed';
            row.nextRetryAt = retryAt(row.attempts, at);
          }
          changed += 1;
          continue;
        }
        for (const account of Object.values(draft.accounts)) {
          const segment = account.segments[item.key];
          if (!segment || segment.state !== item.state) continue;
          segment.state = item.next;
          segment.updatedAt = at;
          if (item.next === 'sent') segment.sentAt ||= at;
          if (item.next === 'unknown') segment.lastErrorCode = 'ledger_unknown';
          if (item.next === 'failed') {
            segment.lastErrorCode = 'ledger_failed';
            segment.nextRetryAt = retryAt(segment.attempts, at);
          }
          recomputeMessage(draft, account, segment.messageKey, at);
          changed += 1;
          break;
        }
      }
      return { changed };
    }, { guard });
    return { checked: targets.length, changed: resolved.length };
  }

  async function reconcile(options) {
    return withLock(() => reconcileUnlocked(options));
  }

  async function sendActiveSegment(uid, segmentKey, { guard } = {}) {
    const snapshot = store.read((state) => {
      const account = state.accounts[uid];
      const segment = account?.segments?.[segmentKey];
      return {
        destination: bindingDestination(state.binding),
        uid: state.currentUid || '',
        segment: segment ? JSON.parse(JSON.stringify(segment)) : null,
      };
    });
    const { destination, segment } = snapshot;
    if (!segment || !destination.target) return { state: 'skipped' };
    if (snapshot.uid !== uid || segment.target !== destination.target
      || segment.bindingVersion !== destination.version
      || segmentKind(segment) !== destination.kind) {
      return { state: 'frozen' };
    }
    if (!['planned', 'failed'].includes(segment.state)) return { state: segment.state };
    if (segment.state === 'failed' && Number(segment.nextRetryAt) > now()) return { state: 'backoff' };

    if (!guardOk(guard)) return { state: 'stale' };
    if (!(await ownerOk(destination.ownerTarget))) return { state: 'waiting_owner' };
    let reach = 'unknown';
    let quota = null;
    if (destination.kind === 'group') {
      if (!(await groupReady(destination.target))) return { state: 'unreachable' };
      if (typeof ctx.reach?.canGroupPush !== 'function') return { state: 'unavailable' };
      reach = normalizeReach(await Promise.resolve(ctx.reach.canGroupPush(destination.target))
        .catch(() => 'unknown'));
      if (reach === 'no') return { state: 'unreachable' };
      try {
        quota = normalizeQuota(await Promise.resolve(ctx.quotaLeft?.(destination.target, 'group')));
      } catch { quota = null; }
      if (quota === 0) return { state: 'quota' };
    } else {
      reach = normalizeReach(await Promise.resolve(ctx.reach?.canC2C?.(destination.target))
        .catch(() => 'unknown'));
      if (reach === 'no') return { state: 'unreachable' };
      try {
        quota = normalizeQuota(await Promise.resolve(ctx.quotaLeft?.(destination.target, 'c2c')));
      } catch { quota = null; }
      if (quota === 0) return { state: 'quota' };
    }
    if ((reach === 'unknown' || quota === null) && Number(segment.attempts) > 0
      && segment.state !== 'failed') return { state: 'unknown_hold' };
    if (!(await fenceReady({ guard, uid, destination }))) {
      return { state: disposed ? 'stale' : 'frozen' };
    }

    const at = now();
    let prepared;
    try {
      prepared = await store.transaction((draft) => {
        const account = draft.accounts[uid];
        const current = account?.segments?.[segmentKey];
        if (!current || current.state !== segment.state) {
          throw new BiliDmStoreError('DM_STALE', '投递分段状态已变化');
        }
        if (!sameDestination(bindingDestination(draft.binding), destination)
          || draft.currentUid !== uid) {
          throw new BiliDmStoreError('DM_STALE', '投递目标已变化');
        }
        reserveRate(draft, at, store.limits);
        current.state = 'sending';
        current.attempts = Number(current.attempts || 0) + 1;
        current.firstAttemptAt ||= at;
        current.updatedAt = at;
        current.lastErrorCode = '';
        return { body: current.body, requestId: current.requestId };
      }, { guard });
    } catch (error) {
      if (error instanceof BiliDmStoreError) return { state: error.code === 'DM_RATE_LIMIT' ? 'rate' : 'stale' };
      return { state: 'stale' };
    }
    if (!prepared || !(await fenceReady({ guard, uid, destination }))) {
      await revertUnsent(uid, segmentKey, at);
      return { state: 'aborted' };
    }

    let returned;
    let thrown = null;
    try {
      returned = await ctx.push(destination.target, prepared.body, {
        kind: destination.kind,
        requestId: prepared.requestId,
      });
    } catch (error) {
      thrown = error;
    }
    const state = await classify(ctx, prepared.requestId, returned, thrown);
    const updatedAt = now();
    const commit = (draft) => {
      const account = draft.accounts[uid];
      const current = account?.segments?.[segmentKey];
      if (!current || current.state !== 'sending') return false;
      current.state = state;
      current.updatedAt = updatedAt;
      current.lastErrorCode = storedErrorCode(state, returned);
      if (state === 'sent') current.sentAt = updatedAt;
      if (state === 'failed') current.nextRetryAt = retryAt(current.attempts, updatedAt);
      recomputeMessage(draft, account, current.messageKey, updatedAt);
      return true;
    };
    try {
      await store.transaction(commit, { guard });
    } catch (error) {
      if (disposed || error?.code === 'DM_STALE') {
        try { await store.transaction(commit); } catch { return { state: 'stale' }; }
      } else {
        return { state: 'stale' };
      }
    }
    return { state };
  }

  async function ensureMessageSegments(uid, messageKey, { adopt = false, guard, destination = null } = {}) {
    const at = now();
    return store.transaction((draft) => {
      const account = draft.accounts[uid];
      const message = account?.messages?.[messageKey];
      if (!message || message.status === 'sent' || message.status === 'suppressed'
        || message.deliveryState === 'suppressed') {
        return { segments: [] };
      }
      const binding = draft.binding;
      if (!binding?.target || !draft.currentUid || draft.currentUid !== uid) {
        throw new BiliDmStoreError('DM_BINDING_REQUIRED', '尚未绑定主人私聊');
      }
      const dest = destination
        ? {
          ownerTarget: binding.target,
          kind: destination.kind === 'group' ? 'group' : 'c2c',
          target: destination.target,
          version: Number(destination.version),
        }
        : bindingDestination(binding);
      if (!dest.target) return { segments: [] };
      const all = messageSegments(account, messageKey)
        .filter((segment) => segment.state !== 'superseded');
      const current = all.filter((segment) => segment.target === dest.target
        && segment.bindingVersion === dest.version && segmentKind(segment) === dest.kind);
      if (current.length) return { segments: current.map((segment) => segment.key) };
      if (!all.length) {
        const created = createSegments(draft, account, message, {
          target: dest.target, version: dest.version, targetKind: dest.kind,
        }, at);
        return { segments: created.map((segment) => segment.key) };
      }
      if (!adopt) return { segments: [] };
      if (message.accountUid !== draft.currentUid) return { segments: [] };
      const clearlyUnsent = all.every((segment) => segment.state === 'planned'
        || (segment.state === 'failed' && Number(segment.attempts || 0) === 0));
      if (!clearlyUnsent) return { segments: [] };
      const copies = all.filter((segment) => segment.state === 'planned'
        || (segment.state === 'failed' && Number(segment.attempts || 0) === 0));
      const created = [];
      for (const source of copies) {
        const key = makeSegmentKey({
          messageKey,
          bindingVersion: dest.version,
          target: dest.target,
          index: source.index,
          targetKind: dest.kind,
        });
        let segment = account.segments[key];
        if (!segment) {
          segment = {
            ...source,
            key,
            target: dest.target,
            targetKind: dest.kind,
            bindingVersion: dest.version,
            requestId: makeRequestId({
              robotKey: draft.robotKey,
              accountUid: uid,
              target: dest.target,
              bindingVersion: dest.version,
              messageKey,
              index: source.index,
              targetKind: dest.kind,
            }),
            state: 'planned',
            attempts: 0,
            createdAt: at,
            updatedAt: at,
            nextRetryAt: 0,
            lastErrorCode: '',
            sentAt: null,
            supersededBy: '',
          };
          account.segments[key] = segment;
        }
        source.state = 'superseded';
        source.supersededBy = key;
        source.updatedAt = at;
        created.push(segment);
      }
      recomputeMessage(draft, account, messageKey, at);
      return { segments: created.map((segment) => segment.key) };
    }, { guard });
  }

  function messageFenceState(account, messageKey, destination) {
    const segments = messageSegments(account, messageKey).filter((segment) => (
      segment.state !== 'superseded'
      && segment.target === destination.target
      && segment.bindingVersion === destination.version
      && segmentKind(segment) === destination.kind
    ));
    if (!segments.length) return '';
    if (segments.some((segment) => SEGMENT_BLOCK_STATES.has(segment.state))) return 'blocked';
    if (segments.some((segment) => segment.state === 'failed'
      && Number(segment.nextRetryAt) > now())) return 'blocked';
    return '';
  }

  async function sendMessageUnlocked(uid, messageKey, { guard } = {}) {
    const prepared = await ensureMessageSegments(uid, messageKey, { guard });
    const results = [];
    for (const key of prepared.segments || []) {
      if (disposed) break;
      const result = await sendActiveSegment(uid, key, { guard });
      results.push(result);
      if (result.state !== 'sent') break;
    }
    return results;
  }

  async function sendNotificationUnlocked(notificationKey, { guard } = {}) {
    const snapshot = store.read((state) => {
      const destination = bindingDestination(state.binding);
      const row = (Array.isArray(state.notifications) ? state.notifications : [])
        .find((item) => item?.key === notificationKey);
      return {
        destination,
        uid: state.currentUid || '',
        row: row ? JSON.parse(JSON.stringify(row)) : null,
      };
    });
    const { destination, row } = snapshot;
    if (!row) return { state: 'missing' };
    if (!['planned', 'failed'].includes(row.state)) return { state: row.state };
    if (row.state === 'failed' && Number(row.nextRetryAt) > now()) return { state: 'backoff' };
    if (!destination.target) return { state: 'skipped' };
    const rowDestination = {
      ownerTarget: destination.ownerTarget,
      kind: segmentKind(row),
      target: row.target,
      version: Number(row.bindingVersion),
    };
    if (!sameDestination(destination, rowDestination)) return { state: 'frozen' };
    if (!guardOk(guard)) return { state: 'stale' };
    if (!(await ownerOk(destination.ownerTarget))) return { state: 'waiting_owner' };
    let reach = 'unknown';
    let quota = null;
    if (destination.kind === 'group') {
      if (!(await groupReady(destination.target))) return { state: 'unreachable' };
      if (typeof ctx.reach?.canGroupPush !== 'function') return { state: 'unavailable' };
      reach = normalizeReach(await Promise.resolve(ctx.reach.canGroupPush(destination.target))
        .catch(() => 'unknown'));
      if (reach === 'no') return { state: 'unreachable' };
      try {
        quota = normalizeQuota(await Promise.resolve(ctx.quotaLeft?.(destination.target, 'group')));
      } catch { quota = null; }
    } else {
      reach = normalizeReach(await Promise.resolve(ctx.reach?.canC2C?.(destination.target))
        .catch(() => 'unknown'));
      if (reach === 'no') return { state: 'unreachable' };
      try {
        quota = normalizeQuota(await Promise.resolve(ctx.quotaLeft?.(destination.target, 'c2c')));
      } catch { quota = null; }
    }
    if (quota === 0) return { state: 'quota' };
    if (!(await fenceReady({ guard, uid: snapshot.uid, destination }))) {
      return { state: disposed ? 'stale' : 'frozen' };
    }
    const at = now();
    let prepared;
    try {
      prepared = await store.transaction((draft) => {
        const current = (Array.isArray(draft.notifications) ? draft.notifications : [])
          .find((item) => item?.key === notificationKey);
        if (!current || current.state !== row.state) {
          throw new BiliDmStoreError('DM_STALE', '通知状态已变化');
        }
        if (!sameDestination(bindingDestination(draft.binding), destination)
          || (snapshot.uid && draft.currentUid !== snapshot.uid)) {
          throw new BiliDmStoreError('DM_STALE', '通知目标已变化');
        }
        reserveRate(draft, at, store.limits);
        current.state = 'sending';
        current.attempts = Number(current.attempts || 0) + 1;
        current.updatedAt = at;
        current.lastErrorCode = '';
        return { body: current.body, requestId: current.requestId };
      }, { guard });
    } catch (error) {
      if (error instanceof BiliDmStoreError) return { state: error.code === 'DM_RATE_LIMIT' ? 'rate' : 'stale' };
      return { state: 'stale' };
    }
    if (!prepared || !(await fenceReady({ guard, uid: snapshot.uid, destination }))) {
      await revertUnsent('', notificationKey, at, { notification: true });
      return { state: 'aborted' };
    }
    let returned;
    let thrown = null;
    try {
      returned = await ctx.push(destination.target, prepared.body, {
        kind: destination.kind,
        requestId: prepared.requestId,
      });
    } catch (error) {
      thrown = error;
    }
    const state = await classify(ctx, prepared.requestId, returned, thrown);
    const updatedAt = now();
    const commit = (draft) => {
      const current = (Array.isArray(draft.notifications) ? draft.notifications : [])
        .find((item) => item?.key === notificationKey);
      if (!current || current.state !== 'sending') return false;
      current.state = state;
      current.updatedAt = updatedAt;
      current.lastErrorCode = storedErrorCode(state, returned);
      if (state === 'sent') current.sentAt = updatedAt;
      if (state === 'failed') current.nextRetryAt = retryAt(current.attempts, updatedAt);
      return true;
    };
    try {
      await store.transaction(commit, { guard });
    } catch (error) {
      if (disposed || error?.code === 'DM_STALE') {
        try { await store.transaction(commit); } catch { return { state: 'stale' }; }
      } else {
        return { state: 'stale' };
      }
    }
    return { state };
  }

  async function pumpNotificationsUnlocked({ guard } = {}) {
    if (disposed) return { attempted: 0 };
    const snapshot = store.read((state) => {
      const destination = bindingDestination(state.binding);
      if (!destination.target) return { destination, keys: [] };
      const keys = (Array.isArray(state.notifications) ? state.notifications : [])
        .filter((row) => row && ['planned', 'failed'].includes(row.state)
          && row.target === destination.target
          && Number(row.bindingVersion) === destination.version
          && segmentKind(row) === destination.kind
          && (row.state !== 'failed' || Number(row.nextRetryAt) <= now()))
        .slice(0, MAX_NOTICES_PER_PUMP)
        .map((row) => row.key);
      return { destination, keys };
    });
    let attempted = 0;
    for (const key of snapshot.keys) {
      if (disposed || !guardOk(guard)) break;
      const result = await sendNotificationUnlocked(key, { guard });
      if (['sent', 'failed', 'pending', 'unknown'].includes(result.state)) attempted += 1;
      if (['rate', 'stale', 'aborted', 'unreachable', 'waiting_owner', 'frozen'].includes(result.state)) break;
    }
    return { attempted };
  }

  async function pumpUnlocked({ guard } = {}) {
    if (disposed) return { attempted: 0 };
    if (store.loadError?.()) return { attempted: 0, errorCode: 'DM_STATE_CORRUPT' };
    await reconcileUnlocked({ guard });
    if (disposed || !guardOk(guard)) return { attempted: 0 };
    await pumpNotificationsUnlocked({ guard });
    if (disposed || !guardOk(guard)) return { attempted: 0 };
    const snapshot = store.read((state) => {
      const uid = state.currentUid;
      const account = uid ? state.accounts[uid] : null;
      const destination = bindingDestination(state.binding);
      if (!account) return { uid: '', messages: [], destination };
      const messages = Object.values(account.messages || {})
        .filter((message) => message.status !== 'sent' && message.status !== 'suppressed'
          && message.deliveryState !== 'suppressed')
        .sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0) || compare(left.seqno, right.seqno))
        .map((message) => ({ key: message.key, conversation: conversationOf(message) }));
      return { uid, messages, destination };
    });
    if (!snapshot.uid || !snapshot.destination?.target) return { attempted: 0 };
    const blocked = new Set();
    let attempted = 0;
    for (const item of snapshot.messages) {
      if (disposed) break;
      if (attempted >= maxMessages) break;
      if (!guardOk(guard)) break;
      if (blocked.has(item.conversation)) continue;
      const before = store.read((state) => {
        const account = state.accounts[snapshot.uid];
        const destination = bindingDestination(state.binding);
        if (!account || !destination.target) return false;
        if (state.currentUid !== snapshot.uid) return true;
        return Boolean(messageFenceState(account, item.key, destination));
      });
      if (before) {
        blocked.add(item.conversation);
        continue;
      }
      const results = await sendMessageUnlocked(snapshot.uid, item.key, { guard });
      attempted += results.filter((result) => ['sent', 'failed', 'pending', 'unknown'].includes(result.state)).length;
      const after = store.read((state) => {
        const account = state.accounts[snapshot.uid];
        const destination = bindingDestination(state.binding);
        if (!account || !destination.target || state.currentUid !== snapshot.uid) return true;
        return Boolean(messageFenceState(account, item.key, destination));
      });
      if (after) blocked.add(item.conversation);
      if (results.some((result) => result.state === 'rate')) break;
      if (results.some((result) => ['stale', 'aborted'].includes(result.state))) break;
    }
    return { attempted };
  }

  async function pump(options) {
    return withLock(() => pumpUnlocked(options));
  }

  async function pumpNotices(options) {
    return withLock(() => pumpNotificationsUnlocked(options));
  }

  function materializeBacklog(draft, oldDestination, at) {
    const uid = draft.currentUid;
    const account = uid ? draft.accounts[uid] : null;
    if (!account || !oldDestination.target) return;
    for (const message of Object.values(account.messages || {})) {
      if (!message || message.status === 'sent' || message.status === 'suppressed') continue;
      if (messageSegments(account, message.key).length) continue;
      createSegments(draft, account, message, {
        target: oldDestination.target,
        version: oldDestination.version,
        targetKind: oldDestination.kind,
      }, at);
    }
  }

  async function configureTarget(input, { guard } = {}) {
    return withLock(async () => {
      if (disposed) throw new BiliDmStoreError('DM_STALE', '私信服务已停用');
      const request = isObject(input) ? input : {};
      const kind = request.kind === 'group' ? 'group' : (request.kind === 'c2c' ? 'c2c' : '');
      if (!kind) throw new BiliDmStoreError('DM_BINDING_INVALID', '通知目标类型不合法');
      const rawTarget = String(request.target ?? '');
      const prior = store.read((state) => JSON.parse(JSON.stringify(state.binding)));
      if (!prior?.target) throw new BiliDmStoreError('DM_BINDING_REQUIRED', '尚未绑定主人私聊');
      if (!(await ownerOk(prior.target))) {
        throw new BiliDmStoreError('DM_OWNER_REQUIRED', '当前用户不是机器人主人');
      }
      let groupId = '';
      let groupName = '';
      if (kind === 'group') {
        groupId = safeGroupId(rawTarget);
        if (!groupId) throw new BiliDmStoreError('DM_BINDING_INVALID', '群目标格式不合法');
        const info = await groupReady(groupId);
        if (!info) throw new BiliDmStoreError('DM_GROUP_INVALID', '所选群不存在或已停用');
        groupName = info.name;
      } else if (rawTarget && rawTarget !== prior.target) {
        throw new BiliDmStoreError('DM_BINDING_INVALID', '主人私聊目标不能被替换');
      }
      if (!guardOk(guard) || !(await ownerOk(prior.target)) || !guardOk(guard)) {
        throw new BiliDmStoreError(disposed ? 'DM_STALE' : 'DM_OWNER_REQUIRED', '主人校验已失效');
      }
      await reconcileUnlocked({ guard });
      if (disposed || !guardOk(guard)) throw new BiliDmStoreError('DM_STALE', '私信服务已停用');
      if (!(await ownerOk(prior.target))) {
        throw new BiliDmStoreError('DM_OWNER_REQUIRED', '当前用户不是机器人主人');
      }
      const at = now();
      let outcome;
      try {
        outcome = await store.transaction((draft) => {
          const binding = draft.binding;
          if (!binding || binding.target !== prior.target
            || Number(binding.version) !== Number(prior.version)) {
            throw new BiliDmStoreError('DM_STALE', '通知绑定已变化');
          }
          const oldDestination = bindingDestination(binding);
          const changed = oldDestination.kind !== kind
            || (kind === 'group' && oldDestination.target !== groupId);
          if (!changed) {
            if (kind === 'group' && binding.groupName !== groupName) binding.groupName = groupName;
            return { changed: false, kind, version: Number(binding.version) };
          }
          materializeBacklog(draft, oldDestination, at);
          binding.notifyKind = kind;
          binding.groupTarget = kind === 'group' ? groupId : '';
          binding.groupName = kind === 'group' ? groupName : '';
          binding.version = (Number(binding.version) || 0) + 1;
          binding.updatedAt = at;
          return { changed: true, kind, version: Number(binding.version) };
        }, { guard });
      } catch (error) {
        if (error instanceof BiliDmStoreError) throw error;
        throw new BiliDmStoreError('DM_STALE', '通知目标写入失败');
      }
      const destination = {
        ownerTarget: prior.target,
        kind,
        target: kind === 'group' ? groupId : prior.target,
        version: outcome.version,
      };
      if (!(await fenceReady({ guard, destination }))) {
        try {
          await store.transaction((draft) => {
            const binding = draft.binding;
            if (!binding || binding.target !== prior.target
              || Number(binding.version) !== outcome.version) return;
            binding.notifyKind = prior.notifyKind ?? 'c2c';
            binding.groupTarget = prior.groupTarget ?? '';
            binding.groupName = prior.groupName ?? '';
            binding.version = prior.version;
            binding.updatedAt = prior.updatedAt;
          });
        } catch { /* the caller still receives a fail-closed result */ }
        throw new BiliDmStoreError(disposed ? 'DM_STALE' : 'DM_OWNER_REQUIRED', '通知目标校验已失效');
      }
      return { ok: true, changed: outcome.changed, kind, version: outcome.version };
    });
  }

  async function bind(msg, { guard } = {}) {
    return withLock(async () => {
      if (disposed) throw new BiliDmStoreError('DM_STALE', '私信服务已停用');
      if (!msg || msg.kind !== 'c2c') throw new BiliDmStoreError('DM_OWNER_REQUIRED', '请在主人 QQ 私聊中绑定');
      const target = String(msg.userId || '');
      if (!target) throw new BiliDmStoreError('DM_OWNER_REQUIRED', '无法确认当前私聊用户');
      if (msg.chatId && String(msg.chatId) !== target) {
        throw new BiliDmStoreError('DM_OWNER_REQUIRED', '当前会话不是标准 C2C 私聊');
      }
      if (!(await ownerOk(target))) throw new BiliDmStoreError('DM_OWNER_REQUIRED', '当前用户不是机器人主人');
      await reconcileUnlocked({ guard });
      if (!guardOk(guard) || !(await ownerOk(target)) || !guardOk(guard)) {
        throw new BiliDmStoreError(disposed ? 'DM_STALE' : 'DM_OWNER_REQUIRED', '主人校验已失效');
      }
      const prior = store.read((state) => ({
        target: state.binding?.target ?? null,
        version: Number(state.binding?.version) || 0,
        updatedAt: state.binding?.updatedAt ?? null,
      }));
      const binding = await store.bind(target, { guard });
      if (!(await ownerFence({ guard, target: binding.target, version: binding.version }))) {
        try {
          await store.transaction((draft) => {
            if (draft.binding?.target !== binding.target
              || Number(draft.binding?.version) !== Number(binding.version)) return;
            draft.binding.target = prior.target;
            draft.binding.version = prior.version;
            draft.binding.updatedAt = prior.updatedAt;
          });
        } catch { /* the caller still receives a fail-closed error */ }
        throw new BiliDmStoreError(disposed ? 'DM_STALE' : 'DM_OWNER_REQUIRED', '主人校验已失效');
      }
      return { ok: true, bound: true, version: binding.version, mask: maskTarget(binding.target) };
    });
  }

  async function claim(msg, { limit = PASSIVE_C2C_BUDGET, guard } = {}) {
    return withLock(async () => {
      if (disposed) return { sent: 0, remaining: 0 };
      if (!msg || msg.kind !== 'c2c') throw new BiliDmStoreError('DM_OWNER_REQUIRED', '请在主人 QQ 私聊中领取');
      const target = String(msg.userId || '');
      if (msg.chatId && String(msg.chatId) !== target) {
        throw new BiliDmStoreError('DM_OWNER_REQUIRED', '当前会话不是标准 C2C 私聊');
      }
      if (!(await ownerOk(target))) throw new BiliDmStoreError('DM_OWNER_REQUIRED', '当前用户不是机器人主人');
      const binding = store.read((state) => ({ ...state.binding }));
      if (!binding?.target || binding.target !== target) {
        throw new BiliDmStoreError('DM_OWNER_REQUIRED', '当前私聊尚未绑定为接收目标');
      }
      await reconcileUnlocked({ guard });
      if (disposed || !guardOk(guard)) return { sent: 0, remaining: 0 };
      if (!(await ownerFence({ guard, target, version: binding.version }))) {
        return { sent: 0, remaining: 0 };
      }
      const claimDestination = {
        ownerTarget: binding.target, kind: 'c2c', target: binding.target, version: binding.version,
      };
      const snapshot = store.read((state) => {
        const uid = state.currentUid;
        const account = uid ? state.accounts[uid] : null;
        return {
          uid,
          keys: account
            ? Object.values(account.messages || {})
              .filter((message) => message.status !== 'sent' && message.status !== 'suppressed'
                && message.deliveryState !== 'suppressed')
              .sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0)
                || compare(left.seqno, right.seqno))
              .map((message) => ({ key: message.key, conversation: conversationOf(message) }))
            : [],
        };
      });
      if (!snapshot.uid) return { sent: 0, remaining: 0 };
      for (const item of snapshot.keys) {
        if (disposed || !guardOk(guard)) return { sent: 0, remaining: 0 };
        try {
          await ensureMessageSegments(snapshot.uid, item.key, {
            adopt: true, guard, destination: claimDestination,
          });
        } catch { /* per-message failure is visible in state */ }
      }
      const budget = passiveBudget(msg, limit, ctx, now());
      if (budget.remaining <= 0) return { sent: 0, remaining: 0, expired: budget.expired };

      const plans = store.read((state) => {
        const account = state.accounts[snapshot.uid];
        if (!account) return [];
        return snapshot.keys.map((item) => {
          const segments = messageSegments(account, item.key).filter((segment) => (
            segment.state !== 'superseded'
            && segment.target === claimDestination.target
            && segment.bindingVersion === claimDestination.version
            && segmentKind(segment) === 'c2c'
          ));
          const blocked = segments.some((segment) => SEGMENT_BLOCK_STATES.has(segment.state))
            || segments.some((segment) => segment.state === 'failed'
              && Number(segment.nextRetryAt) > now());
          const sendable = segments
            .filter((segment) => segment.state === 'planned'
              || (segment.state === 'failed' && Number(segment.nextRetryAt) <= now()))
            .map((segment) => ({
              key: item.key,
              segmentKey: segment.key,
              requestId: segment.requestId,
              body: segment.body,
              state: segment.state,
              target: segment.target,
              version: segment.bindingVersion,
              index: segment.index,
            }));
          return { ...item, blocked, sendable };
        });
      });
      const pendingCount = store.read((state) => {
        const account = state.accounts[snapshot.uid];
        if (!account) return 0;
        let count = 0;
        for (const item of snapshot.keys) {
          for (const segment of messageSegments(account, item.key)) {
            if (segment.state === 'superseded') continue;
            if (segment.target !== claimDestination.target
              || segment.bindingVersion !== claimDestination.version
              || segmentKind(segment) !== 'c2c') continue;
            if (SEGMENT_BLOCK_STATES.has(segment.state)) count += 1;
          }
        }
        return count;
      });
      const previewBlocked = new Set();
      let totalSendable = 0;
      for (const plan of plans) {
        if (previewBlocked.has(plan.conversation)) continue;
        if (plan.blocked) {
          previewBlocked.add(plan.conversation);
          continue;
        }
        totalSendable += plan.sendable.length;
      }
      if (totalSendable <= 0 && pendingCount <= 0) return { sent: 0, remaining: 0 };

      const reserve = totalSendable > budget.remaining || pendingCount > 0 ? 1 : 0;
      let contentSlots = Math.max(0, budget.remaining - reserve);
      let sent = 0;
      let ownerLost = false;
      let stopped = false;
      const blocked = new Set();
      for (const plan of plans) {
        if (stopped || ownerLost || contentSlots <= 0) break;
        if (blocked.has(plan.conversation)) continue;
        if (plan.blocked || !plan.sendable.length) {
          if (plan.blocked) blocked.add(plan.conversation);
          continue;
        }
        let failed = false;
        for (const item of plan.sendable) {
          if (contentSlots <= 0) break;
          const state = await sendClaimSegment(snapshot.uid, item, msg, { guard });
          if (state === 'sent') {
            sent += 1;
            contentSlots -= 1;
            continue;
          }
          if (state === 'waiting_owner') { ownerLost = true; stopped = true; break; }
          if (['rate', 'stale', 'aborted', 'budget'].includes(state)) { stopped = true; break; }
          failed = true;
          break;
        }
        if (failed) blocked.add(plan.conversation);
      }
      const remaining = Math.max(0, totalSendable - sent);
      if (!ownerLost && !disposed && guardOk(guard)
        && (remaining > 0 || pendingCount > 0)
        && passiveBudget(msg, limit, ctx, now()).remaining > 0
        && await ownerFence({ guard, target, version: binding.version })) {
        const parts = [];
        if (remaining > 0) parts.push(`还有 ${remaining} 段可继续领取`);
        if (pendingCount > 0) parts.push(`另有 ${pendingCount} 段待核对或未知，不会自动重复发送`);
        const text = `${parts.join('；')}。请按需发送 /解析 私信 领取，不会自动补发。`;
        const requestId = `bili-dm-claim-notice-${stableHash([
          snapshot.uid, target, String(msg.id || msg.receivedAt || ''), text,
        ])}`;
        try {
          reservePassive(msg);
          await msg.replyNow(text, { requestId });
        } catch { /* the next claim will retry */ }
      }
      return { sent, remaining, pending: pendingCount, sendable: totalSendable, expired: budget.expired };
    });
  }

  async function sendClaimSegment(uid, item, msg, { guard } = {}) {
    if (passiveBudget(msg, PASSIVE_C2C_BUDGET, ctx, now()).remaining <= 0) return 'budget';
    if (!(await ownerFence({ guard, uid, target: item.target, version: item.version }))) {
      return disposed || !guardOk(guard) ? 'aborted' : 'waiting_owner';
    }
    const at = now();
    let prepared;
    try {
      prepared = await store.transaction((draft) => {
        const account = draft.accounts[uid];
        const segment = account?.segments?.[item.segmentKey];
        if (!segment || !['planned', 'failed'].includes(segment.state)) {
          throw new BiliDmStoreError('DM_STALE', '投递分段状态已变化');
        }
        const binding = draft.binding;
        if (binding?.target !== segment.target || Number(binding?.version) !== segment.bindingVersion
          || segmentKind(segment) !== 'c2c' || draft.currentUid !== uid) {
          throw new BiliDmStoreError('DM_STALE', '投递目标已变化');
        }
        segment.state = 'sending';
        segment.attempts = Number(segment.attempts || 0) + 1;
        segment.firstAttemptAt ||= at;
        segment.updatedAt = at;
        segment.lastErrorCode = '';
        return { body: segment.body, requestId: segment.requestId };
      }, { guard });
    } catch (error) {
      return error instanceof BiliDmStoreError && error.code === 'DM_RATE_LIMIT' ? 'rate' : 'stale';
    }
    if (!prepared || !(await ownerFence({ guard, uid, target: item.target, version: item.version }))) {
      await revertUnsent(uid, item.segmentKey, at);
      return 'aborted';
    }
    const errors = [];
    let returned;
    try {
      reservePassive(msg);
      returned = await msg.replyNow(prepared.body, {
        requestId: prepared.requestId,
        onError: (error) => errors.push(error),
      });
    } catch (error) {
      errors.push(error);
    }
    const state = await classify(ctx, prepared.requestId, returned, errors[0] || null);
    const updatedAt = now();
    const commit = (draft) => {
      const account = draft.accounts[uid];
      const segment = account?.segments?.[item.segmentKey];
      if (!segment || segment.state !== 'sending') return false;
      segment.state = state;
      segment.updatedAt = updatedAt;
      segment.lastErrorCode = storedErrorCode(state, returned);
      if (state === 'sent') segment.sentAt = updatedAt;
      if (state === 'failed') segment.nextRetryAt = retryAt(segment.attempts, updatedAt);
      recomputeMessage(draft, account, segment.messageKey, updatedAt);
      return true;
    };
    try {
      await store.transaction(commit, { guard });
    } catch (error) {
      if (disposed || error?.code === 'DM_STALE') {
        try { await store.transaction(commit); } catch { return 'stale'; }
      } else {
        return 'stale';
      }
    }
    return state;
  }

  function notificationList(draft) {
    if (!Array.isArray(draft.notifications)) draft.notifications = [];
    return draft.notifications;
  }

  function reserveNotificationSlot(draft, at) {
    const list = notificationList(draft);
    while (list.length >= MAX_NOTIFICATIONS) {
      const index = list.findIndex((row) => row?.state === 'sent');
      if (index < 0) throw new BiliDmStoreError('DM_CAPACITY', '通知状态已达上限');
      list.splice(index, 1);
    }
    const id = Math.max(0, Number(draft.notificationSeq) || 0) + 1;
    draft.notificationSeq = id;
    return id;
  }

  function notificationRequestId({ robotKey, destination, key, purpose }) {
    return makeRequestId({
      robotKey,
      accountUid: '',
      target: destination.target,
      bindingVersion: destination.version,
      messageKey: key,
      index: 0,
      purpose,
      targetKind: destination.kind,
    });
  }

  async function sendTest(msg, { guard } = {}) {
    return withLock(async () => {
      if (disposed) throw new BiliDmStoreError('DM_STALE', '私信服务已停用');
      await reconcileUnlocked({ guard });
      if (disposed || !guardOk(guard)) throw new BiliDmStoreError('DM_STALE', '私信服务已停用');
      const snapshot = store.read((state) => ({
        destination: bindingDestination(state.binding),
        robotKey: state.robotKey,
      }));
      const destination = snapshot.destination;
      let trigger = '';
      if (msg !== undefined && msg !== null) {
        if (msg.kind !== 'c2c') throw new BiliDmStoreError('DM_OWNER_REQUIRED', '请在主人 QQ 私聊中发送测试');
        const target = String(msg.userId || '');
        if (!target) throw new BiliDmStoreError('DM_OWNER_REQUIRED', '无法确认当前私聊用户');
        if (msg.chatId && String(msg.chatId) !== target) {
          throw new BiliDmStoreError('DM_OWNER_REQUIRED', '当前会话不是标准 C2C 私聊');
        }
        if (!destination.ownerTarget || destination.ownerTarget !== target) {
          throw new BiliDmStoreError('DM_BINDING_REQUIRED', '当前私聊尚未绑定为接收目标');
        }
        trigger = msg.id || msg.receivedAt
          ? `msg:${String(msg.id || msg.receivedAt)}`
          : 'panel';
      } else {
        if (!destination.ownerTarget) throw new BiliDmStoreError('DM_BINDING_REQUIRED', '尚未绑定主人私聊');
        trigger = 'panel';
      }
      if (!destination.target) throw new BiliDmStoreError('DM_BINDING_REQUIRED', '尚未配置通知目标');
      if (!guardOk(guard)) throw new BiliDmStoreError('DM_STALE', '私信任务已失效');
      if (!(await ownerOk(destination.ownerTarget))) {
        throw new BiliDmStoreError('DM_OWNER_REQUIRED', '当前用户不是机器人主人');
      }
      if (destination.kind === 'group' && !(await groupReady(destination.target))) {
        throw new BiliDmStoreError('DM_GROUP_INVALID', '所选群当前不可用');
      }
      if (!(await fenceReady({ guard, destination }))) {
        throw new BiliDmStoreError(disposed ? 'DM_STALE' : 'DM_OWNER_REQUIRED', '主人校验已失效');
      }
      const at = now();
      let prepared;
      try {
        prepared = await store.transaction((draft) => {
          if (!sameDestination(bindingDestination(draft.binding), destination)) {
            throw new BiliDmStoreError('DM_STALE', '投递目标已变化');
          }
          const list = notificationList(draft);
          let key = '';
          let row = null;
          if (trigger === 'panel') {
            const id = reserveNotificationSlot(draft, at);
            key = `test|${destination.kind}|${destination.version}|${destination.target}|panel:${id}`;
          } else {
            key = `test|${destination.kind}|${destination.version}|${destination.target}|${trigger}`;
            row = list.find((item) => item?.key === key) || null;
            if (row?.state === 'sent') return { skip: true, state: 'sent' };
            if (row && !['planned', 'failed'].includes(row.state)) {
              return { skip: true, state: row.state };
            }
            if (row?.state === 'failed' && Number(row.nextRetryAt) > at) {
              return { skip: true, state: 'backoff' };
            }
          }
          if (!row) {
            const id = trigger === 'panel'
              ? Number(draft.notificationSeq)
              : reserveNotificationSlot(draft, at);
            const body = `【B站私信·测试】\n主人通知通道测试成功。\n编号：DM-TEST-${shortMessageId(key)}\n这条测试不会读取或消耗任何真实私信内容。`;
            row = {
              id,
              key,
              target: destination.target,
              targetKind: destination.kind,
              bindingVersion: destination.version,
              body,
              requestId: notificationRequestId({
                robotKey: draft.robotKey, destination, key, purpose: 'dm-test',
              }),
              state: 'planned',
              attempts: 0,
              createdAt: at,
              updatedAt: at,
              nextRetryAt: 0,
              lastErrorCode: '',
              sentAt: null,
            };
            list.push(row);
          }
          return { skip: false, key: row.key };
        }, { guard });
      } catch (error) {
        if (error instanceof BiliDmStoreError) throw error;
        throw new BiliDmStoreError('DM_STALE', '测试通知状态写入失败');
      }
      if (prepared.skip) return { sent: 0, states: [prepared.state], alreadySent: prepared.state === 'sent' };
      const result = await sendNotificationUnlocked(prepared.key, { guard });
      return { sent: result.state === 'sent' ? 1 : 0, states: [result.state] };
    });
  }

  async function notifyStatus(notice, { guard, uid, revision } = {}) {
    return withLock(async () => {
      if (disposed) return { accepted: false, state: 'disabled' };
      if (!isObject(notice)) return { accepted: false, state: 'invalid' };
      const code = String(notice.code || '');
      if (!SAFE_STATUS_CODES.has(code)) return { accepted: false, state: 'invalid' };
      if (!guardOk(guard)) return { accepted: false, state: 'stale' };
      let snapshot;
      try {
        snapshot = store.read((state) => ({
          destination: bindingDestination(state.binding),
          robotKey: state.robotKey,
          uid: state.currentUid || '',
        }));
      } catch {
        return { accepted: false, state: 'unavailable' };
      }
      if (!snapshot.destination.ownerTarget || !snapshot.destination.target) {
        return { accepted: false, state: 'unbound' };
      }
      if (uid && snapshot.uid !== uid) return { accepted: false, state: 'stale' };
      if (!guardOk(guard)) return { accepted: false, state: 'stale' };
      const destination = snapshot.destination;
      const at = Number(notice.at) || now();
      const key = `status|${code}|${destination.kind}|${destination.version}|${destination.target}|${at}`;
      const body = noticeBody(code);
      let accepted = false;
      try {
        accepted = await store.transaction((draft) => {
          if (!sameDestination(bindingDestination(draft.binding), destination)) return false;
          if (uid && draft.currentUid !== uid) return false;
          const list = notificationList(draft);
          if (list.some((row) => row?.key === key)) return true;
          const id = reserveNotificationSlot(draft, at);
          list.push({
            id,
            key,
            target: destination.target,
            targetKind: destination.kind,
            bindingVersion: destination.version,
            body,
            requestId: notificationRequestId({
              robotKey: draft.robotKey, destination, key, purpose: 'dm-notice',
            }),
            state: 'planned',
            attempts: 0,
            createdAt: at,
            updatedAt: at,
            nextRetryAt: 0,
            lastErrorCode: '',
            sentAt: null,
            noticeCode: code,
          });
          return true;
        }, { guard });
      } catch {
        return { accepted: false, state: 'write_failed' };
      }
      if (!accepted) return { accepted: false, state: 'stale' };
      if (!guardOk(guard)) return { accepted: true, state: 'deferred' };
      const result = await sendNotificationUnlocked(key, { guard });
      return { accepted: true, state: result.state, sent: result.state === 'sent' };
    });
  }

  async function view(msg, { shortId, page = 1, guard } = {}) {
    return withLock(async () => {
      if (!msg || msg.kind !== 'c2c') throw new BiliDmStoreError('DM_OWNER_REQUIRED', '请在主人 QQ 私聊中查看');
      const target = String(msg.userId || '');
      if (msg.chatId && String(msg.chatId) !== target) {
        throw new BiliDmStoreError('DM_OWNER_REQUIRED', '当前会话不是标准 C2C 私聊');
      }
      if (!(await ownerOk(target))) throw new BiliDmStoreError('DM_OWNER_REQUIRED', '当前用户不是机器人主人');
      const binding = store.read((state) => ({
        target: state.binding?.target || '',
        version: Number(state.binding?.version) || 0,
      }));
      if (!binding.target || binding.target !== target) {
        throw new BiliDmStoreError('DM_BINDING_REQUIRED', '当前私聊尚未绑定为接收目标');
      }
      if (!guardOk(guard)) throw new BiliDmStoreError('DM_STALE', '私信任务已失效');
      const rawLookup = String(shortId || '').trim().toUpperCase();
      const lookup = rawLookup.startsWith('DM-') ? rawLookup.slice(3) : rawLookup;
      if (!SHORT_ID_RE.test(lookup)) {
        return { ok: false, reasonCode: 'DM_SHORT_ID_INVALID', sent: 0, remaining: 0, nextPage: null };
      }
      const requested = Number(page);
      const pageNumber = Number.isSafeInteger(requested) && requested >= 1 ? requested : 1;
      const found = store.read((state) => {
        const uid = state.currentUid;
        const account = uid ? state.accounts[uid] : null;
        if (!account) return { record: null, ambiguous: false, robotKey: state.robotKey, uid };
        const matches = new Map();
        for (const message of Object.values(account.messages || {})) {
          const short = shortMessageId(message.key).toUpperCase();
          if (short === lookup) matches.set(message.key, message);
        }
        if (matches.size > 1) return { record: null, ambiguous: true, robotKey: state.robotKey, uid };
        const record = matches.size === 1 ? [...matches.values()][0] : null;
        return {
          record: record ? JSON.parse(JSON.stringify(record)) : null,
          ambiguous: false,
          robotKey: state.robotKey,
          uid,
        };
      });
      if (found.ambiguous) {
        return { ok: false, reasonCode: 'DM_AMBIGUOUS', sent: 0, remaining: 0, nextPage: null };
      }
      if (!found.record) {
        return { ok: false, reasonCode: 'DM_NOT_FOUND', sent: 0, remaining: 0, nextPage: null };
      }
      const cacheKey = [
        String(msg.id || msg.receivedAt || ''), lookup, pageNumber, binding.target, binding.version,
      ].join('|');
      const cached = viewCacheGet(cacheKey);
      if (cached) return cached;

      const bodies = buildSegmentBodies(found.record, { label: '【B站私信·重复查看】' });
      const totalPages = Math.max(1, Math.ceil(bodies.length / VIEW_PAGE_SIZE));
      if (pageNumber > totalPages) {
        return {
          ok: false, reasonCode: 'DM_PAGE_OUT_OF_RANGE', sent: 0, remaining: 0,
          page: pageNumber, totalPages, nextPage: null,
        };
      }
      const start = (pageNumber - 1) * VIEW_PAGE_SIZE;
      const end = Math.min(bodies.length, start + VIEW_PAGE_SIZE);
      const pageBodies = bodies.slice(start, end);
      const more = end < bodies.length;
      const budget = passiveBudget(msg, PASSIVE_C2C_BUDGET, ctx, now());
      if (budget.remaining <= 0) {
        return {
          ok: false, reasonCode: 'DM_PASSIVE_BUDGET', sent: 0, remaining: bodies.length - start,
          page: pageNumber, totalPages,
          nextPage: bodies.length - start > 0 ? Math.floor(start / VIEW_PAGE_SIZE) + 1 : null,
        };
      }
      const reserveContinuation = more ? 1 : 0;
      let chunkSlots = Math.max(0, budget.remaining - reserveContinuation);
      let sent = 0;
      let stopped = false;
      const messageId = String(msg.id || msg.receivedAt || '');
      for (let index = 0; index < pageBodies.length && chunkSlots > 0; index += 1) {
        if (!(await ownerFence({ guard, uid: found.uid, target, version: binding.version }))) {
          stopped = true;
          break;
        }
        const globalIndex = start + index;
        const requestId = makeRequestId({
          robotKey: found.robotKey,
          accountUid: found.uid,
          target,
          bindingVersion: binding.version,
          messageKey: `view:${found.record.key}:${pageNumber}:${messageId}`,
          index: globalIndex,
          purpose: 'dm-view',
        });
        const ledger = await readLedger(ctx, requestId);
        if (ledgerState(ledger) === 'sent') {
          sent += 1;
          chunkSlots -= 1;
          continue;
        }
        if (!(await ownerFence({ guard, uid: found.uid, target, version: binding.version }))) {
          stopped = true;
          break;
        }
        let returned;
        let error = null;
        try {
          reservePassive(msg);
          returned = await msg.replyNow(pageBodies[index], {
            requestId, onError: (value) => { error = value; },
          });
        } catch (value) {
          error = value;
        }
        const state = await classify(ctx, requestId, returned, error);
        if (state === 'sent') {
          sent += 1;
          chunkSlots -= 1;
          continue;
        }
        stopped = true;
        break;
      }
      const shown = start + sent;
      const remaining = Math.max(0, bodies.length - shown);
      const nextPage = remaining > 0 ? Math.floor(shown / VIEW_PAGE_SIZE) + 1 : null;
      let continuationSent = false;
      if (!stopped && nextPage && sent === pageBodies.length
        && passiveBudget(msg, PASSIVE_C2C_BUDGET, ctx, now()).remaining > 0
        && await ownerFence({ guard, uid: found.uid, target, version: binding.version })) {
        const text = `第 ${pageNumber}/${totalPages} 页已显示，剩余 ${remaining} 段。`
          + `继续查看请发送 /解析 私信 查看 ${lookup} ${nextPage}。`;
        const requestId = `bili-dm-view-next:${stableHash([
          found.record.key, pageNumber, remaining, lookup, messageId, text,
        ])}`;
        try {
          reservePassive(msg);
          await msg.replyNow(text, { requestId });
          continuationSent = true;
        } catch { /* the next explicit page request can continue */ }
      }
      const result = {
        ok: true,
        sent,
        duplicateView: true,
        page: pageNumber,
        totalPages,
        remaining,
        nextPage: continuationSent || remaining > 0 ? nextPage : null,
        shortId: lookup,
        continuation: continuationSent || remaining > 0,
      };
      if (!stopped) viewCacheSet(cacheKey, result);
      return result;
    });
  }

  function status() {
    if (disposed) return { state: 'disabled', binding: { bound: false, mask: '' }, queue: {} };
    try {
      const state = store.read((value) => value);
      const binding = state.binding || { target: '', version: 0 };
      const counters = store.statusCounters();
      let lastSuccessAt = null;
      for (const account of Object.values(state.accounts || {})) {
        for (const segment of Object.values(account.segments || {})) {
          if (segment.state === 'sent' && segment.sentAt && (!lastSuccessAt || segment.sentAt > lastSuccessAt)) {
            lastSuccessAt = segment.sentAt;
          }
        }
      }
      for (const row of Array.isArray(state.notifications) ? state.notifications : []) {
        if (row?.state === 'sent' && row.sentAt && (!lastSuccessAt || row.sentAt > lastSuccessAt)) {
          lastSuccessAt = row.sentAt;
        }
      }
      let rate = { used: 0, remaining: store.limits?.maxSends ?? RATE_MAX_CALLS };
      try { rate = store.rateInfo(); } catch { /* status remains bounded */ }
      return {
        state: binding.target ? 'bound' : 'unbound',
        binding: { bound: Boolean(binding.target), mask: maskTarget(binding.target), version: binding.version || 0 },
        queue: {
          unfinished: counters.unfinished,
          planned: counters.planned,
          sending: counters.sending,
          pending: counters.pending,
          unknown: counters.unknown,
          failed: counters.failed,
          sent: counters.sent,
          suppressed: counters.suppressed,
          superseded: counters.superseded,
        },
        rate: { used: rate.used, remaining: rate.remaining, nextAt: rate.nextAt || null },
        lastSuccessAt,
      };
    } catch (error) {
      return {
        state: 'error',
        reasonCode: safeStatusCode(error?.code),
        binding: { bound: false, mask: '' },
        queue: {},
      };
    }
  }

  function deactivate() {
    disposed = true;
    return status();
  }

  return {
    bind,
    pump,
    pumpNotices,
    reconcile,
    configureTarget,
    notifyStatus,
    claim,
    sendTest,
    view,
    status,
    deactivate,
    flush: () => Promise.all([store.flush(), tail]),
    _internal: { sendMessageUnlocked, ensureMessageSegments },
  };
}

export { classifyError, classifyReturned, normalizeReach, normalizeQuota, maskTarget };
