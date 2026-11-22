import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  assertActive, effectiveMaxBytes, insideRoot, resolveMediaFile, validateLocalFile, removeOwnedFile,
} from './files.js';
import { prepareAudio } from './voice.js';

// Verified against Roost message.js/outbound.js: replyNow does not split text.
export const TEXT_LIMIT = 1500;
export const MAX_PLAN_NODES = 512;
const MAX_DEPTH = 8;
const MAX_TEXT_BYTES = 1024 * 1024;
const SOFT_BYTES = { image: 20 * 1048576, video: 30 * 1048576, voice: 20 * 1048576 };
const TYPES = ['text', 'image', 'video', 'voice', 'file'];
const names = { text: '文字', image: '图片', video: '视频', voice: '语音', file: '文件' };
const usedByMessage = new WeakMap();
const zero = () => Object.fromEntries(TYPES.map((type) => [type, 0]));

export function cleanReason(value) {
  return String(value ?? '').replace(/(?:cookie|authorization|api[-_ ]?key|token)\s*[:=]\s*\S+/gi, '[凭据已隐藏]')
    .replace(/(?:https?:\/\/)[^\s；，]+/g, '[地址]')
    .replace(/[a-z]:[\\/][^\s；，]+/gi, '[本地文件]').replace(/[\r\n]+/g, ' ').trim().slice(0, 180);
}

export function splitText(text, limit = TEXT_LIMIT) {
  const chunks = [];
  let rest = String(text ?? '');
  while (rest.length > limit) {
    let end = rest.lastIndexOf('\n', limit);
    if (end < limit / 2) end = limit;
    if (/[\uD800-\uDBFF]/.test(rest[end - 1])) end -= 1;
    chunks.push(rest.slice(0, end));
    rest = rest.slice(end).replace(/^\n/, '');
  }
  if (rest.trim()) chunks.push(rest);
  return chunks.filter((chunk) => chunk.trim());
}

export function isInternalChatText(value) {
  return /^\s*⚠️\s*链接中包含超过\d+MB的视频时将单独发送所有媒体\s*$/.test(String(value ?? ''));
}

/** Validate the whole structural plan before attempting any irreversible send. */
export function flattenPlan(outcome) {
  const items = [];
  const reasons = [];
  let nodes = 0;
  let textBytes = 0;
  const walk = (value, depth = 0) => {
    if (depth > MAX_DEPTH) throw new Error('解析结果嵌套超过安全上限');
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, depth);
      return;
    }
    if (!value || typeof value !== 'object') throw new Error('解析结果包含无效节点');
    nodes += 1;
    if (nodes > MAX_PLAN_NODES) throw new Error(`解析结果超过 ${MAX_PLAN_NODES} 个节点上限`);
    const type = String(value.type || value.kind || '');
    if (type === 'segments') return walk(Array.isArray(value.segments) ? value.segments : [], depth + 1);
    if (type === 'forward' || type === 'nodes') {
      const children = value.nodes ?? value.data?.nodes ?? value.data?.content;
      if (!Array.isArray(children)) { reasons.push('转发节点未提供可展开内容'); return; }
      return walk(children, depth + 1);
    }
    if (type === 'node') {
      if (!Array.isArray(value.data?.content)) { reasons.push('转发子节点缺少正文'); return; }
      return walk(value.data.content, depth + 1);
    }
    if (type === 'reply') return; // passive context already references the incoming message
    const data = value.data && typeof value.data === 'object' ? value.data : value;
    if (type === 'text') {
      if (typeof data.text !== 'string') throw new Error('解析结果文字节点无效');
      textBytes += Buffer.byteLength(data.text);
      if (textBytes > MAX_TEXT_BYTES) throw new Error('解析结果正文超过安全上限');
      if (isInternalChatText(data.text)) return;
      if (data.text.trim()) items.push({ type: 'text', text: data.text, index: nodes });
    } else if (['image', 'video', 'record', 'voice', 'file'].includes(type)) {
      const reference = data.file ?? data.url ?? data.path;
      if (typeof reference !== 'string' || !reference.trim() || reference.length > 8192) {
        reasons.push(`${names[type === 'record' ? 'voice' : type]}引用无效`);
        items.push({ type: type === 'record' ? 'voice' : type, reference: '', invalid: true, index: nodes });
      } else {
        items.push({ type: type === 'record' ? 'voice' : type, reference, index: nodes });
      }
    } else reasons.push('已跳过不支持的消息节点');
  };
  const messages = outcome?.plan?.messages;
  if (messages !== undefined && !Array.isArray(messages)) throw new Error('解析结果投递计划无效');
  walk(messages || []);
  return { items, reasons };
}

