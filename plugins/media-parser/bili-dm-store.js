import fsDefault from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const SCHEMA_VERSION = 1;
export const STATE_FILE = 'bili-dm-state.json';
export const MAX_UNFINISHED = 1000;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const COMPLETED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_NOTIFICATIONS = 20;

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SEQ_RE = /^(0|[1-9]\d{0,39})$/;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_CALLS = 2;

export class BiliDmStoreError extends Error {
  constructor(code, message = code, options = {}) {
    super(message);
    this.name = 'BiliDmStoreError';
    this.code = code;
    this.cause = options.cause;
    this.retryAfterMs = Number.isFinite(options.retryAfterMs) ? Math.max(0, options.retryAfterMs) : 0;
  }
}

function fail(code, message = code, options) {
  throw new BiliDmStoreError(code, message, options);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function isSafeSeq(value) {
  return typeof value === 'string' && SEQ_RE.test(value);
}

export function compareSeq(left, right) {
  const a = BigInt(isSafeSeq(left) ? left : '0');
  const b = BigInt(isSafeSeq(right) ? right : '0');
  return a === b ? 0 : a > b ? 1 : -1;
}

export function normalizeSeq(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && SEQ_RE.test(value)) return value;
  return fail('DM_STATE_CORRUPT', '序号格式不合法');
}

function keyPart(value, name) {
  const text = String(value ?? '');
  if (!text || text.length > 512 || /[\u0000-\u001f|]/.test(text)) {
    fail('DM_STATE_CORRUPT', `${name} 格式不合法`);
  }
  return text;
}

export function conversationKey(sessionType, talkerId) {
  const type = Number(sessionType);
  if (![1, 2].includes(type)) fail('DM_STATE_CORRUPT', '会话类型不合法');
  return `${type}:${keyPart(talkerId, '会话 ID')}`;
}

export function makeMessageKey({ robotKey, accountUid, sessionType, talkerId, msgKey, seqno }) {
  const identity = msgKey ? String(msgKey) : (seqno ? `seq:${seqno}` : '');
  if (!identity) fail('DM_MESSAGE_ID_INVALID', '消息缺少可用 ID');
  return [robotKey, accountUid, sessionType, talkerId, identity]
    .map((part) => encodeURIComponent(keyPart(part, '消息键'))).join('|');
}

export function normalizeTargetKind(value, fallback = 'c2c') {
  if (value === undefined || value === null || value === '') return fallback;
  if (value !== 'c2c' && value !== 'group') fail('DM_STATE_CORRUPT', '通知目标类型不合法');
  return value;
}

export function makeSegmentKey({
  messageKey, bindingVersion, target, index, targetKind = 'c2c',
}) {
  const version = Number(bindingVersion);
  const position = Number(index);
  if (!Number.isSafeInteger(version) || version < 0 || !Number.isSafeInteger(position) || position < 0) {
    fail('DM_STATE_CORRUPT', '分段序号不合法');
  }
  const kind = normalizeTargetKind(targetKind);
  const encode = (value, name) => {
    const text = String(value ?? '');
    if (!text || text.length > 2048 || /[\u0000-\u001f]/.test(text)) fail('DM_STATE_CORRUPT', `${name} 格式不合法`);
    return encodeURIComponent(text);
  };
  const parts = [encode(messageKey, '消息键'), version];
  if (kind === 'group') parts.push('kind:group');
  parts.push(encodeURIComponent(keyPart(target, '通知目标')), position);
  return parts.join('|');
}

export function makeRequestId({
  robotKey, accountUid, target, bindingVersion, messageKey, index, purpose = 'dm', targetKind = 'c2c',
}) {
  const kind = normalizeTargetKind(targetKind);
  const parts = [purpose, robotKey, accountUid, target, bindingVersion, messageKey, index];
  if (kind === 'group') parts.push('kind:group');
  return `bili-dm:${createHash('sha256')
    .update(parts.join('\0'))
    .digest('hex').slice(0, 40)}`;
}

function safeAssign(target, key, value) {
  if (UNSAFE_KEYS.has(key)) fail('DM_STATE_CORRUPT', '状态包含不允许的键');
  target[key] = value;
}

function assertSafeTree(value, depth = 0, count = { n: 0 }) {
  if (depth > 64 || ++count.n > 200000) fail('DM_STATE_CORRUPT', '状态结构超过安全上限');
  if (Array.isArray(value)) {
    for (const item of value) assertSafeTree(item, depth + 1, count);
    return;
  }
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(key)) fail('DM_STATE_CORRUPT', '状态包含不允许的键');
      assertSafeTree(child, depth + 1, count);
    }
  }
}

export function createEmptyState(robotKey, now = Date.now()) {
  const robot = keyPart(robotKey, '机器人标识');
  return {
    schemaVersion: SCHEMA_VERSION,
    robotKey: robot,
    createdAt: now,
    updatedAt: now,
    currentUid: null,
    binding: {
      target: null, version: 0, updatedAt: null, notifyKind: 'c2c', groupTarget: '', groupName: '',
    },
    deliveryRate: { calls: [], windowMs: RATE_WINDOW_MS },
    accounts: {},
    notifications: [],
    notificationSeq: 0,
  };
}

function ensureAccount(state, uid, now) {
  const key = keyPart(uid, '账号 UID');
  if (!state.accounts[key]) {
    safeAssign(state.accounts, key, {
      uid: key,
      createdAt: now,
      updatedAt: now,
      discovery: {
        phase: 'idle',
        baselineComplete: false,
        baselineStartedAt: null,
        monitorStartTs: null,
        endTs: null,
        scanActive: false,
        pages: 0,
        sessionCount: 0,
        scannedAt: null,
        gap: null,
        lastServerTime: null,
      },
      conversations: {},
      messages: {},
      segments: {},
    });
  }
  return state.accounts[key];
}

