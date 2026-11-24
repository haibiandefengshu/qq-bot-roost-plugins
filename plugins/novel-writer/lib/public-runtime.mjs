import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const SENSITIVE_CONFIG_KEY = /^(?:api[_-]?key|authorization|cookie|password|secret|token|translatekey)$/i;
const DEFAULT_API_TIMEOUT_MS = 180_000;
const DEFAULT_CONFIG_TIMEOUT_MS = 15_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function clip(value, max = 512) {
  return String(value ?? '').trim().slice(0, max);
}

function publicError(error, fallback = '操作失败') {
  return String(error?.message || error || fallback)
    .replace(/[A-Za-z]:\\[^\s，；]+/g, '本地路径')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(0, 300);
}

function abortError() {
  const error = new Error('操作已取消');
  error.name = 'AbortError';
  return error;
}

function timeoutError() {
  const error = new Error('本地 API 操作超时');
  error.name = 'TimeoutError';
  return error;
}

function inside(root, candidate) {
  const rel = relative(resolve(root), resolve(String(candidate ?? '')));
  if (!rel) return true;
  if (isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

function atomicJson(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch {}
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw new Error('小说运行记录损坏，原文件已保留');
  }
}

function credentialFreeValue(value) {
  if (Array.isArray(value)) return value.map(credentialFreeValue);
  if (!value || typeof value !== 'object') {
    if (typeof value !== 'string') return value;
    try {
      const url = new URL(value);
      url.username = '';
      url.password = '';
      for (const key of [...url.searchParams.keys()]) {
        if (/(?:api[_-]?key|auth|credential|key|password|secret|token)/i.test(key)) {
          url.searchParams.delete(key);
        }
      }
      return url.toString();
    } catch {
      return value;
    }
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!SENSITIVE_CONFIG_KEY.test(key)) result[key] = credentialFreeValue(item);
  }
  return result;
}

function canonicalConfig(value) {
  if (Array.isArray(value)) return value.map(canonicalConfig);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalConfig(value[key])]),
  );
}

function fingerprint(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalConfig(credentialFreeValue(value))))
    .digest('hex');
}

function asLog(log) {
  return (message) => {
    try { log?.(clip(message, 300)); } catch {}
  };
}