export function requestIdFor({ ctx, msg, type, index, resource }) {
  const bot = String(ctx?.api?.appId ?? ctx?.botId ?? ctx?.dataDir ?? '');
  const identity = [bot, msg?.kind, msg?.chatId, msg?.id, type, index, resource].map(String).join('\0');
  return `media-parser:${createHash('sha256').update(identity).digest('hex').slice(0, 40)}`;
}

export function passiveBudget(ctx, msg) {
  const limit = msg?.kind === 'c2c' ? 4 : msg?.kind === 'group' ? 5 : 0;
  const windowMs = msg?.kind === 'c2c' ? 3_600_000 : 300_000;
  const observed = Number(ctx?.api?.seqMap?.get?.(msg?.id)) || 0;
  const tracked = usedByMessage.get(msg) || 0;
  return {
    limit, used: Math.max(observed, tracked), remaining: Math.max(0, limit - Math.max(observed, tracked)),
    expiresAt: Number(msg?.receivedAt || 0) + windowMs - 15_000,
  };
}

async function ledgerRow(ctx, requestId) {
  try { return await ctx?.delivery?.get?.(requestId) ?? null; } catch { return null; }
}

export async function deliveryState(ctx, requestId, returned, errors = []) {
  const row = await ledgerRow(ctx, requestId);
  if (returned?.dry) return { state: 'failed', reason: '当前通道为预演模式，未实际发送' };
  if (row?.state === 'sent') return { state: 'sent', reused: Boolean(returned?.reused) };
  if (['pending', 'audited', 'unknown'].includes(row?.state)) {
    return { state: 'pending', reason: row.state === 'unknown' ? '发送结果待核对，不会自动重发' : '' };
  }
  if (row?.state === 'failed') return { state: 'failed', reason: '通道确认发送失败' };
  if (returned?.pending === true) return { state: 'pending', reason: '' };
  if (typeof returned?.id === 'string' && returned.id.trim()) return { state: 'sent', reused: Boolean(returned.reused) };
  return { state: 'failed', reason: errors.length ? '通道未能发送该内容' : '通道未确认发送结果' };
}

function engineReasons(outcome) {
  const reasons = [];
  let mediaExpected = false;
  let hasError = false;
  const skippedByType = zero();
  for (const item of (Array.isArray(outcome?.items) ? outcome.items : []).slice(0, MAX_PLAN_NODES)) {
    if (!item || typeof item !== 'object') continue;
    if (item.error) { hasError = true; reasons.push(cleanReason(item.error)); }
    for (const type of ['video', 'image', 'audio']) {
      if (Number(item[`${type}Count`]) > 0 || (Array.isArray(item[`${type}Modes`]) && item[`${type}Modes`].length)) mediaExpected = true;
      skippedByType[type === 'audio' ? 'voice' : type] += (Array.isArray(item[`${type}Modes`]) ? item[`${type}Modes`] : []).filter((mode) => mode === 'skip').length;
      for (const reason of (Array.isArray(item[`${type}SkipReasons`]) ? item[`${type}SkipReasons`] : []).slice(0, 20)) {
        if (reason) { mediaExpected = true; reasons.push(cleanReason(reason)); }
      }
    }
  }
  for (const list of [outcome?.blocked, outcome?.skipped]) {
    for (const entry of (Array.isArray(list) ? list : []).slice(0, 20)) {
      if (entry?.reason) reasons.push(cleanReason(entry.reason));
    }
  }
  return { reasons: reasons.filter(Boolean), mediaExpected, skippedByType, hasError };
}