export function ensureConversation(account, { talkerId, sessionType, high, baseline, now }) {
  const key = conversationKey(sessionType, talkerId);
  let conversation = account.conversations[key];
  if (!conversation) {
    conversation = {
      key,
      talkerId: String(talkerId),
      sessionType: Number(sessionType),
      firstHigh: high || null,
      lastHigh: high || null,
      committed: baseline ? (high || '0') : '0',
      dedupeThrough: baseline ? (high || '0') : '0',
      baseline,
      newAfterBaseline: !baseline,
      pending: null,
      gap: null,
      createdAt: now,
      updatedAt: now,
    };
    safeAssign(account.conversations, key, conversation);
  }
  return conversation;
}

export function countUnfinished(state) {
  let count = 0;
  for (const account of Object.values(state.accounts || {})) {
    for (const message of Object.values(account.messages || {})) {
      if (message?.status !== 'sent' && message?.status !== 'suppressed') count += 1;
    }
    for (const conversation of Object.values(account.conversations || {})) {
      if (Array.isArray(conversation?.pending?.gathered)) count += conversation.pending.gathered.length;
    }
  }
  return count;
}

function assertCapacity(state, maxUnfinished, maxFileBytes) {
  if (countUnfinished(state) > maxUnfinished) fail('DM_CAPACITY', '待投递私信数量已达上限');
  if (Buffer.byteLength(JSON.stringify(state)) > maxFileBytes) fail('DM_CAPACITY', '私信状态文件已达上限');
}

const CONVERSATION_SESSION_TYPES = new Set([1, 2]);
const MESSAGE_STATUSES = new Set(['unfinished', 'sent', 'suppressed']);
const SEGMENT_STATES = new Set(['planned', 'sending', 'sent', 'failed', 'pending', 'unknown', 'superseded']);
const TARGET_KINDS = new Set(['c2c', 'group']);
const SAFE_PLACEHOLDER_STATES = new Set([
  'state_only', 'unsupported', 'content_parse_failed', 'content_too_large',
  'content_invalid', 'message_id_invalid',
]);

function isNonNegativeInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteTime(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNullableTime(value) {
  return value === null || isFiniteTime(value);
}

function isSeqOrNull(value) {
  return value === null || isSafeSeq(value);
}

function requireBoundedText(value, name, max = 512) {
  if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001f]/.test(value)) {
    fail('DM_STATE_CORRUPT', `${name} 格式不合法`);
  }
  return value;
}

function optionalBoundedText(value, name, max = 512) {
  if (value === undefined || value === null || value === '') return '';
  requireBoundedText(value, name, max);
  return value;
}

function isCanonicalId(value) {
  return typeof value === 'string' && isSafeSeq(value);
}

function requireCanonicalId(value, name) {
  if (!isCanonicalId(value)) fail('DM_STATE_CORRUPT', `${name} 不合法`);
  return value;
}

function requireMessageIdentity(value, seqno, name = '私信记录消息标识') {
  if (isCanonicalId(value)) return value;
  if (value === `seq:${seqno}` && isSafeSeq(seqno)) return value;
  fail('DM_STATE_CORRUPT', `${name} 不合法`);
}

function requireLinkList(value, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    fail('DM_STATE_CORRUPT', `${name} 不合法`);
  }
  return value;
}

function validatePrivateRecordCore(record, accountUid, { staged = false } = {}) {
  if (!isObject(record)) fail('DM_STATE_CORRUPT', '私信记录结构不合法');
  if (record.accountUid !== accountUid) fail('DM_STATE_CORRUPT', '私信记录账号不匹配');
  if (!isSafeSeq(record.seqno)) fail('DM_STATE_CORRUPT', '私信记录序号不合法');
  if (!CONVERSATION_SESSION_TYPES.has(record.sessionType)) {
    fail('DM_STATE_CORRUPT', '私信记录会话类型不合法');
  }
  requireCanonicalId(record.talkerId, '私信记录会话 ID');
  requireMessageIdentity(record.messageId, record.seqno);
  if (record.msgKey !== undefined && record.msgKey !== null && record.msgKey !== '') {
    requireCanonicalId(record.msgKey, '私信记录消息键');
  }
  if (typeof record.senderUid !== 'string') fail('DM_STATE_CORRUPT', '私信记录发送者不合法');
  if (record.senderUid) requireCanonicalId(record.senderUid, '私信记录发送者');
  else if (record.type !== 'state' && !SAFE_PLACEHOLDER_STATES.has(record.sourceStatus)) {
    fail('DM_STATE_CORRUPT', '私信记录缺少发送者');
  }
  if (typeof record.senderName !== 'string') fail('DM_STATE_CORRUPT', '私信记录发送者名称不合法');
  if (typeof record.text !== 'string') fail('DM_STATE_CORRUPT', '私信记录正文不合法');
  if (typeof record.type !== 'string' || !record.type) fail('DM_STATE_CORRUPT', '私信记录类型不合法');
  if (!isFiniteTime(record.sentAt)) fail('DM_STATE_CORRUPT', '私信记录时间不合法');
  requireLinkList(record.imageUrls, '私信记录图片');
  requireLinkList(record.shareUrls, '私信记录链接');
  if (record.rawType !== undefined && !isNonNegativeInt(record.rawType)) {
    fail('DM_STATE_CORRUPT', '私信记录原始类型不合法');
  }
  if (record.sourceStatus !== undefined && typeof record.sourceStatus !== 'string') {
    fail('DM_STATE_CORRUPT', '私信记录来源状态不合法');
  }
  if (record.fatal !== undefined && typeof record.fatal !== 'boolean') {
    fail('DM_STATE_CORRUPT', '私信记录致命标记不合法');
  }
  if (record.parseFailure !== undefined && typeof record.parseFailure !== 'boolean') {
    fail('DM_STATE_CORRUPT', '私信记录解析标记不合法');
  }
  if (record.robotKey !== undefined && typeof record.robotKey !== 'string') {
    fail('DM_STATE_CORRUPT', '私信记录机器人标识不合法');
  }
  if (record.recallTarget !== undefined) optionalBoundedText(record.recallTarget, '私信记录撤回目标', 512);
  if (!staged && record.status !== undefined) {
    if (!MESSAGE_STATUSES.has(record.status)) fail('DM_STATE_CORRUPT', '私信记录状态不合法');
  }
  if (record.deliveryState !== undefined && typeof record.deliveryState !== 'string') {
    fail('DM_STATE_CORRUPT', '私信记录投递状态不合法');
  }
  if (record.suppressedAt !== undefined && !isNullableTime(record.suppressedAt)) {
    fail('DM_STATE_CORRUPT', '私信记录抑制时间不合法');
  }
  if (record.synthetic !== undefined && typeof record.synthetic !== 'boolean') {
    fail('DM_STATE_CORRUPT', '私信记录合成标记不合法');
  }
}

