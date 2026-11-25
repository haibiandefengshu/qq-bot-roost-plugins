import { createHash } from 'node:crypto';
import { canonicalId, parseLosslessJson } from './bili-client.js';

const CONTROL = /[\u0000-\u001f\u007f]/;
const SECRET_KEY = /(?:cookie|token|secret|password|passwd|auth|session|sign|ticket|access[_-]?key|api[_-]?key|csrf|sessdata|bili_jct|dedeuserid|bili_ticket|uid_ckmd5)/i;
const SECRET_VALUE = /(?:SESSDATA|bili_jct|DedeUserID|bearer\s|authorization|password|token=)/i;
const MAX_URL = 2048;
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_SHARE_TITLE_BYTES = 4096;
const MAX_SHARE_DESC_BYTES = 4096;
const MAX_SHARE_AUTHOR_BYTES = 512;
const RECALL_ID_RE = /^(0|[1-9]\d{0,39})$/;

const SHARE_SOURCE_URLS = new Map([
  [5, (id) => `https://www.bilibili.com/video/av${id}`],
  [6, (id) => `https://www.bilibili.com/read/cv${id}`],
  [7, (id) => `https://www.bilibili.com/bangumi/play/ss${id}`],
  [16, (id) => `https://www.bilibili.com/bangumi/play/ep${id}`],
  [17, (id) => `https://www.bilibili.com/bangumi/play/ss${id}`],
  [9, (id) => `https://www.bilibili.com/video/av${id}`],
  [11, (id) => `https://t.bilibili.com/${id}`],
]);

export function sanitizeUrl(value, { maxLength = MAX_URL } = {}) {
  if (typeof value !== 'string') return '';
  const raw = value.trim();
  if (!raw || raw.length > maxLength || CONTROL.test(raw)) return '';
  let url;
  try { url = new URL(raw); } catch { return ''; }
  if (!['http:', 'https:'].includes(url.protocol)) return '';
  if (url.username || url.password) return '';
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    const values = url.searchParams.getAll(key);
    if (SECRET_KEY.test(key) || values.some((item) => SECRET_VALUE.test(item))) {
      url.searchParams.delete(key);
    }
  }
  const result = url.href;
  if (!result || result.length > maxLength || CONTROL.test(result)) return '';
  return result;
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedField(value, maxBytes) {
  if (typeof value !== 'string') return { value: '', error: false };
  if (byteLength(value) > maxBytes) return { value: '', error: true };
  return { value, error: false };
}

function shapeExceeds(text, maxDepth, maxNodes) {
  let depth = 0;
  let nodes = 0;
  let inString = false;
  let escape = false;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') {
      depth += 1;
      nodes += 1;
      if (depth > maxDepth || nodes > maxNodes) return true;
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
    } else if (ch === ',') {
      nodes += 1;
      if (nodes > maxNodes) return true;
    }
  }
  return false;
}

function inspectObject(root, { maxBytes, maxDepth, maxNodes }) {
  let size;
  try {
    size = byteLength(JSON.stringify(root));
  } catch {
    return 'shape';
  }
  if (size > maxBytes) return 'size';
  let nodes = 0;
  let error = '';
  const walk = (node, depth) => {
    if (error) return;
    nodes += 1;
    if (depth > maxDepth || nodes > maxNodes) { error = 'shape'; return; }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (isObject(node)) {
      for (const [key, child] of Object.entries(node)) {
        if (UNSAFE_KEYS.has(key)) { error = 'dangerous'; return; }
        walk(child, depth + 1);
      }
    }
  };
  walk(root, 1);
  return error;
}

export function parseContent(value, {
  maxChars = 512 * 1024, maxBytes = maxChars, maxDepth = 16, maxNodes = 4000,
} = {}) {
  const byteLimit = Math.max(0, Math.floor(Number.isFinite(maxBytes) ? maxBytes : maxChars));
  if (value !== null && typeof value === 'object') {
    const error = inspectObject(value, { maxBytes: byteLimit, maxDepth, maxNodes });
    return error ? { value: null, error } : { value, error: null };
  }
  if (typeof value !== 'string') return { value: null, error: 'type' };
  if (byteLength(value) > byteLimit) return { value: null, error: 'size' };
  if (shapeExceeds(value, maxDepth, maxNodes)) return { value: null, error: 'shape' };
  try {
    return {
      value: parseLosslessJson(value, { maxBytes: byteLimit, maxDepth, maxNodes }),
      error: null,
    };
  } catch {
    return { value: null, error: 'parse' };
  }
}

function senderUidOf(raw) {
  try { return canonicalId(raw?.sender_uid); } catch { return ''; }
}

function seqOf(raw, fallbackSeqno) {
  const value = raw?.msg_seqno ?? fallbackSeqno;
  try { return canonicalId(value); } catch { return ''; }
}