function sourceLinks(outcome) {
  const found = [...(Array.isArray(outcome?.links) ? outcome.links : []),
    ...(Array.isArray(outcome?.items) ? outcome.items.map((item) => item?.url) : [])];
  const result = [];
  let characters = 0;
  let omitted = false;
  for (const source of found) {
    if (typeof source !== 'string' || source.length > 8192) continue;
    try {
      const url = new URL(source);
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      url.username = ''; url.password = '';
      for (const key of [...url.searchParams.keys()]) if (/cookie|token|authorization|api.?key/i.test(key)) url.searchParams.delete(key);
      const value = url.href;
      if (value.length > 900 || characters + value.length > 1050) { omitted = true; continue; }
      if (!result.includes(value)) { result.push(value); characters += value.length; }
      if (result.length === 3) break;
    } catch {}
  }
  if (omitted) result.push('较长的原始链接请查看本条分享消息');
  return result;
}

function sourceUrlKeys(outcome) {
  const found = [...(Array.isArray(outcome?.links) ? outcome.links : []),
    ...(Array.isArray(outcome?.items) ? outcome.items.map((item) => item?.url) : [])];
  const keys = new Set();
  for (const source of found) {
    if (typeof source !== 'string' || source.length > 8192) continue;
    try {
      const url = new URL(source);
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      keys.add(`${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`);
    } catch {}
  }
  return keys;
}

function stripOriginalLinks(text, outcome) {
  const keys = sourceUrlKeys(outcome);
  if (!keys.size) return text;
  return String(text).replace(/https?:\/\/[^\s<>"'）)\]]+/gi, (value) => {
    try {
      const url = new URL(value);
      const key = `${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`;
      return keys.has(key) ? '' : value;
    } catch {
      return value;
    }
  }).replace(/^[ \t]*原始链接[ \t]*[:：][ \t]*$/gmi, '').replace(/\n{3,}/g, '\n\n').trim();
}

function chatReasons(result) {
  return [...new Set(result.reasons.map(cleanReason))]
    // A successful video-to-file conversion is an internal transport detail.
    // It should not consume a passive reply slot or appear in the chat summary.
    .filter((reason) => reason && !/超过媒体软限制，以文件发送/.test(reason));
}

function summaryText(result) {
  const parts = [];
  if (result.pending) parts.push('部分内容正在等待平台确认，不会重复发送。');
  if (result.failed || result.skipped) parts.push('部分内容未能发送。');
  const reasons = chatReasons(result);
  if (reasons.length) parts.push(reasons.join('；').slice(0, 500));
  return parts.join('\n').slice(0, TEXT_LIMIT);
}