function validateGap(gap, name) {
  if (gap === null || gap === undefined) return;
  if (!isObject(gap)) fail('DM_STATE_CORRUPT', `${name} 格式不合法`);
  if (typeof gap.code !== 'string' || !gap.code) fail('DM_STATE_CORRUPT', `${name} 缺少错误码`);
  if (gap.at !== undefined && gap.at !== null && !isFiniteTime(gap.at)) {
    fail('DM_STATE_CORRUPT', `${name} 时间不合法`);
  }
  if (gap.endTs !== undefined && gap.endTs !== null && !isSafeSeq(gap.endTs)) {
    fail('DM_STATE_CORRUPT', `${name} 游标不合法`);
  }
}

function validateDiscovery(discovery) {
  if (!isObject(discovery)) fail('DM_STATE_CORRUPT', '私信发现状态结构不合法');
  if (typeof discovery.phase !== 'string' || !discovery.phase) {
    fail('DM_STATE_CORRUPT', '私信发现阶段不合法');
  }
  if (typeof discovery.baselineComplete !== 'boolean') {
    fail('DM_STATE_CORRUPT', '私信基线状态不合法');
  }
  if (typeof discovery.scanActive !== 'boolean') {
    fail('DM_STATE_CORRUPT', '私信扫描状态不合法');
  }
  if (!isNonNegativeInt(discovery.pages) || !isNonNegativeInt(discovery.sessionCount)) {
    fail('DM_STATE_CORRUPT', '私信发现计数不合法');
  }
  if (!isNullableTime(discovery.baselineStartedAt)
    || !isNullableTime(discovery.monitorStartTs)
    || !isNullableTime(discovery.lastServerTime)
    || !isNullableTime(discovery.scannedAt)) {
    fail('DM_STATE_CORRUPT', '私信发现时间不合法');
  }
  if (discovery.lastScanAt !== undefined && !isNullableTime(discovery.lastScanAt)) {
    fail('DM_STATE_CORRUPT', '私信扫描时间不合法');
  }
  if (discovery.updatedAt !== undefined && !isFiniteTime(discovery.updatedAt)) {
    fail('DM_STATE_CORRUPT', '私信发现更新时间不合法');
  }
  if (discovery.endTs !== undefined && discovery.endTs !== null && !isSafeSeq(discovery.endTs)) {
    fail('DM_STATE_CORRUPT', '私信发现游标不合法');
  }
  validateGap(discovery.gap, '私信发现异常状态');
}

function validateGathered(record, accountUid) {
  validatePrivateRecordCore(record, accountUid, { staged: true });
  if (record.messageId === undefined) fail('DM_STATE_CORRUPT', '私信暂存记录缺少标识');
  if (record.fatal === true) fail('DM_STATE_CORRUPT', '私信暂存记录不可为致命失败');
}

function validatePending(pending, accountUid) {
  if (!isObject(pending)) fail('DM_STATE_CORRUPT', '私信续拉数据不合法');
  if (pending.mode !== 'new' && pending.mode !== 'range') {
    fail('DM_STATE_CORRUPT', '私信续拉模式不合法');
  }
  if (!isSafeSeq(pending.targetHigh) || !isSafeSeq(pending.endSeqno)) {
    fail('DM_STATE_CORRUPT', '私信续拉游标不合法');
  }
  if (pending.pageMin !== null && pending.pageMin !== undefined && !isSafeSeq(pending.pageMin)) {
    fail('DM_STATE_CORRUPT', '私信续拉页边界不合法');
  }
  if (!isNonNegativeInt(pending.pageCount)) fail('DM_STATE_CORRUPT', '私信续拉页计数不合法');
  if (!Array.isArray(pending.gathered)) fail('DM_STATE_CORRUPT', '私信续拉暂存不合法');
  for (const record of pending.gathered) validateGathered(record, accountUid);
  if (pending.filterFromTs !== null && pending.filterFromTs !== undefined
    && !isFiniteTime(pending.filterFromTs)) {
    fail('DM_STATE_CORRUPT', '私信续拉过滤时间不合法');
  }
  if (pending.startedAt !== undefined && !isFiniteTime(pending.startedAt)) {
    fail('DM_STATE_CORRUPT', '私信续拉开始时间不合法');
  }
  if (pending.gap !== null && pending.gap !== undefined && typeof pending.gap !== 'string') {
    fail('DM_STATE_CORRUPT', '私信续拉异常状态不合法');
  }
}