function msgKeyOf(raw) {
  if (raw?.msg_key === undefined || raw?.msg_key === null || raw?.msg_key === '') return '';
  try { return canonicalId(raw.msg_key); } catch { return ''; }
}

function timestampOf(raw) {
  const value = raw?.timestamp;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d{1,12}$/.test(value)) return Number(value);
  return 0;
}

function typeOf(raw) {
  const value = raw?.msg_type;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  return -1;
}

function statusOf(raw) {
  const value = raw?.msg_status;
  let numeric = null;
  if (typeof value === 'number' && Number.isSafeInteger(value)) numeric = value;
  else if (typeof value === 'string' && /^(0|[1-9]\d{0,9})$/.test(value.trim())) numeric = Number(value);
  if (numeric === 0 || numeric === 1 || numeric === 2 || numeric === 50) return numeric;
  return null;
}

function stateOnlyText(raw, status) {
  if (raw?.sys_cancel === true) return '该消息已被系统撤回，仅显示状态。';
  if (status === 1) return '该消息已被撤回，仅显示状态。';
  if (status === 2) return '该消息已被系统撤回，仅显示状态。';
  if (status === 50) return '图片已失效，仅显示状态。';
  const type = typeOf(raw);
  if (type === 5) return '该消息已被撤回，仅显示状态。';
  if (type === 8) return '该消息已被系统撤回，仅显示状态。';
  if (status === null) return '消息状态无法确认，仅显示状态。';
  return '';
}

function recallTargetOf(raw) {
  const value = raw?.content;
  try {
    if (typeof value === 'number') return canonicalId(value);
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (RECALL_ID_RE.test(trimmed)) return trimmed;
      const parsed = parseLosslessJson(trimmed, { maxBytes: 256, maxDepth: 3, maxNodes: 8 });
      if (typeof parsed === 'number' || typeof parsed === 'string') return canonicalId(parsed);
    }
  } catch {
    return '';
  }
  return '';
}

function shareRecord({ title, description, url, author }) {
  const safeTitle = boundedField(title, MAX_SHARE_TITLE_BYTES);
  const safeDescription = boundedField(description, MAX_SHARE_DESC_BYTES);
  const safeAuthor = boundedField(author, MAX_SHARE_AUTHOR_BYTES);
  if (safeTitle.error || safeDescription.error || safeAuthor.error) {
    return { error: 'size' };
  }
  const safeUrl = sanitizeUrl(url);
  const lines = [];
  if (safeTitle.value) lines.push(`标题：${safeTitle.value}`);
  if (safeAuthor.value) lines.push(`作者：${safeAuthor.value}`);
  if (safeDescription.value) lines.push(`说明：${safeDescription.value}`);
  if (safeUrl) lines.push(`原链：${safeUrl}`);
  return {
    text: lines.join('\n') || '分享内容缺少可用信息，请到 B 站查看。',
    shareUrls: safeUrl ? [safeUrl] : [],
    imageUrls: [],
  };
}

function imageRecord(content, custom) {
  const url = sanitizeUrl(content?.url);
  const label = custom ? '表情原链' : '图片原链';
  return {
    text: url ? `${label}：${url}` : '图片链接不可安全展示，请到 B 站查看。',
    imageUrls: url ? [url] : [],
    shareUrls: [],
  };
}

function canonicalIdOrEmpty(value) {
  try { return canonicalId(value); } catch { return ''; }
}

function shareSourceUrl(content) {
  if (typeof content?.url === 'string') {
    const explicit = sanitizeUrl(content.url);
    if (explicit) return explicit;
  }
  const source = Number(content?.source);
  if (source === 5 && content?.bvid !== undefined && content?.bvid !== null && content?.bvid !== '') {
    const bvid = String(content.bvid);
    if (bvid.length <= 64 && !CONTROL.test(bvid)) {
      return `https://www.bilibili.com/video/${encodeURIComponent(bvid)}`;
    }
  }
  const id = canonicalIdOrEmpty(content?.id);
  const build = Number.isSafeInteger(source) ? SHARE_SOURCE_URLS.get(source) : null;
  return id && build ? build(id) : '';
}