export function createDelivery({ resolveFile = resolveMediaFile, prepareVoice = prepareAudio } = {}) {
  return async function deliver(outcome, {
    ctx, msg, config = {}, engine, taskId = '', deadlineAt, signal, isActive = () => true,
  } = {}) {
    const result = {
      claimed: false, sent: zero(), pending: 0, failed: 0, skipped: 0, reasons: [],
      pendingByType: zero(), failedByType: zero(), skippedByType: zero(), actions: [], taskId,
    };
    const active = { signal, deadlineAt, isActive };
    const files = [];
    let held = [];
    const addReason = (reason) => {
      const text = cleanReason(reason);
      if (text && !result.reasons.includes(text) && result.reasons.length < 40) result.reasons.push(text);
    };
    const skip = (item, reason) => {
      result.skipped += 1;
      result.skippedByType[item.type] += 1;
      addReason(reason);
    };
    const confirm = (item, requestId, state) => {
      result.actions.push({ type: item.type, requestId, state: state.state });
      if (state.state === 'sent') result.sent[item.type] += 1;
      else if (state.state === 'pending') { result.pending += 1; result.pendingByType[item.type] += 1; }
      else { result.failed += 1; result.failedByType[item.type] += 1; }
      if (state.reason) addReason(state.reason);
      if (!result.claimed && ['sent', 'pending'].includes(state.state)) {
        msg.claim?.();
        result.claimed = true;
      }
    };
    let budget;
    const canSend = () => {
      assertActive(active);
      budget = passiveBudget(ctx, msg);
      // Leave a further guard before the framework's own active-message downgrade.
      if (!msg?.id || !msg?.receivedAt || Date.now() + 1000 >= budget.expiresAt) {
        throw Object.assign(new Error('被动回复窗口已结束'), { code: 'reply-expired' });
      }
      return budget.remaining;
    };
    const reserveAttempt = () => {
      canSend();
      usedByMessage.set(msg, passiveBudget(ctx, msg).used + 1);
    };
    const sendOne = async (item, requestId) => {
      const previous = await ledgerRow(ctx, requestId);
      if (previous && ['sent', 'audited', 'pending', 'unknown'].includes(previous.state)) {
        const state = await deliveryState(ctx, requestId, { reused: true });
        confirm(item, requestId, state);
        return state;
      }
      canSend();
      if (item.file) await validateLocalFile(item.file.path, { cacheRoot: item.file.root, maxBytes: effectiveMaxBytes(config), ...active });
      if (canSend() < 1) return null;
      const errors = [];
      let returned;
      reserveAttempt();
      try {
        if (item.type === 'text') returned = await msg.replyNow(item.text, { requestId });
        else {
          const method = { image: 'replyImage', video: 'replyVideo', voice: 'replyVoice', file: 'replyFile' }[item.type];
          if (typeof msg[method] !== 'function') throw new Error('发送出口不可用');
          returned = await msg[method](item.file.path, { local: true, requestId, onError: (error) => errors.push(error) });
        }
      } catch (error) { errors.push(error); }
      const state = await deliveryState(ctx, requestId, returned, errors);
      confirm(item, requestId, state);
      return state;
    };
    try {
      assertActive(active);
      if (!['group', 'c2c'].includes(msg?.kind)) { addReason('当前发送适配未支持此会话'); return result; }
      const structural = flattenPlan(outcome);
      structural.reasons.forEach(addReason);
      const metadata = engineReasons(outcome);
      metadata.reasons.forEach(addReason);
      for (const type of TYPES) {
        result.skippedByType[type] += metadata.skippedByType[type];
        result.skipped += metadata.skippedByType[type];
      }
      const hasPlannedMedia = structural.items.some((item) => item.type !== 'text');
      result.mediaExpected = hasPlannedMedia || metadata.mediaExpected;
      result.textOnly = !result.mediaExpected;
      if (result.mediaExpected && !hasPlannedMedia && !metadata.reasons.length) {
        addReason('媒体未能下载或没有可发送的媒体结果');
      }
      if (!result.mediaExpected && !config.handleTextOnly && !metadata.hasError) {
        addReason('纯文字链接未接管');
        return result;
      }
      canSend();
      const prepared = [];
      // All paths, sizes and conversions are checked before the first caption.
      for (const item of structural.items) {
        assertActive(active);
        if (item.type === 'text') {
          if (config.sendCaption !== false) {
            const text = result.mediaExpected ? stripOriginalLinks(item.text, outcome) : item.text;
            splitText(text).forEach((chunk, index) => prepared.push({ ...item, text: chunk, chunk: index }));
          }
          continue;
        }
        if (item.invalid) { skip(item, '媒体引用无效'); continue; }
        try {
          item.file = await resolveFile(item.reference, { ctx, engine, config, ...active });
          files.push(item.file);
          prepared.push(item);
        } catch (error) {
          if (['cancelled', 'timeout'].includes(error?.code)) throw error;
          skip(item, error.message || '媒体文件未通过检查');
        }
      }
      const engineRoot = engine?.cacheRoot ? path.resolve(engine.cacheRoot) : '';
      const candidates = [...new Set(files.filter((file) => engineRoot && insideRoot(engineRoot, file.path)).map((file) => file.path))];
      if (candidates.length && typeof engine?.holdFiles === 'function') { await engine.holdFiles(candidates); held = candidates; }
      assertActive(active);
      for (const item of prepared) {
        if (item.type === 'voice') {
          const converted = await prepareVoice(item.file, { ctx, config, ...active });
          item.type = converted.type;
          item.file = converted.file;
          if (!files.includes(item.file)) files.push(item.file);
          if (converted.reason) addReason(converted.reason);
        }
        if (item.file && SOFT_BYTES[item.type] && item.file.size > SOFT_BYTES[item.type]) {
          addReason(`${names[item.type]}超过媒体软限制，以文件发送`);
          item.type = 'file';
        }
      }
      if (prepared.length > 2048) throw new Error('解析结果发送动作超过安全上限');
      const links = sourceLinks(outcome);
      let summarySlotReserved = false;
      for (let index = 0; index < prepared.length;) {
        const item = prepared[index];
        const itemRequestId = requestIdFor({ ctx, msg, type: item.type, index: `${item.index}:${item.chunk ?? 0}`, resource: item.reference || item.text });
        const previous = await ledgerRow(ctx, itemRequestId);
        if (previous && ['sent', 'audited', 'pending', 'unknown'].includes(previous.state)) {
          const state = await deliveryState(ctx, itemRequestId, { reused: true });
          confirm(item, itemRequestId, state);
          index += 1;
          continue;
        }
        const remainingItems = prepared.length - index;
        const remainingBudget = canSend();
        // Keep a slot for a failure summary only when the remaining plan cannot
        // fit anyway. Never sacrifice the last real media item just to explain
        // an informational conversion such as video -> file.
        summarySlotReserved ||= remainingItems > remainingBudget && remainingBudget > 1;
        const reserveSummary = summarySlotReserved || chatReasons(result).length > 0;
        const available = Math.max(0, remainingBudget - (reserveSummary ? 1 : 0));
        if (!available) {
          for (const skipped of prepared.slice(index)) skip(skipped, '消息发送次数已达上限');
          break;
        }
        // replyAuto's media-only branch sends each image; maxMedia is always explicit.
        // Intercept each actual replyImage result, since replyAuto only returns the last.
        if (item.type === 'image' && !/[)\r\n]/.test(item.file.path) && typeof msg.replyAuto === 'function') {
          const group = [];
          while (group.length < available && index + group.length < prepared.length) {
            const next = prepared[index + group.length];
            if (next.type !== 'image' || /[)\r\n]/.test(next.file.path)) break;
            group.push(next);
          }
          if (group.length > 1) {
            const base = requestIdFor({ ctx, msg, type: 'images', index: item.index, resource: group.map((image) => image.reference).join('\0') });
            const original = msg.replyImage;
            let actual = 0;
            msg.replyImage = async (_source, opts = {}) => {
              const current = group[actual++];
              if (!current) return null;
              const requestId = requestIdFor({
                ctx, msg, type: current.type, index: `${current.index}:${current.chunk ?? 0}`, resource: current.reference,
              });
              try {
                assertActive(active);
                const previous = await ledgerRow(ctx, requestId);
                if (previous && ['sent', 'pending', 'audited', 'unknown'].includes(previous.state)) {
                  const state = await deliveryState(ctx, requestId, { reused: true });
                  confirm(current, requestId, state);
                  return state.state === 'sent' ? { id: previous.msg_id || 'ledger', reused: true } : { pending: true };
                }
                await validateLocalFile(current.file.path, { cacheRoot: current.file.root, maxBytes: effectiveMaxBytes(config), ...active });
                if (canSend() <= 1) { skip(current, '消息发送次数已达上限'); return null; }
                reserveAttempt();
                const errors = [];
                let returned;
                try {
                  returned = await original.call(msg, current.file.path, { ...opts, local: true, requestId, onError: (error) => errors.push(error) });
                } catch (error) { errors.push(error); }
                const state = await deliveryState(ctx, requestId, returned, errors);
                confirm(current, requestId, state);
                return returned;
              } catch (error) {
                if (['cancelled', 'timeout', 'reply-expired'].includes(error?.code)) throw error;
                skip(current, error.message || '图片未能发送');
                return null;
              }
            };
            try {
              await msg.replyAuto(group.map((image) => `![](${image.file.path})`).join('\n'), {
                requestId: base, maxMedia: group.length,
              });
            } finally { msg.replyImage = original; }
            for (const missing of group.slice(actual)) skip(missing, '通道未处理全部图片');
            index += group.length;
            continue;
          }
        }
        await sendOne(item, itemRequestId);
        index += 1;
      }
      if (chatReasons(result).length || result.skipped || result.failed || result.pending) {
        if (canSend() > 0) {
          const text = summaryText(result);
          const requestId = requestIdFor({ ctx, msg, type: 'summary', index: 'summary', resource: links.join('\0') });
          await sendOne({ type: 'text', text }, requestId);
        }
      }
      return result;
    } catch (error) {
      addReason(error.message || '媒体发送未完成');
      result.cancelled = ['cancelled', 'timeout', 'reply-expired'].includes(error?.code);
      return result;
    } finally {
      if (held.length && typeof engine?.releaseFiles === 'function') {
        try { await engine.releaseFiles(held); } catch { addReason('媒体缓存使用标记未能释放'); }
      }
      for (const file of files) await removeOwnedFile(file, ctx?.dataDir);
    }
  };
}

export const deliver = createDelivery();