function validateConversation(key, conversation, accountUid) {
  if (!isObject(conversation)) fail('DM_STATE_CORRUPT', '私信会话结构不合法');
  if (conversation.key !== key) fail('DM_STATE_CORRUPT', '私信会话结构不合法');
  if (typeof conversation.talkerId !== 'string' || !conversation.talkerId) {
    fail('DM_STATE_CORRUPT', '私信会话 ID 不合法');
  }
  if (!CONVERSATION_SESSION_TYPES.has(conversation.sessionType)) {
    fail('DM_STATE_CORRUPT', '私信会话类型不合法');
  }
  if (key !== `${conversation.sessionType}:${conversation.talkerId}`) {
    fail('DM_STATE_CORRUPT', '私信会话键不匹配');
  }
  if (!isSeqOrNull(conversation.firstHigh) || !isSeqOrNull(conversation.lastHigh)) {
    fail('DM_STATE_CORRUPT', '私信会话水位不合法');
  }
  if (!isSafeSeq(conversation.committed)) {
    fail('DM_STATE_CORRUPT', '私信会话提交游标不合法');
  }
  if (!isSafeSeq(conversation.dedupeThrough)) {
    fail('DM_STATE_CORRUPT', '私信会话去重水位不合法');
  }
  if (typeof conversation.baseline !== 'boolean' || typeof conversation.newAfterBaseline !== 'boolean') {
    fail('DM_STATE_CORRUPT', '私信会话基线状态不合法');
  }
  if (!isFiniteTime(conversation.createdAt) || !isFiniteTime(conversation.updatedAt)) {
    fail('DM_STATE_CORRUPT', '私信会话时间不合法');
  }
  if (conversation.lastSeenAt !== undefined && !isFiniteTime(conversation.lastSeenAt)) {
    fail('DM_STATE_CORRUPT', '私信会话最后出现时间不合法');
  }
  if (conversation.lastScanAt !== undefined && !isFiniteTime(conversation.lastScanAt)) {
    fail('DM_STATE_CORRUPT', '私信会话扫描时间不合法');
  }
  if (conversation.pending !== null) validatePending(conversation.pending, accountUid);
  validateGap(conversation.gap, '私信会话异常状态');
}

function validateMessage(key, message, accountUid, robotKey) {
  validatePrivateRecordCore(message, accountUid);
  if (message.key !== key) fail('DM_STATE_CORRUPT', '私信记录键不匹配');
  if (typeof key !== 'string' || !key || key.length > 2048) {
    fail('DM_STATE_CORRUPT', '私信记录键不合法');
  }
  if (!MESSAGE_STATUSES.has(message.status)) fail('DM_STATE_CORRUPT', '私信记录状态不合法');
  if (typeof message.conversationKey !== 'string' || !message.conversationKey
    || message.conversationKey.length > 512) {
    fail('DM_STATE_CORRUPT', '私信记录会话键不合法');
  }
  if (message.conversationKey !== `${message.sessionType}:${message.talkerId}`) {
    fail('DM_STATE_CORRUPT', '私信记录会话键不匹配');
  }
  if (!isFiniteTime(message.createdAt)) fail('DM_STATE_CORRUPT', '私信记录创建时间不合法');
  if (!isNullableTime(message.completedAt === undefined ? null : message.completedAt)) {
    fail('DM_STATE_CORRUPT', '私信记录完成时间不合法');
  }
  const expectedKey = makeMessageKey({
    robotKey,
    accountUid,
    sessionType: message.sessionType,
    talkerId: message.talkerId,
    msgKey: message.msgKey,
    seqno: message.seqno,
  });
  if (expectedKey !== key) fail('DM_STATE_CORRUPT', '私信记录业务键不一致');
}

