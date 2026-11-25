/**
 * User-triggered Bilibili QR login and shared-credential validation.
 *
 * One in-memory session at a time; polls every 3 seconds for at most 180
 * seconds from the initial start deadline. The QR is rendered locally as a PNG
 * data URL and no file is written to the plugin or credential directories.
 * Public status exposes only state, absolute expiry, PNG, and safe fixed error
 * metadata; QR keys, callback URLs, headers, account UID and Cookies never
 * leave this module except through the shared settings API.
 */

import { qrToPngDataUrl } from './bili-qr.js';
import { SAFE_MESSAGES } from './bili-client.js';

const ACTIVE_STATES = new Set(['starting', 'waiting', 'scanned']);
const TERMINAL_POLL_CODES = new Set(['BILI_AUTH', 'BILI_RESPONSE', 'BILI_COOKIE', 'BILI_API']);
const KNOWN_ERROR_CODES = new Set(Object.keys(SAFE_MESSAGES).filter((code) => code !== 'BILI_CANCELLED'));
const RETRY_MAX_MS = 6 * 60 * 60 * 1000;

function defaultQr(text) {
  return qrToPngDataUrl(text, { ec: 'L', scale: 8, margin: 4 });
}

function errorFields(code, retryAfterMs = 0) {
  const safe = KNOWN_ERROR_CODES.has(code) ? code : 'BILI_RESPONSE';
  const retry = Number(retryAfterMs);
  const allowRetry = safe === 'BILI_RATE_LIMIT' || safe === 'BILI_HTTP';
  return {
    errorCode: safe,
    errorSummary: SAFE_MESSAGES[safe],
    retryAfterMs: allowRetry && Number.isFinite(retry) && retry > 0
      ? Math.min(RETRY_MAX_MS, Math.floor(retry)) : 0,
  };
}

/**
 * @param {object} options
 * @param {object} options.settings createSettings() instance or compatible fake
 * @param {object} options.client createBiliClient() instance or compatible fake
 * @param {Function} [options.qrEncode] text -> PNG data URL
 * @param {Function} [options.now] injectable clock
 * @param {number} [options.pollIntervalMs]
 * @param {number} [options.ttlMs]
 */