function numberIn(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function officialVoiceOf(tts, provider) {
  if (provider === 'edge') return clip(tts?.edge?.voice, 100);
  if (provider === 'mimo') return clip(tts?.mimo?.voice, 100);
  if (provider === 'sherpa') return clip(tts?.sherpa?.sid, 40);
  return clip(tts?.voice, 100);
}

function officialSpeedOf(tts) {
  return numberIn(tts?.speed, 0.5, 2) ?? 1;
}

function officialMissing(tts, provider) {
  if (!tts || typeof tts !== 'object') return ['语音配置'];
  const missing = [];
  if (tts.enabled !== true) missing.push('启用开关');
  if (provider === 'openai') {
    if (!clip(tts.baseUrl, 2048)) missing.push('API 地址');
    if (!clip(tts.model, 160)) missing.push('模型');
  } else if (provider === 'gpt-sovits') {
    const gpt = tts.gptSovits && typeof tts.gptSovits === 'object' ? tts.gptSovits : {};
    if (!clip(gpt.baseUrl, 2048)) missing.push('GPT-SoVITS 地址');
    if (!clip(gpt.referWavPath, 2048)) missing.push('参考音频');
    if (!clip(gpt.promptText, 2000)) missing.push('参考文本');
    if (!clip(gpt.promptLanguage, 40)) missing.push('参考语言');
    if (!clip(gpt.textLanguage, 40)) missing.push('正文语言');
  } else if (provider === 'mimo') {
    if (!clip(tts.mimo?.apiKey, 4096)) missing.push('API Key');
  } else if (provider === 'edge') {
    if (!clip(tts.edge?.voice, 100)) missing.push('音色');
  } else if (provider === 'sherpa') {
    if (!clip(tts.sherpa?.model, 160)) missing.push('本地模型');
  } else {
    missing.push('语音来源');
  }
  return missing;
}

function officialView(config) {
  const tts = config?.tts && typeof config.tts === 'object' ? config.tts : {};
  const provider = clip(tts.provider, 40);
  const savedSpeed = officialSpeedOf(tts);
  const effectiveSpeed = provider === 'mimo' ? 1 : savedSpeed;
  const missing = officialMissing(tts, provider);
  const enabled = tts.enabled === true;
  return {
    available: enabled,
    configured: enabled && missing.length === 0,
    provider,
    voice: officialVoiceOf(tts, provider),
    speed: effectiveSpeed,
    savedSpeed,
    effectiveSpeed,
    globalSpeed: savedSpeed,
    maxChars: Math.max(1, Math.min(5000, Number(tts.maxChars) || 300)),
    supportsSpeed: false,
    supportsSpeedOverride: false,
    supportsVoiceOverride: false,
    engineChecked: false,
    missing: missing.slice(0, 8),
    limitations: [
      '只使用已保存的全局语音配置，不支持每本书单独设置音色、语速或草稿。',
      provider === 'mimo'
        ? `已保存全局语速 ${savedSpeed}，但 MiMo 固定原速，实际按 ${effectiveSpeed} 合成。`
        : `实际沿用全局语速 ${effectiveSpeed}；如需调整，请先修改全局语音设置。`,
      '配置完整性只依据公开配置字段，不能探测语音引擎健康状态。',
    ],
  };
}

function platformDir() {
  if (process.platform === 'win32') return `win32-${process.arch}`;
  if (process.platform === 'darwin') return `darwin-${process.arch}`;
  if (process.platform === 'linux') return `linux-${process.arch}`;
  return '';
}

function binaryNames() {
  return process.platform === 'win32'
    ? ['ffmpeg.exe', 'ffmpeg.cmd', 'ffmpeg.bat']
    : ['ffmpeg'];
}

function findInPath(env) {
  const dirs = String(env.PATH || env.Path || '')
    .split(delimiter)
    .map((item) => item.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  for (const dir of dirs) {
    for (const name of binaryNames()) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return '';
}

export function createPublicRuntime({
  dataDir,
  extensionRoot,
  env = process.env,
  config = {},
  fetchImpl = globalThis.fetch,
  log = () => {},
  now = Date.now,
  apiTimeoutMs = DEFAULT_API_TIMEOUT_MS,
  configTimeoutMs = DEFAULT_CONFIG_TIMEOUT_MS,
  closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
} = {}) {
  if (!dataDir) throw new Error('小说扩展缺少宿主专属数据目录');
  const outputRoot = join(resolve(dataDir), 'outputs');
  const artifactFile = join(resolve(dataDir), 'artifacts.json');
  const root = extensionRoot ? resolve(extensionRoot) : '';
  const say = asLog(log);
  const configOf = typeof config === 'function' ? config : () => config || {};
  const voiceSnapshots = new Map();
  const inflight = new Set();
  let disposed = false;
  let voiceActionsCache = null;
  let artifactQueue = Promise.resolve();

  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });

  function ensureOpen() {
    if (disposed) throw new Error('小说运行时已关闭');
  }

  function apiBase() {
    const raw = clip(env.ROOST_API_URL, 4096);
    if (!raw) throw new Error('本地 API 地址未配置');
    let url;
    try { url = new URL(raw); }
    catch { throw new Error('本地 API 地址无效'); }
    if (url.protocol !== 'http:'
        || url.username || url.password || url.search || url.hash
        || !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
      throw new Error('本地 API 地址必须是本机 HTTP 地址');
    }
    return raw.replace(/\/+$/, '');
  }

  function apiToken() {
    const token = clip(env.ROOST_API_TOKEN, 4096);
    if (!token) throw new Error('本地 API 令牌未配置');
    return token;
  }

  async function apiRequest(path, { method = 'GET', body, signal, timeoutMs = apiTimeoutMs } = {}) {
    const base = apiBase();
    const token = apiToken();
    if (typeof fetchImpl !== 'function') throw new Error('运行环境没有 fetch');
    if (signal?.aborted) throw abortError();

    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1, timeoutMs));
    timer.unref?.();
    const abortPromise = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(timedOut ? timeoutError() : abortError()), { once: true });
    });
    const headers = { accept: 'application/json', authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const work = Promise.resolve()
      .then(() => fetchImpl(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      }))
      .then(async (response) => ({ response, text: await response.text() }));
    work.catch(() => {});
    try {
      const { response, text } = await Promise.race([work, abortPromise]);
      if (signal?.aborted) throw abortError();
      if (timedOut) throw timeoutError();
      if (!response.ok) throw new Error(`本地 API 返回 HTTP ${Number(response.status) || 0}`);
      let parsed;
      try { parsed = JSON.parse(text); }
      catch { throw new Error('本地 API 返回了无效 JSON'); }
      if (!parsed || parsed.ok !== true) {
        const code = typeof parsed?.error === 'string' && /^[a-z0-9_-]{1,40}$/i.test(parsed.error)
          ? parsed.error : '';
        throw new Error(`本地 API 拒绝了请求${code ? `（${code}）` : ''}`);
      }
      return parsed;
    } catch (error) {
      if (timedOut) throw timeoutError();
      if (signal?.aborted || controller.signal.aborted) throw abortError();
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw error;
      if (/^本地 API /.test(String(error?.message ?? ''))) throw error;
      throw new Error('无法连接本地 API');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  async function readPublicConfig({ signal, timeoutMs = configTimeoutMs } = {}) {
    const body = await apiRequest('/config', { signal, timeoutMs });
    return body.config && typeof body.config === 'object' && !Array.isArray(body.config)
      ? body.config : {};
  }

  function makeOperation(signal, timeoutMs) {
    ensureOpen();
    if (signal?.aborted) throw abortError();
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1, timeoutMs));
    timer.unref?.();
    inflight.add(controller);
    let done = false;
    return {
      signal: controller.signal,
      timedOut: () => timedOut,
      assert() {
        if (timedOut) throw timeoutError();
        if (disposed || signal?.aborted || controller.signal.aborted) throw abortError();
      },
      cleanup() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        inflight.delete(controller);
      },
    };
  }

  function artifactPath(candidate, notFoundMessage) {
    const path = resolve(String(candidate ?? ''));
    if (!inside(outputRoot, path)) throw new Error('成果路径不在小说专属目录内');
    let realPath;
    try { realPath = realpathSync(path); }
    catch { throw new Error(notFoundMessage); }
    if (!inside(realpathSync(outputRoot), realPath)) throw new Error('成果路径校验失败');
    return path;
  }

  function artifactsState() {
    const value = readJson(artifactFile, { items: {} });
    if (!value || typeof value !== 'object' || !value.items || typeof value.items !== 'object') {
      throw new Error('小说成果索引损坏，原文件已保留');
    }
    return value;
  }

  function serializeArtifacts(fn) {
    const run = artifactQueue.then(fn, fn);
    artifactQueue = run.catch(() => {});
    return run;
  }

  const artifacts = Object.freeze({
    async register({ ownerKey, bookId = '', kind = 'file', path, fileName, bytes = 0 } = {}) {
      ensureOpen();
      const owner = clip(ownerKey, 128);
      if (!owner) throw new Error('成果缺少书库身份');
      const safe = artifactPath(path, '成果文件已不存在');
      const stat = statSync(safe);
      if (!stat.isFile() || stat.size <= 0) throw new Error('成果文件为空或不是普通文件');
      if (Number(bytes) && Number(bytes) !== stat.size) throw new Error('成果大小不一致');
      return await serializeArtifacts(async () => {
        const id = `art-${randomUUID()}`;
        const state = artifactsState();
        state.items[id] = {
          id,
          ownerKey: owner,
          bookId: clip(bookId, 100),
          kind: clip(kind, 24),
          path: safe,
          fileName: clip(fileName || 'novel.txt', 180),
          bytes: stat.size,
          createdAt: now(),
        };
        atomicJson(artifactFile, state);
        return { id, fileName: state.items[id].fileName, bytes: stat.size };
      });
    },

    resolve(artifactId, ownerKey) {
      ensureOpen();
      const id = clip(artifactId, 80);
      const owner = clip(ownerKey, 128);
      const row = artifactsState().items[id];
      if (!row || !owner || row.ownerKey !== owner) throw new Error('成果不存在或不属于当前书库');
      const path = artifactPath(row.path, '成果文件已不存在');
      const stat = statSync(path);
      if (!stat.isFile() || stat.size <= 0) throw new Error('成果文件已不存在');
      return { ...row, path, bytes: stat.size };
    },

    async cleanup({ now: current = now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
      ensureOpen();
      return await serializeArtifacts(async () => {
        const state = artifactsState();
        const cutoff = Number(current) - Math.max(1, Number(maxAgeMs) || 0);
        let removed = 0;
        for (const [id, row] of Object.entries(state.items)) {
          if (!row || Number(row.createdAt) > cutoff) continue;
          const candidate = resolve(String(row.path ?? ''));
          if (!inside(outputRoot, candidate)) continue;
          let realCandidate = '';
          try { realCandidate = realpathSync(candidate); }
          catch (error) { if (error?.code !== 'ENOENT') continue; }
          if (realCandidate && !inside(realpathSync(outputRoot), realCandidate)) continue;
          try { unlinkSync(candidate); } catch (error) {
            if (error?.code !== 'ENOENT') continue;
          }
          delete state.items[id];
          removed += 1;
        }
        if (removed) atomicJson(artifactFile, state);
        return { removed };
      });
    },
  });

  async function loadVoiceActions() {
    if (!root) throw new Error('缺少小说扩展目录');
    const sibling = join(dirname(root), 'voice-reply');
    if (!inside(dirname(root), sibling)) throw new Error('语音回复扩展目录校验失败');
    const manifestFile = join(sibling, 'plugin.json');
    if (!existsSync(manifestFile)) throw new Error('没有安装语音回复扩展');
    let manifest;
    let manifestStat;
    try {
      manifestStat = statSync(manifestFile);
      manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    } catch {
      throw new Error('语音回复扩展清单损坏');
    }
    const entryName = clip(manifest?.ui?.entry, 512);
    if (!entryName) throw new Error('语音回复扩展没有进程内入口');
    const entry = resolve(sibling, entryName);
    if (!inside(sibling, entry)) throw new Error('语音回复扩展入口校验失败');
    let entryStat;
    try {
      if (!inside(realpathSync(sibling), realpathSync(entry))) throw new Error('语音回复扩展入口校验失败');
      entryStat = statSync(entry);
    } catch (error) {
      if (error?.message === '语音回复扩展入口校验失败') throw error;
      throw new Error('语音回复扩展入口不存在');
    }
    const cacheKey = [
      clip(manifest?.version, 80),
      entryName,
      Number(manifestStat.mtimeMs) || 0,
      Number(manifestStat.size) || 0,
      Number(entryStat.mtimeMs) || 0,
      Number(entryStat.size) || 0,
    ].join('|');
    if (voiceActionsCache?.key === cacheKey) return await voiceActionsCache.promise;
    const promise = (async () => {
      let module;
      try { module = await import(`${pathToFileURL(entry).href}?v=${encodeURIComponent(cacheKey)}`); }
      catch { throw new Error('语音回复扩展入口加载失败'); }
      if (typeof module.createActions !== 'function') throw new Error('语音回复扩展缺少 createActions');
      let actions;
      try { actions = module.createActions({ env, root: sibling }); }
      catch { throw new Error('语音回复扩展动作初始化失败'); }
      return {
        key: cacheKey,
        root: sibling,
        actions,
        profiles: typeof actions?.profiles === 'function' ? actions.profiles : null,
        longForm: typeof actions?.longForm === 'function' ? actions.longForm : null,
      };
    })();
    const cached = { key: cacheKey, promise };
    voiceActionsCache = cached;
    try {
      return await promise;
    } catch (error) {
      if (voiceActionsCache === cached) voiceActionsCache = null;
      throw error;
    }
  }

  async function actionData(fn, payload) {
    let result;
    try { result = await fn(payload); }
    catch (error) { throw new Error(publicError(error, '语音回复扩展调用失败')); }
    if (!result || result.ok !== true) throw new Error(publicError(result?.message, '语音回复扩展调用失败'));
    return result.data ?? result;
  }

  async function voiceListSources() {
    let official;
    try {
      official = officialView(await readPublicConfig());
    } catch (error) {
      official = {
        available: false,
        configured: false,
        supportsSpeed: false,
        missing: [],
        limitations: ['无法读取全局语音配置。'],
        error: publicError(error),
      };
    }
    let extension;
    try {
      const loaded = await loadVoiceActions();
      if (!loaded.profiles) throw new Error('语音回复扩展没有返回音色方案能力');
      const data = await actionData(loaded.profiles, { op: 'list' });
      const profiles = (Array.isArray(data?.items) ? data.items : [])
        .filter((item) => item && typeof item.id === 'string' && typeof item.name === 'string')
        .slice(0, 50)
        .map((item) => ({ id: clip(item.id, 100), name: clip(item.name, 80) }));
      const hasLongForm = Boolean(loaded.longForm);
      extension = {
        available: hasLongForm,
        configured: hasLongForm,
        longForm: hasLongForm,
        profiles,
        ...(hasLongForm ? {} : { message: '语音回复扩展缺少长文合成能力，无法朗读长文。' }),
      };
    } catch (error) {
      extension = {
        available: false,
        configured: false,
        longForm: false,
        profiles: [],
        error: publicError(error),
      };
    }
    return { official, extension };
  }

  async function extensionSnapshot(selection, key) {
    const loaded = await loadVoiceActions();
    if (!loaded.profiles) throw new Error('语音回复扩展没有返回音色方案能力');
    if (!loaded.longForm) throw new Error('语音回复扩展缺少长文合成能力，无法开始朗读任务');
    const data = await actionData(loaded.profiles, { op: 'list' });
    const items = Array.isArray(data?.items) ? data.items : [];
    const profile = items.find((item) => item?.id === selection.profileId);
    if (!profile?.values) throw new Error('所选音色方案已删除或不可用');
    const values = structuredClone(profile.values);
    const speed = numberIn(selection.speed, 0.5, 2);
    if (speed !== null) values.speed = speed;
    const token = `extension:${clip(key, 100)}:${randomUUID()}`;
    const snap = {
      source: 'extension',
      actionsKey: loaded.key,
      profileId: clip(profile.id, 80),
      profileName: clip(profile.name, 80),
      values,
      fingerprint: fingerprint({ source: 'extension', profileId: profile.id, values }),
      provider: '',
      voice: '',
      speed,
      maxChars: Math.max(10, Math.min(300, Number(values.maxChars) || 60)),
    };
    voiceSnapshots.set(token, snap);
    return {
      token,
      source: 'extension',
      profileId: snap.profileId,
      profileName: snap.profileName,
      fingerprint: snap.fingerprint,
      chunkChars: Math.max(20, Math.min(200, Number(values.maxChars) || 60)),
      supportsSpeed: true,
    };
  }

  async function officialSnapshot(selection, key) {
    const config = await readPublicConfig();
    const view = officialView(config);
    if (!view.available) throw new Error('官方语音当前不可用，请先在全局语音设置中启用');
    if (!view.configured) {
      throw new Error(`官方语音缺少必要配置：${view.missing.join('、') || '请检查全局语音设置'}`);
    }
    const requestedVoice = clip(selection.voice, 100);
    if (requestedVoice && requestedVoice !== view.voice) {
      throw new Error(`官方语音只能使用已保存的全局音色${view.voice ? `（${view.voice}）` : ''}，请在全局语音设置中调整`);
    }
    const speedProvided = selection.speed !== undefined && selection.speed !== null && selection.speed !== '';
    const requestedSpeed = numberIn(selection.speed, 0.5, 2);
    if (speedProvided && requestedSpeed === null) throw new Error('官方语音语速需在 0.5 到 2 之间');
    if (speedProvided && requestedSpeed !== view.effectiveSpeed) {
      const detail = view.savedSpeed !== view.effectiveSpeed
        ? `（已保存全局语速 ${view.savedSpeed}，当前实际生效 ${view.effectiveSpeed}）` : '';
      throw new Error(`官方语音只能使用当前实际语速 ${view.effectiveSpeed}${detail}，不支持本书单独覆盖，请在全局语音设置中调整`);
    }
    const tts = config?.tts && typeof config.tts === 'object' ? config.tts : {};
    const token = `official:${clip(key, 100)}:${randomUUID()}`;
    const snap = {
      source: 'official',
      values: structuredClone(tts),
      fingerprint: fingerprint(tts),
      provider: view.provider,
      voice: view.voice,
      speed: view.effectiveSpeed,
      savedSpeed: view.savedSpeed,
      effectiveSpeed: view.effectiveSpeed,
      maxChars: view.maxChars,
    };
    voiceSnapshots.set(token, snap);
    return {
      token,
      source: 'official',
      provider: snap.provider,
      voice: snap.voice,
      speed: snap.speed,
      savedSpeed: view.savedSpeed,
      effectiveSpeed: view.effectiveSpeed,
      globalSpeed: view.globalSpeed,
      fingerprint: snap.fingerprint,
      chunkChars: Math.max(20, Math.min(200, snap.maxChars)),
      supportsSpeed: view.provider !== 'mimo',
    };
  }

  async function synthesizeOfficial(value, snap, signal) {
    const operation = makeOperation(signal, apiTimeoutMs);
    try {
      const before = await readPublicConfig({ signal: operation.signal });
      if (fingerprint(before?.tts || {}) !== snap.fingerprint) {
        throw new Error('官方语音配置已更改，请重新开始朗读任务');
      }
      operation.assert();
      if (Array.from(value).length > 500) throw new Error('官方语音单段最多 500 字');
      const result = await apiRequest('/tts', {
        method: 'POST',
        body: { text: value },
        signal: operation.signal,
      });
      operation.assert();
      const after = await readPublicConfig({ signal: operation.signal });
      if (fingerprint(after?.tts || {}) !== snap.fingerprint) {
        throw new Error('官方语音配置已更改，本次音频已丢弃，请重新开始朗读任务');
      }
      operation.assert();
      const audio = Buffer.from(String(result?.audio || ''), 'base64');
      if (!audio.length) throw new Error('官方语音返回了空音频');
      return {
        audio,
        contentType: clip(result?.contentType || 'audio/mpeg', 80),
        bytes: audio.length,
      };
    } catch (error) {
      if (operation.timedOut()) throw timeoutError();
      if (disposed || signal?.aborted) throw abortError();
      throw error;
    } finally {
      operation.cleanup();
    }
  }

  async function synthesizeExtension(value, snap, signal) {
    ensureOpen();
    if (signal?.aborted) throw abortError();
    const loaded = await loadVoiceActions();
    if (!loaded.longForm) throw new Error('语音回复扩展缺少长文合成能力，无法朗读长文');
    if (snap.actionsKey && loaded.key !== snap.actionsKey) {
      throw new Error('语音回复扩展已更新，请重新开始朗读任务');
    }
    const work = Promise.resolve().then(() => loaded.longForm({
      text: clip(value, 1000),
      values: snap.values,
      profileId: snap.profileId,
    }));
    work.catch(() => {});
    let result;
    try {
      result = await new Promise((resolvePromise, reject) => {
        const onAbort = () => reject(abortError());
        signal?.addEventListener?.('abort', onAbort, { once: true });
        work.then(
          (valueOut) => { signal?.removeEventListener?.('abort', onAbort); resolvePromise(valueOut); },
          (error) => { signal?.removeEventListener?.('abort', onAbort); reject(error); },
        );
      });
    } catch (error) {
      if (signal?.aborted) throw abortError();
      throw new Error(publicError(error, '语音回复扩展调用失败'));
    }
    if (signal?.aborted || disposed) throw abortError();
    const data = await actionData(async () => result, {});
    const audio = Buffer.from(String(data?.wavBase64 || ''), 'base64');
    if (!audio.length) throw new Error('语音回复扩展返回了空 WAV');
    return {
      audio,
      contentType: clip(data?.contentType || 'audio/wav', 80),
      bytes: audio.length,
    };
  }

  const voice = Object.freeze({
    async listSources() {
      ensureOpen();
      return await voiceListSources();
    },

    async snapshot(selection = {}, key = '') {
      ensureOpen();
      const source = clip(selection.source, 24);
      if (source === 'extension') return await extensionSnapshot(selection, key);
      if (source === 'official') return await officialSnapshot(selection, key);
      throw new Error('未知语音来源');
    },

    async synthesizeSegment(text, snapshot, { signal } = {}) {
      ensureOpen();
      const token = clip(snapshot?.token, 180);
      const snap = voiceSnapshots.get(token);
      if (!snap) throw new Error('语音配置快照已过期，请重新开始朗读任务');
      const value = String(text ?? '').trim();
      if (!value) throw new Error('语音分段为空');
      if (snap.source === 'extension') return await synthesizeExtension(value, snap, signal);
      if (snap.source !== 'official') throw new Error('未知语音来源');
      return await synthesizeOfficial(value, snap, signal);
    },
  });

  const model = Object.freeze({
    status() {
      let configured = false;
      try { apiBase(); apiToken(); configured = true; } catch {}
      if (!configured) {
        return { configured: false, message: '本地 API 地址或令牌未配置' };
      }
      const selected = configOf()?.model?.default;
      const provider = clip(selected?.provider, 80);
      const name = clip(selected?.model, 160);
      return {
        configured: true,
        provider,
        model: name,
        source: 'host-global',
        ...(provider && name ? {} : { message: '使用宿主当前全局模型选择' }),
      };
    },

    async generate(request = {}) {
      ensureOpen();
      const taskId = clip(request.taskId, 100);
      const stage = clip(request.stage, 40);
      if (!taskId || !stage) throw new Error('模型调用缺少任务阶段');
      const system = clip(request.system, 20_000);
      const messages = (Array.isArray(request.messages) ? request.messages : [])
        .map((message) => {
          const role = ['assistant', 'system', 'tool'].includes(message?.role) ? message.role : 'user';
          const content = message?.content;
          const text = typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content.filter((part) => part?.type === 'text').map((part) => String(part.text ?? '')).join('\n')
              : content == null ? '' : String(content);
          return { role, text: clip(text, 30_000) };
        })
        .filter((message) => message.text);
      if (!messages.length) throw new Error('模型调用缺少正文提示');
      const safe = (value) => clip(value, 60).replace(/[^\w.-]+/g, '_');
      const sessionId = `novel:${safe(taskId)}:${safe(stage)}:${randomUUID().slice(0, 8)}`;
      const section = {
        name: 'novel-writer-system',
        order: 100,
        text: system || '你是小说创作服务，只处理当前小说写作任务。',
      };
      const prompt = messages.map((message) => `[${message.role}]\n${message.text}`).join('\n\n');
      const operation = makeOperation(request.signal, apiTimeoutMs);
      let requested = false;
      const startedAt = now();
      try {
        requested = true;
        await apiRequest('/agent.new', {
          method: 'POST',
          body: { sessionId, clientId: 'novel-writer', persist: false, sections: [section] },
          signal: operation.signal,
        });
        operation.assert();
        const result = await apiRequest('/agent.prompt?wait=1', {
          method: 'POST',
          body: { sessionId, text: prompt },
          signal: operation.signal,
        });
        operation.assert();
        const text = String(result?.text ?? '').trim();
        if (!text) throw new Error('模型没有返回正文');
        return {
          text,
          provider: '',
          model: '',
          source: 'host-global',
          ms: Math.max(0, now() - startedAt),
        };
      } catch (error) {
        if (operation.timedOut()) throw timeoutError();
        if (disposed || request.signal?.aborted) throw abortError();
        throw error;
      } finally {
        if (requested) await closeSession(sessionId);
        operation.cleanup();
      }
    },
  });

  async function closeSession(sessionId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, closeTimeoutMs));
    timer.unref?.();
    try {
      await apiRequest('/agent.close', {
        method: 'POST',
        body: { sessionId },
        signal: controller.signal,
        timeoutMs: closeTimeoutMs,
      });
    } catch (error) {
      say(`关闭模型会话失败：${publicError(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  function depsDir() {
    const explicit = clip(env.ROOST_DEPS_DIR, 4096);
    if (explicit) return resolve(explicit);
    let dshRoot = '';
    if (root && basename(root) === 'novel-writer' && basename(dirname(root)) === 'extensions') {
      dshRoot = dirname(dirname(root));
    }
    if (!dshRoot) {
      const parent = dirname(resolve(dataDir));
      dshRoot = basename(parent) === 'extension-data' ? dirname(parent) : parent;
    }
    return join(dshRoot, 'deps');
  }

  function managedFfmpeg() {
    const base = join(depsDir(), 'node_modules', '@ffmpeg-installer');
    const names = binaryNames();
    const exact = platformDir();
    if (exact) {
      const candidate = join(base, exact, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
      if (existsSync(candidate)) return candidate;
      const windowsCandidate = join(base, exact, 'ffmpeg.exe');
      if (existsSync(windowsCandidate)) return windowsCandidate;
    }
    try {
      for (const entry of readdirSync(base)) {
        for (const name of names) {
          const candidate = join(base, entry, name);
          if (existsSync(candidate)) return candidate;
        }
      }
    } catch {}
    return '';
  }

  function ffmpeg() {
    const managed = managedFfmpeg();
    if (managed) return { path: managed, source: 'managed' };
    const system = findInPath(env);
    if (system) return { path: system, source: 'system' };
    return { path: '', source: '' };
  }

  const dependencies = Object.freeze({
    status() {
      const found = ffmpeg();
      return {
        ready: Boolean(found.path),
        ffmpeg: found.path,
        source: found.source,
        depsDir: depsDir(),
        managed: found.source === 'managed',
        installSupported: false,
        packages: [{
          name: '@ffmpeg-installer/ffmpeg',
          available: Boolean(found.path),
          path: found.path,
          source: found.source,
        }],
        ...(found.path ? {} : {
          message: '未找到 FFmpeg。请在宿主共享依赖面板安装 @ffmpeg-installer/ffmpeg，或把 ffmpeg 加入 PATH。',
        }),
      };
    },

    async install() {
      return {
        ok: false,
        code: 'unsupported',
        message: '小说扩展不会自行安装共享依赖。请在宿主共享依赖面板安装 @ffmpeg-installer/ffmpeg，或把 ffmpeg 加入 PATH。',
      };
    },
  });

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const controller of inflight) {
      try { controller.abort(); } catch {}
    }
    inflight.clear();
    voiceSnapshots.clear();
  }

  return Object.freeze({
    version: 1,
    dataDir: resolve(dataDir),
    ffmpegBinary: () => ffmpeg().path,
    model,
    voice,
    artifacts,
    dependencies,
    dispose,
    close: dispose,
  });
}