function validateSegment(key, segment, account, robotKey) {
  if (!isObject(segment)) fail('DM_STATE_CORRUPT', '私信分段结构不合法');
  if (segment.key !== key) fail('DM_STATE_CORRUPT', '私信分段键不匹配');
  if (typeof segment.messageKey !== 'string' || !segment.messageKey) {
    fail('DM_STATE_CORRUPT', '私信分段缺少消息键');
  }
  if (!account.messages[segment.messageKey]) {
    fail('DM_STATE_CORRUPT', '私信分段引用不存在的消息');
  }
  if (segment.accountUid !== account.uid) fail('DM_STATE_CORRUPT', '私信分段账号不匹配');
  if (typeof segment.target !== 'string' || !segment.target || segment.target.length > 512) {
    fail('DM_STATE_CORRUPT', '私信分段目标不合法');
  }
  if (!TARGET_KINDS.has(segment.targetKind === undefined ? 'c2c' : segment.targetKind)) {
    fail('DM_STATE_CORRUPT', '私信分段目标类型不合法');
  }
  const targetKind = segment.targetKind === undefined ? 'c2c' : segment.targetKind;
  if (!isNonNegativeInt(segment.bindingVersion) || !isNonNegativeInt(segment.index)) {
    fail('DM_STATE_CORRUPT', '私信分段序号不合法');
  }
  if (!isNonNegativeInt(segment.total) || segment.total < 1 || segment.index >= segment.total) {
    fail('DM_STATE_CORRUPT', '私信分段总数不合法');
  }
  if (typeof segment.body !== 'string') fail('DM_STATE_CORRUPT', '私信分段正文不合法');
  if (typeof segment.requestId !== 'string' || !segment.requestId) {
    fail('DM_STATE_CORRUPT', '私信分段请求标识不合法');
  }
  if (!SEGMENT_STATES.has(segment.state)) fail('DM_STATE_CORRUPT', '私信分段状态不合法');
  if (!isNonNegativeInt(segment.attempts)) fail('DM_STATE_CORRUPT', '私信分段尝试次数不合法');
  if (!isFiniteTime(segment.createdAt) || !isFiniteTime(segment.updatedAt)
    || !isFiniteTime(segment.nextRetryAt)) {
    fail('DM_STATE_CORRUPT', '私信分段时间不合法');
  }
  if (segment.lastErrorCode !== undefined && typeof segment.lastErrorCode !== 'string') {
    fail('DM_STATE_CORRUPT', '私信分段错误码不合法');
  }
  if (!isNullableTime(segment.sentAt === undefined ? null : segment.sentAt)) {
    fail('DM_STATE_CORRUPT', '私信分段发送时间不合法');
  }
  if (segment.supersededBy !== undefined && typeof segment.supersededBy !== 'string') {
    fail('DM_STATE_CORRUPT', '私信分段替代标识不合法');
  }
  const expectedKey = makeSegmentKey({
    messageKey: segment.messageKey,
    bindingVersion: segment.bindingVersion,
    target: segment.target,
    index: segment.index,
    targetKind,
  });
  if (expectedKey !== key) fail('DM_STATE_CORRUPT', '私信分段键不一致');
  const expectedRequest = makeRequestId({
    robotKey,
    accountUid: account.uid,
    target: segment.target,
    bindingVersion: segment.bindingVersion,
    messageKey: segment.messageKey,
    index: segment.index,
    targetKind,
  });
  if (segment.requestId !== expectedRequest) fail('DM_STATE_CORRUPT', '私信分段请求标识不一致');
}

function validateAccount(uid, account, robotKey) {
  if (!isObject(account)) fail('DM_STATE_CORRUPT', '私信状态账号结构不合法');
  if (account.uid !== uid) fail('DM_STATE_CORRUPT', '私信状态账号标识不匹配');
  if (!isFiniteTime(account.createdAt) || !isFiniteTime(account.updatedAt)) {
    fail('DM_STATE_CORRUPT', '私信状态账号时间不合法');
  }
  if (!isObject(account.messages) || !isObject(account.conversations) || !isObject(account.segments)) {
    fail('DM_STATE_CORRUPT', '私信状态账号结构不合法');
  }
  validateDiscovery(account.discovery);
  for (const [key, conversation] of Object.entries(account.conversations)) {
    validateConversation(key, conversation, uid);
  }
  for (const [key, message] of Object.entries(account.messages)) {
    validateMessage(key, message, uid, robotKey);
  }
  for (const [key, segment] of Object.entries(account.segments)) {
    validateSegment(key, segment, account, robotKey);
  }
}

function validateNotification(row, index) {
  if (!isObject(row)) fail('DM_STATE_CORRUPT', '通知记录结构不合法');
  if (row.id !== undefined && (!isNonNegativeInt(row.id) || row.id < 1)) {
    fail('DM_STATE_CORRUPT', '通知记录编号不合法');
  }
  requireBoundedText(row.key, '通知记录键', 2048);
  requireBoundedText(row.target, '通知记录目标', 512);
  if (!TARGET_KINDS.has(row.targetKind === undefined ? 'c2c' : row.targetKind)) {
    fail('DM_STATE_CORRUPT', '通知记录目标类型不合法');
  }
  if (!isNonNegativeInt(row.bindingVersion)) fail('DM_STATE_CORRUPT', '通知记录版本不合法');
  if (typeof row.body !== 'string') fail('DM_STATE_CORRUPT', '通知记录正文不合法');
  requireBoundedText(row.requestId, '通知记录请求标识', 512);
  if (!SEGMENT_STATES.has(row.state)) fail('DM_STATE_CORRUPT', '通知记录状态不合法');
  if (!isNonNegativeInt(row.attempts)) fail('DM_STATE_CORRUPT', '通知记录尝试次数不合法');
  if (!isFiniteTime(row.createdAt) || !isFiniteTime(row.updatedAt) || !isFiniteTime(row.nextRetryAt)) {
    fail('DM_STATE_CORRUPT', '通知记录时间不合法');
  }
  if (row.lastErrorCode !== undefined && (typeof row.lastErrorCode !== 'string'
    || row.lastErrorCode.length > 128)) {
    fail('DM_STATE_CORRUPT', '通知记录错误码不合法');
  }
  if (!isNullableTime(row.sentAt === undefined ? null : row.sentAt)) {
    fail('DM_STATE_CORRUPT', '通知记录发送时间不合法');
  }
  if (row.noticeCode !== undefined) optionalBoundedText(row.noticeCode, '通知记录状态码', 64);
  if (row.index !== undefined && (!isNonNegativeInt(row.index))) {
    fail('DM_STATE_CORRUPT', '通知记录序号不合法');
  }
  return index;
}