export function normalizeMessage({
  raw, robotKey, accountUid, sessionType, talkerId, fallbackSeqno,
  maxContentChars = 512 * 1024, maxContentBytes = maxContentChars,
  maxTextChars = 512 * 1024, maxTextBytes = maxTextChars,
  maxDepth = 16, maxNodes = 4000,
} = {}) {
  const type = typeOf(raw);
  const status = statusOf(raw);
  const seqno = seqOf(raw, fallbackSeqno);
  const msgKey = msgKeyOf(raw);
  const senderUid = senderUidOf(raw);
  const sentAt = timestampOf(raw);
  const base = {
    accountUid: String(accountUid ?? ''),
    sessionType: Number(sessionType),
    talkerId: String(talkerId ?? ''),
    msgKey,
    seqno,
    messageId: msgKey || (seqno ? `seq:${seqno}` : ''),
    senderUid,
    senderName: '',
    sentAt,
    type: 'unsupported',
    rawType: type,
    text: '',
    imageUrls: [],
    shareUrls: [],
    sourceStatus: 'ok',
    fatal: false,
    parseFailure: false,
    robotKey: String(robotKey ?? ''),
    recallTarget: '',
  };
  if (!seqno) {
    return {
      ...base,
      fatal: true,
      sourceStatus: 'message_id_invalid',
      text: '消息缺少可用序列号，无法可靠去重。',
    };
  }
  const tooLarge = () => ({
    ...base,
    fatal: true,
    sourceStatus: 'content_too_large',
    text: '消息内容超过安全上限，未自动推进进度。',
  });
  const stateText = stateOnlyText(raw, status);
  if (stateText) {
    const recallTarget = (type === 5 || type === 8 || raw?.sys_cancel === true)
      ? recallTargetOf(raw)
      : '';
    return {
      ...base, type: 'state', text: stateText, sourceStatus: 'state_only', recallTarget,
    };
  }
  if (type < 0) {
    return {
      ...base,
      type: 'unsupported',
      text: '消息类型无法识别，请到 B 站查看。',
      sourceStatus: 'unsupported',
    };
  }

  const parsed = parseContent(raw?.content, {
    maxChars: maxContentChars, maxBytes: maxContentBytes, maxDepth, maxNodes,
  });
  if (parsed.error === 'size') return tooLarge();
  if (parsed.error === 'shape' || parsed.error === 'dangerous') {
    return {
      ...base,
      fatal: true,
      sourceStatus: 'content_invalid',
      text: '消息内容超过安全上限，未自动推进进度。',
    };
  }
  if (parsed.error) {
    return {
      ...base,
      parseFailure: true,
      type: 'text',
      text: '【消息内容无法解析】请到 B 站查看。',
      sourceStatus: 'content_parse_failed',
    };
  }
  const content = isObject(parsed.value) ? parsed.value : {};

  if (type === 1) {
    const text = typeof content.content === 'string' ? content.content : '';
    if (byteLength(text) > maxTextBytes) return tooLarge();
    return {
      ...base,
      type: 'text',
      text,
      sourceStatus: text.length ? 'ok' : 'empty',
    };
  }
  if (type === 2 || type === 6) {
    return { ...base, ...imageRecord(content, type === 6), type: type === 6 ? 'custom' : 'image' };
  }
  if (type === 7) {
    const share = shareRecord({
      title: content.title || content.headline,
      description: content.headline && content.headline !== content.title ? content.headline : '',
      url: shareSourceUrl(content),
      author: content.author,
    });
    if (share.error) return tooLarge();
    return { ...base, ...share, type: 'share' };
  }
  if (type === 11) {
    const url = content.bvid
      ? `https://www.bilibili.com/video/${encodeURIComponent(String(content.bvid))}`
      : (content.rid ? `https://www.bilibili.com/video/av${encodeURIComponent(String(content.rid))}` : '');
    const share = shareRecord({
      title: content.title,
      description: content.desc,
      url,
    });
    if (share.error) return tooLarge();
    return { ...base, ...share, type: 'video' };
  }
  if (type === 12) {
    const url = content.rid
      ? `https://www.bilibili.com/read/cv${encodeURIComponent(String(content.rid))}`
      : '';
    const share = shareRecord({
      title: content.title,
      description: content.summary,
      url,
      author: content.author,
    });
    if (share.error) return tooLarge();
    return { ...base, ...share, type: 'article' };
  }
  if (type === 13) {
    const image = sanitizeUrl(content.pic_url);
    const share = shareRecord({
      title: content.title,
      description: '',
      url: content.jump_url,
    });
    if (share.error) return tooLarge();
    return {
      ...base,
      ...share,
      type: 'image_card',
      imageUrls: image ? [image] : [],
      text: image ? `${share.text}\n图片原链：${image}` : share.text,
    };
  }
  if (type === 14) {
    const share = shareRecord({
      title: content.title,
      description: content.desc,
      url: content.url,
      author: content.author,
    });
    if (share.error) return tooLarge();
    return { ...base, ...share, type: 'share' };
  }
  if (type === 10) {
    const share = shareRecord({
      title: content.title,
      description: content.text,
      url: content.jump_uri || content.jump_uri_config?.all_uri,
    });
    if (share.error) return tooLarge();
    return { ...base, ...share, type: 'notification' };
  }
  return {
    ...base,
    type: 'unsupported',
    text: `暂不支持的消息类型（${type}），请到 B 站查看。`,
    sourceStatus: 'unsupported',
  };
}

export function shortMessageId(messageKey, length = 12) {
  const size = Number.isSafeInteger(length) && length > 0 ? Math.max(12, length) : 12;
  return createHash('sha256')
    .update(String(messageKey ?? ''))
    .digest('hex')
    .toUpperCase()
    .slice(0, size);
}

export { shapeExceeds };