export function createBiliLogin({
  settings, client, qrEncode = defaultQr, now = () => Date.now(),
  pollIntervalMs = 3000, ttlMs = 180_000,
} = {}) {
  if (!settings || typeof settings.setBiliCookie !== 'function' || typeof settings.getBiliCookie !== 'function') {
    throw new TypeError('createBiliLogin requires the shared settings API');
  }
  if (!client || typeof client.generateQr !== 'function' || typeof client.pollQr !== 'function'
    || typeof client.nav !== 'function') {
    throw new TypeError('createBiliLogin requires a Bili client');
  }

  let session = null;
  let generation = 0;
  let manualGeneration = 0;
  let inspectGeneration = 0;
  const operations = new Set();
  let disposed = false;
  let internalChange = false;
  let state = 'idle';
  let expiresAt = null;
  let pngDataUrl = null;
  let errorCode = null;
  let errorSummary = null;
  let retryAfterMs = 0;

  const cookieRevision = () => (typeof settings.getBiliCookieRevision === 'function'
    ? settings.getBiliCookieRevision() : 0);

  const unsubscribe = typeof settings.subscribeBiliCookie === 'function'
    ? settings.subscribeBiliCookie(() => {
      if (internalChange || disposed) return;
      invalidateOperations();
      if (session) {
        generation += 1;
        clearSession();
        state = 'cancelled';
        clearError();
      }
    })
    : () => {};

  function status() {
    return {
      state, expiresAt, pngDataUrl, errorCode, errorSummary, retryAfterMs,
    };
  }

  function clearError() {
    errorCode = null;
    errorSummary = null;
    retryAfterMs = 0;
  }

  function applyError(code, retry = 0) {
    const fields = errorFields(code, retry);
    errorCode = fields.errorCode;
    errorSummary = fields.errorSummary;
    retryAfterMs = fields.retryAfterMs;
    return fields;
  }

  function isCurrent(candidate) {
    return !disposed && session === candidate && candidate.generation === generation;
  }

  function clearSession() {
    if (!session) return;
    const current = session;
    session = null;
    if (current.timer) {
      clearTimeout(current.timer);
      current.timer = null;
    }
    if (current.expiryTimer) {
      clearTimeout(current.expiryTimer);
      current.expiryTimer = null;
    }
    try { current.controller.abort(); } catch { /* ignore */ }
    pngDataUrl = null;
    expiresAt = null;
  }

  function abortOperations(predicate) {
    for (const op of [...operations]) {
      if (!predicate(op)) continue;
      try { op.controller.abort(); } catch { /* ignore */ }
      operations.delete(op);
    }
  }

  function invalidateOperations() {
    manualGeneration += 1;
    inspectGeneration += 1;
    abortOperations(() => true);
  }

  function beginOperation(kind) {
    const revision = cookieRevision();
    if (kind === 'manual') {
      manualGeneration += 1;
      inspectGeneration += 1;
      abortOperations(() => true);
    } else {
      inspectGeneration += 1;
      abortOperations((op) => op.kind === 'inspect');
    }
    const op = {
      kind,
      generation: kind === 'manual' ? manualGeneration : inspectGeneration,
      revision,
      controller: new AbortController(),
    };
    operations.add(op);
    return op;
  }

  function finishOperation(op) {
    operations.delete(op);
  }

  function isOperationCurrent(op) {
    const current = op.kind === 'manual' ? manualGeneration : inspectGeneration;
    return !disposed && op.generation === current
      && !op.controller.signal.aborted && cookieRevision() === op.revision;
  }

  function armExpiry(current) {
    if (!isCurrent(current) || current.expiryTimer) return;
    const remaining = current.expiresAt - now();
    if (remaining <= 0) {
      expire(current);
      return;
    }
    current.expiryTimer = setTimeout(() => {
      current.expiryTimer = null;
      expire(current);
    }, remaining);
    current.expiryTimer.unref?.();
  }

  function schedule(current, minimumDelay = 0) {
    if (!isCurrent(current) || current.timer) return;
    const remaining = current.expiresAt - now();
    if (remaining <= 0) {
      expire(current);
      return;
    }
    const requested = Number(minimumDelay);
    const wait = Number.isFinite(requested) && requested > 0 ? requested : pollIntervalMs;
    const delay = Math.max(1, Math.min(Math.max(1, Math.floor(wait)), remaining));
    current.timer = setTimeout(() => {
      current.timer = null;
      Promise.resolve().then(() => poll(current)).catch(() => {});
    }, delay);
    current.timer.unref?.();
  }

  function finish(current, nextState) {
    if (!isCurrent(current)) return false;
    clearSession();
    state = nextState;
    return true;
  }

  function expire(current) {
    if (!isCurrent(current)) return;
    clearError();
    finish(current, 'expired');
  }

  async function completeLogin(current, cookie) {
    if (!isCurrent(current) || now() >= current.expiresAt) {
      if (isCurrent(current)) expire(current);
      return;
    }
    let nav;
    try {
      nav = await client.nav(cookie, { signal: current.controller.signal });
    } catch (error) {
      if (!isCurrent(current)) return;
      if (error?.code === 'BILI_CANCELLED') return;
      const fields = applyError(error?.code, error?.retryAfterMs);
      finish(current, 'error');
      applyError(fields.errorCode, fields.retryAfterMs);
      return;
    }
    if (!isCurrent(current)) return;
    if (now() >= current.expiresAt) {
      expire(current);
      return;
    }
    if (!nav || !nav.mid) {
      finish(current, 'error');
      applyError('BILI_RESPONSE');
      return;
    }
    internalChange = true;
    try {
      await settings.setBiliCookie(cookie, {
        guard: () => !disposed && isCurrent(current) && now() < current.expiresAt
          && !current.controller.signal.aborted
          && cookieRevision() === current.cookieRevision,
      });
    } catch {
      internalChange = false;
      if (!isCurrent(current)) return;
      finish(current, 'error');
      applyError('BILI_COOKIE');
      return;
    } finally {
      internalChange = false;
    }
    if (!isCurrent(current)) return;
    clearSession();
    state = 'success';
    clearError();
  }

  async function poll(current) {
    if (!isCurrent(current)) return;
    if (now() >= current.expiresAt) {
      expire(current);
      return;
    }

    let result;
    try {
      result = await client.pollQr(current.key, { signal: current.controller.signal });
    } catch (error) {
      if (!isCurrent(current)) return;
      if (error?.code === 'BILI_CANCELLED') return;
      const fields = applyError(error?.code, error?.retryAfterMs);
      if (TERMINAL_POLL_CODES.has(fields.errorCode)) {
        finish(current, 'error');
        applyError(fields.errorCode, fields.retryAfterMs);
        return;
      }
      schedule(current, fields.retryAfterMs);
      return;
    }
    if (!isCurrent(current)) return;
    if (now() >= current.expiresAt) {
      expire(current);
      return;
    }

    if (result?.state === 'waiting' || result?.state === 'scanned') {
      state = result.state;
      clearError();
      schedule(current);
      return;
    }
    if (result?.state === 'expired') {
      expire(current);
      return;
    }
    if (result?.state === 'success') {
      await completeLogin(current, result.cookie);
      return;
    }
    applyError('BILI_RESPONSE');
    schedule(current);
  }

  async function start() {
    if (disposed) return status();
    if (session && ACTIVE_STATES.has(state)) return status();

    generation += 1;
    const startedAt = now();
    const current = {
      generation,
      controller: new AbortController(),
      timer: null,
      expiryTimer: null,
      key: '',
      startedAt,
      expiresAt: startedAt + Math.max(1, ttlMs),
      cookieRevision: cookieRevision(),
    };
    session = current;
    state = 'starting';
    expiresAt = current.expiresAt;
    pngDataUrl = null;
    clearError();
    armExpiry(current);

    let generated;
    try {
      generated = await client.generateQr({ signal: current.controller.signal });
    } catch (error) {
      if (!isCurrent(current)) return status();
      if (error?.code === 'BILI_CANCELLED') {
        finish(current, 'idle');
        clearError();
        return status();
      }
      const fields = applyError(error?.code, error?.retryAfterMs);
      finish(current, 'error');
      applyError(fields.errorCode, fields.retryAfterMs);
      return status();
    }
    if (!isCurrent(current)) return status();
    if (now() >= current.expiresAt) {
      expire(current);
      return status();
    }

    let png;
    try {
      png = qrEncode(generated.url);
    } catch {
      finish(current, 'error');
      applyError('BILI_RESPONSE');
      return status();
    }
    if (!isCurrent(current)) return status();
    if (now() >= current.expiresAt) {
      expire(current);
      return status();
    }

    current.key = String(generated.key);
    current.pngDataUrl = png;
    state = 'waiting';
    expiresAt = current.expiresAt;
    pngDataUrl = png;
    clearError();
    schedule(current);
    return status();
  }

  function cancel() {
    generation += 1;
    invalidateOperations();
    clearSession();
    clearError();
    state = 'cancelled';
    return status();
  }

  async function inspectCurrent({ withAccount }) {
    const op = beginOperation('inspect');
    const cookie = String(settings.getBiliCookie?.() || '');
    if (!cookie) {
      finishOperation(op);
      return { state: 'missing' };
    }
    let nav;
    try {
      nav = await client.nav(cookie, { signal: op.controller.signal });
    } catch (error) {
      const current = isOperationCurrent(op);
      finishOperation(op);
      if (!current || error?.code === 'BILI_CANCELLED') return { state: 'cancelled' };
      const fields = errorFields(error?.code, error?.retryAfterMs);
      if (fields.errorCode === 'BILI_AUTH') return { state: 'invalid', ...fields };
      return { state: 'error', ...fields };
    }
    const current = isOperationCurrent(op);
    finishOperation(op);
    if (!current) return { state: 'cancelled' };
    if (!nav || !nav.mid) return { state: 'error', ...errorFields('BILI_RESPONSE') };
    if (!withAccount) return { state: 'valid' };
    return { state: 'valid', mid: nav.mid, uname: nav.uname || '' };
  }

  /**
   * Public-safe validation summary. Deliberately omits account UID/uname; panel
   * integration must only consume this whitelist.
   */
  function inspect() {
    return inspectCurrent({ withAccount: false });
  }

  /**
   * INTERNAL ONLY: service account-isolation verification. Never forward the
   * returned mid/uname to the panel or public status.
   */
  function inspectAccount() {
    return inspectCurrent({ withAccount: true });
  }

  async function manual(cookie) {
    const value = String(cookie ?? '').trim();
    const op = beginOperation('manual');
    if (!value) {
      finishOperation(op);
      return { ok: false, state: 'invalid', ...errorFields('BILI_AUTH') };
    }

    generation += 1;
    clearSession();
    state = 'idle';
    clearError();
    pngDataUrl = null;
    expiresAt = null;

    let nav;
    try {
      nav = await client.nav(value, { signal: op.controller.signal });
    } catch (error) {
      const current = isOperationCurrent(op);
      finishOperation(op);
      if (!current || error?.code === 'BILI_CANCELLED') return { ok: false, state: 'cancelled' };
      const fields = errorFields(error?.code, error?.retryAfterMs);
      applyError(fields.errorCode, fields.retryAfterMs);
      return {
        ok: false,
        state: fields.errorCode === 'BILI_AUTH' ? 'invalid' : 'error',
        ...fields,
      };
    }
    if (!isOperationCurrent(op)) {
      finishOperation(op);
      return { ok: false, state: 'cancelled' };
    }
    if (!nav || !nav.mid) {
      finishOperation(op);
      const fields = errorFields('BILI_RESPONSE');
      applyError(fields.errorCode);
      return { ok: false, state: 'error', ...fields };
    }

    internalChange = true;
    try {
      await settings.setBiliCookie(value, {
        guard: () => !disposed && isOperationCurrent(op),
      });
    } catch {
      internalChange = false;
      const current = isOperationCurrent(op);
      finishOperation(op);
      if (!current) return { ok: false, state: 'cancelled' };
      const fields = errorFields('BILI_COOKIE');
      applyError(fields.errorCode);
      return { ok: false, state: 'error', ...fields };
    } finally {
      internalChange = false;
    }

    if (disposed || op.generation !== manualGeneration) {
      finishOperation(op);
      return { ok: false, state: 'cancelled' };
    }
    finishOperation(op);
    state = 'success';
    pngDataUrl = null;
    expiresAt = null;
    clearError();
    return { ok: true, state: 'valid' };
  }

  async function logout() {
    generation += 1;
    invalidateOperations();
    clearSession();
    clearError();
    try {
      await settings.clearBiliCookie({ guard: () => !disposed });
    } catch {
      if (disposed) return { ok: false, state: 'cancelled' };
      const fields = errorFields('BILI_COOKIE');
      applyError(fields.errorCode);
      state = 'error';
      return { ok: false, state: 'error', ...fields };
    }
    state = 'idle';
    pngDataUrl = null;
    expiresAt = null;
    clearError();
    return { ok: true, state: 'idle' };
  }

  function deactivate() {
    if (disposed) return status();
    disposed = true;
    generation += 1;
    invalidateOperations();
    clearSession();
    clearError();
    state = 'idle';
    try { unsubscribe(); } catch { /* ignore */ }
    return status();
  }

  return {
    start,
    status,
    cancel,
    inspect,
    inspectAccount,
    manual,
    logout,
    deactivate,
    flush: () => (typeof settings.flush === 'function' ? settings.flush() : Promise.resolve()),
    hasSession: () => Boolean(session),
  };
}

export { ACTIVE_STATES, defaultQr };