function applyStateDefaults(state) {
  const binding = state.binding;
  if (binding.notifyKind === undefined) binding.notifyKind = 'c2c';
  if (binding.groupTarget === undefined) binding.groupTarget = '';
  if (binding.groupName === undefined) binding.groupName = '';
  if (!Array.isArray(state.notifications)) state.notifications = [];
  let seq = isNonNegativeInt(state.notificationSeq) ? state.notificationSeq : 0;
  for (const row of state.notifications) {
    if (row.targetKind === undefined) row.targetKind = 'c2c';
    if (!isNonNegativeInt(row.id) || row.id < 1) {
      seq += 1;
      row.id = seq;
    } else if (row.id > seq) {
      seq = row.id;
    }
  }
  state.notificationSeq = seq;
}

function validateState(state) {
  if (!isObject(state)) fail('DM_STATE_CORRUPT', '私信状态必须是对象');
  if (state.schemaVersion !== SCHEMA_VERSION) {
    const code = typeof state.schemaVersion === 'number' && state.schemaVersion > SCHEMA_VERSION
      ? 'DM_STATE_UNSUPPORTED' : 'DM_STATE_CORRUPT';
    fail(code, '私信状态版本不受支持');
  }
  if (typeof state.robotKey !== 'string' || !state.robotKey || state.robotKey.length > 512
    || /[\u0000-\u001f]/.test(state.robotKey)) {
    fail('DM_STATE_CORRUPT', '私信状态机器人标识不合法');
  }
  if (!isFiniteTime(state.createdAt) || !isFiniteTime(state.updatedAt)) {
    fail('DM_STATE_CORRUPT', '私信状态时间不合法');
  }
  if (!isObject(state.accounts) || !isObject(state.binding) || !isObject(state.deliveryRate)) {
    fail('DM_STATE_CORRUPT', '私信状态结构不完整');
  }
  assertSafeTree(state);
  if (state.currentUid !== null && !isSafeSeq(state.currentUid)) {
    fail('DM_STATE_CORRUPT', '私信状态当前账号不合法');
  }
  if (state.binding.target !== null) requireBoundedText(state.binding.target, '通知目标');
  if (!isNonNegativeInt(state.binding.version)) fail('DM_STATE_CORRUPT', '私信通知绑定版本不合法');
  if (!isNullableTime(state.binding.updatedAt)) fail('DM_STATE_CORRUPT', '私信通知绑定时间不合法');
  if (state.binding.notifyKind !== undefined && !TARGET_KINDS.has(state.binding.notifyKind)) {
    fail('DM_STATE_CORRUPT', '私信通知目标类型不合法');
  }
  if (state.binding.groupTarget !== undefined) {
    optionalBoundedText(state.binding.groupTarget, '私信通知群目标');
  }
  if (state.binding.groupName !== undefined) {
    optionalBoundedText(state.binding.groupName, '私信通知群名称', 128);
  }
  if (state.notifications !== undefined) {
    if (!Array.isArray(state.notifications)) fail('DM_STATE_CORRUPT', '通知记录集合不合法');
    if (state.notifications.length > MAX_NOTIFICATIONS) {
      fail('DM_STATE_CORRUPT', '通知记录数量超过上限');
    }
    const keys = new Set();
    const ids = new Set();
    for (const [index, row] of state.notifications.entries()) {
      validateNotification(row, index);
      if (keys.has(row.key)) fail('DM_STATE_CORRUPT', '通知记录键重复');
      keys.add(row.key);
      if (row.id !== undefined) {
        if (ids.has(row.id)) fail('DM_STATE_CORRUPT', '通知记录编号重复');
        ids.add(row.id);
      }
    }
  }
  if (state.notificationSeq !== undefined && !isNonNegativeInt(state.notificationSeq)) {
    fail('DM_STATE_CORRUPT', '通知记录计数不合法');
  }
  if (!Array.isArray(state.deliveryRate.calls)) fail('DM_STATE_CORRUPT', '私信状态发送记录不合法');
  for (const call of state.deliveryRate.calls) {
    if (!isFiniteTime(call)) fail('DM_STATE_CORRUPT', '私信状态发送记录不合法');
  }
  if (!isFiniteTime(state.deliveryRate.windowMs) || state.deliveryRate.windowMs <= 0) {
    fail('DM_STATE_CORRUPT', '私信状态发送窗口不合法');
  }
  for (const [uid, account] of Object.entries(state.accounts)) {
    if (!isSafeSeq(uid)) fail('DM_STATE_CORRUPT', '私信状态账号不合法');
    validateAccount(uid, account, state.robotKey);
  }
  if (state.currentUid !== null && !state.accounts[state.currentUid]) {
    fail('DM_STATE_CORRUPT', '私信状态当前账号不存在');
  }
}

function defaultIo(io) {
  const custom = isObject(io) && Object.keys(io).length > 0;
  return {
    readFile: io?.readFile?.bind(io) || fsDefault.readFile,
    writeFile: io?.writeFile?.bind(io) || fsDefault.writeFile,
    rename: io?.rename?.bind(io) || fsDefault.rename,
    unlink: io?.unlink?.bind(io) || fsDefault.unlink,
    mkdir: io?.mkdir?.bind(io) || fsDefault.mkdir,
    stat: io?.stat?.bind(io) || (custom ? null : fsDefault.stat),
  };
}

export function createBiliDmStore({
  dataDir, robotKey, fs = {}, beforeLoad, initialBarrier, isActive = () => true,
  now = () => Date.now(), file = STATE_FILE, maxUnfinished = MAX_UNFINISHED,
  maxFileBytes = MAX_FILE_BYTES, completedRetentionMs = COMPLETED_RETENTION_MS,
  maxSendsPerWindow = RATE_MAX_CALLS, rateWindowMs = RATE_WINDOW_MS,
} = {}) {
  if (!dataDir) throw new TypeError('createBiliDmStore requires dataDir');
  const robot = keyPart(robotKey, '机器人标识');
  const filePath = path.join(dataDir, file);
  const io = defaultIo(fs);
  const limitUnfinished = Math.max(1, Number(maxUnfinished) || MAX_UNFINISHED);
  const limitBytes = Math.max(1024, Number(maxFileBytes) || MAX_FILE_BYTES);
  const maxSends = Math.max(1, Number(maxSendsPerWindow) || RATE_MAX_CALLS);
  const windowMs = Math.max(1000, Number(rateWindowMs) || RATE_WINDOW_MS);

  let state = null;
  let loadError = null;
  let tail = Promise.resolve();
  let tempSeq = 0;

  const assertGuard = (guard) => {
    if (!isActive()) fail('DM_STALE', '私信任务已失效');
    if (guard !== undefined) {
      let ok = false;
      try { ok = typeof guard === 'function' && guard() === true; } catch { ok = false; }
      if (!ok) fail('DM_STALE', '私信状态写入已失效');
    }
  };

  function enqueue(fn) {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  }

  async function persist(draft, guard) {
    let text;
    try {
      text = JSON.stringify(draft) + '\n';
    } catch (error) {
      fail('DM_STATE_CORRUPT', '私信状态无法序列化', { cause: error });
    }
    if (Buffer.byteLength(text) > limitBytes) fail('DM_CAPACITY', '私信状态文件已达上限');
    assertGuard(guard);
    let temp = '';
    try {
      await io.mkdir(path.dirname(filePath), { recursive: true });
      temp = `${filePath}.${process.pid}.${now()}.${tempSeq += 1}.${randomUUID()}.tmp`;
      await io.writeFile(temp, text, { encoding: 'utf8', mode: 0o600 });
      assertGuard(guard);
      await io.rename(temp, filePath);
      temp = '';
    } catch (error) {
      if (error instanceof BiliDmStoreError) throw error;
      fail('DM_WRITE_FAILED', '私信状态写入失败', { cause: error });
    } finally {
      if (temp) {
        try { await io.unlink(temp); } catch { /* cleanup is best effort */ }
      }
    }
  }

  const ready = (async () => {
    if (initialBarrier) await initialBarrier;
    if (beforeLoad) await beforeLoad;
    assertGuard();
    let text;
    try {
      if (io.stat) {
        let info = null;
        try {
          info = await io.stat(filePath);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        if (info && Number.isFinite(info.size) && info.size > limitBytes) {
          fail('DM_STATE_CORRUPT', '私信状态文件超过安全上限，已保留原文件');
        }
      }
      const raw = await io.readFile(filePath, 'utf8');
      text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        state = createEmptyState(robot, now());
        return api;
      }
      if (error instanceof BiliDmStoreError) {
        loadError = error;
        throw error;
      }
      fail('DM_STATE_READ_FAILED', '私信状态读取失败', { cause: error });
    }
    if (Buffer.byteLength(text, 'utf8') > limitBytes) {
      fail('DM_STATE_CORRUPT', '私信状态文件超过安全上限，已保留原文件');
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      loadError = new BiliDmStoreError('DM_STATE_CORRUPT', '私信状态文件损坏，已保留原文件', { cause: error });
      throw loadError;
    }
    try {
      validateState(parsed);
      if (parsed.robotKey !== robot) {
        fail('DM_STATE_CORRUPT', '私信状态不属于当前机器人');
      }
      applyStateDefaults(parsed);
      assertCapacity(parsed, limitUnfinished, limitBytes);
    } catch (error) {
      loadError = error instanceof BiliDmStoreError
        ? error : new BiliDmStoreError('DM_STATE_CORRUPT', '私信状态文件损坏，已保留原文件', { cause: error });
      throw loadError;
    }
    state = parsed;
    return api;
  })().catch((error) => {
    loadError = error instanceof BiliDmStoreError
      ? error : new BiliDmStoreError('DM_STATE_READ_FAILED', '私信状态读取失败', { cause: error });
    throw loadError;
  });

  function transaction(mutator, { guard } = {}) {
    if (typeof mutator !== 'function') throw new TypeError('transaction requires a mutator');
    return enqueue(async () => {
      await ready;
      assertGuard(guard);
      const draft = clone(state);
      draft.robotKey = robot;
      const result = await mutator(draft);
      assertGuard(guard);
      draft.schemaVersion = SCHEMA_VERSION;
      draft.updatedAt = now();
      validateState(draft);
      assertCapacity(draft, limitUnfinished, limitBytes);
      await persist(draft, guard);
      state = draft;
      return clone(result);
    });
  }

  function read(fn) {
    if (!state) {
      if (loadError) throw loadError;
      fail('DM_STATE_NOT_READY', '私信状态尚未加载');
    }
    return fn(state);
  }

  function bind(target, { guard } = {}) {
    const value = String(target ?? '');
    if (!value || value.length > 512 || /[\u0000-\u001f\r\n]/.test(value)) {
      return Promise.reject(new BiliDmStoreError('DM_BINDING_INVALID', '通知目标格式不合法'));
    }
    return transaction((draft) => {
      const binding = draft.binding;
      if (binding.notifyKind === undefined) binding.notifyKind = 'c2c';
      if (binding.groupTarget === undefined) binding.groupTarget = '';
      if (binding.groupName === undefined) binding.groupName = '';
      if (binding.target !== value) {
        binding.target = value;
        binding.version = (Number(binding.version) || 0) + 1;
        binding.updatedAt = now();
      }
      return binding;
    }, { guard });
  }

  function setCurrentUid(uid, { guard } = {}) {
    const value = String(uid ?? '');
    if (!/^\d+$/.test(value)) {
      return Promise.reject(new BiliDmStoreError('DM_ACCOUNT_INVALID', '账号 UID 不合法'));
    }
    return transaction((draft) => {
      ensureAccount(draft, value, now());
      draft.currentUid = value;
      return { uid: value, binding: draft.binding };
    }, { guard });
  }

  function reserveSendCall({ guard, at = now() } = {}) {
    return transaction((draft) => {
      const nowMs = Number(at);
      const recent = (draft.deliveryRate.calls || [])
        .map(Number).filter((value) => Number.isFinite(value) && nowMs - value < windowMs);
      if (recent.length >= maxSends) {
        const retryAfterMs = Math.max(0, windowMs - (nowMs - Math.min(...recent)));
        throw new BiliDmStoreError('DM_RATE_LIMIT', '主动发送频率已达上限', { retryAfterMs });
      }
      recent.push(nowMs);
      draft.deliveryRate.calls = recent;
      draft.deliveryRate.windowMs = windowMs;
      return { used: recent.length, remaining: maxSends - recent.length, at: nowMs };
    }, { guard });
  }

  function rateInfo(at = now()) {
    return read((current) => {
      const recent = (current.deliveryRate.calls || [])
        .map(Number).filter((value) => Number.isFinite(value) && at - value < windowMs);
      return {
        used: recent.length,
        remaining: Math.max(0, maxSends - recent.length),
        nextAt: recent.length >= maxSends ? Math.min(...recent) + windowMs : at,
      };
    });
  }

  function prune(at = now(), options = {}) {
    if (isObject(at)) {
      options = at;
      at = now();
    }
    const { guard } = isObject(options) ? options : {};
    return transaction((draft) => {
      const cutoff = Number(at) - completedRetentionMs;
      let removed = 0;
      for (const account of Object.values(draft.accounts)) {
        for (const [key, message] of Object.entries(account.messages)) {
          const sentOld = message?.status === 'sent' && message.completedAt
            && Number(message.completedAt) <= cutoff;
          const suppressedOld = message?.status === 'suppressed' && message.suppressedAt
            && Number(message.suppressedAt) <= cutoff;
          if (!sentOld && !suppressedOld) continue;
          if (sentOld) {
            const conversation = account.conversations[message.conversationKey];
            if (conversation && message.seqno && compareSeq(message.seqno, conversation.dedupeThrough || '0') > 0) {
              conversation.dedupeThrough = message.seqno;
            }
          }
          delete account.messages[key];
          for (const [segmentKey, segment] of Object.entries(account.segments)) {
            if (segment.messageKey === key) delete account.segments[segmentKey];
          }
          removed += 1;
        }
        for (const [key, segment] of Object.entries(account.segments)) {
          if (segment.state === 'superseded' && Number(segment.updatedAt) <= cutoff) delete account.segments[key];
        }
      }
      if (Array.isArray(draft.notifications)) {
        draft.notifications = draft.notifications.filter((row) => {
          if (!row) return false;
          if (row.state === 'sent') {
            return Number(row.sentAt ?? row.updatedAt ?? 0) > cutoff;
          }
          if (row.state === 'superseded') {
            return Number(row.updatedAt ?? 0) > cutoff;
          }
          return true;
        });
      }
      return { removed };
    }, { guard });
  }

  function statusCounters() {
    return read((current) => {
      const out = {
        messages: 0, sent: 0, unfinished: 0, suppressed: 0,
        segments: 0, planned: 0, sending: 0, pending: 0, unknown: 0, failed: 0, superseded: 0,
        conversations: 0, pendingConversations: 0, gapConversations: 0,
        bytes: Buffer.byteLength(JSON.stringify(current)),
      };
      for (const account of Object.values(current.accounts)) {
        out.conversations += Object.keys(account.conversations || {}).length;
        for (const conversation of Object.values(account.conversations || {})) {
          if (conversation.pending) out.pendingConversations += 1;
          if (conversation.gap) out.gapConversations += 1;
        }
        for (const message of Object.values(account.messages || {})) {
          out.messages += 1;
          if (message.status === 'sent') out.sent += 1;
          else if (message.status === 'suppressed') out.suppressed += 1;
          else out.unfinished += 1;
        }
        for (const segment of Object.values(account.segments || {})) {
          out.segments += 1;
          if (Object.prototype.hasOwnProperty.call(out, segment.state)) out[segment.state] += 1;
        }
      }
      return out;
    });
  }

  const api = {
    ready,
    filePath,
    transaction,
    read,
    flush: () => tail,
    bind,
    setCurrentUid,
    reserveSendCall,
    rateInfo,
    prune,
    statusCounters,
    current: () => read((value) => clone(value)),
    binding: () => read((value) => clone(value.binding)),
    loadError: () => loadError,
    limits: { maxUnfinished: limitUnfinished, maxFileBytes: limitBytes, maxSends, windowMs },
    ensureAccount: (uid, { guard } = {}) => transaction(
      (draft) => clone(ensureAccount(draft, uid, now())),
      { guard },
    ),
  };
  return api;
}
