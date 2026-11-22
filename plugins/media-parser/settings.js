import fs from 'node:fs/promises';
import path from 'node:path';

export const PLATFORM_IDS = Object.freeze([
  'bilibili', 'douyin', 'kuaishou', 'acfun', 'hongguo', 'netease', 'ximalaya',
  'weibo', 'xiaohongshu', 'xianyu', 'toutiao', 'xiaoheihe', 'xueqiu', 'wechat',
  'zhihu', 'tieba', 'nga', 'hupu', 'douban', 'v2ex', 'juejin', 'csdn', 'cnblogs',
  'gitee', 'tiktok', 'youtube', 'steam', 'twitter', 'pixiv', 'github', 'gitlab',
]);

export const PLATFORM_NAMES = Object.freeze({
  bilibili: '哔哩哔哩', douyin: '抖音', kuaishou: '快手', acfun: 'AcFun',
  hongguo: '红果短剧', netease: '网易云音乐', ximalaya: '喜马拉雅', weibo: '微博',
  xiaohongshu: '小红书', xianyu: '闲鱼', toutiao: '今日头条', xiaoheihe: '小黑盒',
  xueqiu: '雪球', wechat: '微信', zhihu: '知乎', tieba: '百度贴吧', nga: 'NGA',
  hupu: '虎扑', douban: '豆瓣', v2ex: 'V2EX', juejin: '掘金', csdn: 'CSDN',
  cnblogs: '博客园', gitee: 'Gitee', tiktok: 'TikTok', youtube: 'YouTube',
  steam: 'Steam', twitter: 'X / Twitter', pixiv: 'Pixiv', github: 'GitHub', gitlab: 'GitLab',
});

// Use the engine's exact values; the page labels these as 仅文字 / 仅媒体.
export const PLATFORM_MODES = Object.freeze(['全部发送', '仅文本', '仅富媒体', '关闭']);
export const DEFAULTS = Object.freeze({
  enabled: true, privateEnabled: true, requireMention: false,
  engineMode: 'managed', engineUrl: 'http://127.0.0.1:3199',
  maxLinks: 3, maxFileMiB: 200, timeoutSeconds: 300, concurrency: 2,
  queueLimit: 10, queueWaitSeconds: 30, dedupeSeconds: 120,
  sendCaption: true, handleTextOnly: false, audioMode: 'auto',
  cacheSeconds: 1800, hotComments: 0, translation: false,
  pythonPath: '', ffmpegPath: '', externalCacheRoot: '',
});

const NUMBERS = {
  maxLinks: [1, 3], maxFileMiB: [1, 200], timeoutSeconds: [5, 300],
  concurrency: [1, 8], queueLimit: [0, 100], queueWaitSeconds: [1, 30],
  dedupeSeconds: [0, 3600], cacheSeconds: [60, 86400], hotComments: [0, 20],
};
const SECRET_KEY = /(?:cookie|token|password|passwd|secret|api[_-]?key|authorization|access[_-]?key|credential)/i;
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
export const MASK = '••••••••';

export function readConfig(ctx) {
  const out = {};
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const raw = ctx?.config?.[key];
    const value = raw && typeof raw === 'object' && 'default' in raw ? raw.default : raw;
    out[key] = value === undefined || value === null ? fallback : value;
    if (typeof fallback === 'boolean') out[key] = out[key] === true || out[key] === 'true';
    else if (NUMBERS[key]) {
      const [min, max] = NUMBERS[key];
      const n = Number(out[key]);
      out[key] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
    } else out[key] = String(out[key]).trim();
  }
  if (!['managed', 'external'].includes(out.engineMode)) out.engineMode = DEFAULTS.engineMode;
  if (!['auto', 'voice', 'file'].includes(out.audioMode)) out.audioMode = 'auto';
  return out;
}

export function validateConfig(patch) {
  if (!isObject(patch)) throw new Error('配置必须是 JSON 对象');
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULTS)) throw new Error(`未知配置：${key}`);
    const fallback = DEFAULTS[key];
    if (typeof fallback === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(`${key} 必须是布尔值`);
      out[key] = value;
    } else if (NUMBERS[key]) {
      const [min, max] = NUMBERS[key];
      if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} 范围为 ${min}～${max}`);
      out[key] = value;
    } else {
      if (typeof value !== 'string' || value.length > 2048 || /[\0\r\n]/.test(value)) throw new Error(`${key} 格式不合法`);
      out[key] = value.trim();
    }
  }
  if (out.engineMode && !['managed', 'external'].includes(out.engineMode)) throw new Error('引擎模式必须为 managed 或 external');
  if (out.audioMode && !['auto', 'voice', 'file'].includes(out.audioMode)) throw new Error('音频模式必须为 auto、voice 或 file');
  if (out.engineUrl !== undefined) {
    let url;
    try { url = new URL(out.engineUrl); } catch { throw new Error('引擎地址不合法'); }
    if (url.protocol !== 'http:' ||
        !['127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.username || url.password || url.search || url.hash ||
        !['', '/'].includes(url.pathname)) throw new Error('引擎地址只允许 http://127.0.0.1:端口 或 http://[::1]:端口');
    out.engineUrl = url.origin;
  }
  return out;
}

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function copy(value) { return JSON.parse(JSON.stringify(value)); }

export function deepMerge(base, patch) {
  const out = isObject(base) ? copy(base) : {};
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (UNSAFE_KEYS.has(key)) throw new Error('配置含不允许的键');
    out[key] = isObject(value) && isObject(out[key]) ? deepMerge(out[key], value) : copy(value);
  }
  return out;
}

function assertTree(value, depth = 0, count = { n: 0 }) {
  if (depth > 14 || ++count.n > 5000) throw new Error('配置嵌套或条目过多');
  if (Array.isArray(value)) {
    for (const item of value) assertTree(item, depth + 1, count);
  } else if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(key)) throw new Error('配置含不允许的键');
      assertTree(child, depth + 1, count);
    }
  } else if (!['string', 'number', 'boolean'].includes(typeof value) && value !== null) {
    throw new Error('配置只能含 JSON 值');
  }
}

function splitSecrets(value, prefix = [], secrets = {}, clean = {}) {
  for (const [key, item] of Object.entries(value ?? {})) {
    let urlCredential = false;
    if (typeof item === 'string' && /^[a-z]+:\/\//i.test(item)) {
      try { const url = new URL(item); urlCredential = Boolean(url.username || url.password); } catch {}
    }
    if (SECRET_KEY.test(key) || urlCredential) {
      if (item !== MASK && item !== '********') secrets[key] = copy(item);
    } else if (isObject(item)) {
      const child = splitSecrets(item, [...prefix, key]);
      clean[key] = child.clean;
      if (Object.keys(child.secrets).length) secrets[key] = child.secrets;
    } else {
      // Arrays of named credential records must not silently leak credentials.
      if (Array.isArray(item) && item.some((x) => isObject(x) && Object.keys(x).some((k) => SECRET_KEY.test(k)))) {
        throw new Error('数组内凭据请改用命名对象并单独保存');
      }
      clean[key] = Array.isArray(item) ? item.map((x) => isObject(x) ? redact(x) : x) : copy(item);
    }
  }
  return { clean, secrets };
}

export function redactUrl(value) {
  try {
    const url = new URL(String(value));
    url.username = ''; url.password = '';
    for (const key of url.searchParams.keys()) {
      if (SECRET_KEY.test(key) || /sign|session|auth|ticket/i.test(key)) url.searchParams.set(key, MASK);
    }
    return url.href.slice(0, 2048);
  } catch { return String(value ?? '').slice(0, 2048); }
}

export function redact(value, secrets = []) {
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redact(item, secrets));
  if (isObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(key)) continue;
      out[key] = SECRET_KEY.test(key) ? (item ? MASK : '') : redact(item, secrets);
    }
    return out;
  }
  if (typeof value !== 'string') return value;
  let out = value.slice(0, 16000);
  for (const secret of secrets) if (secret && secret.length >= 4) out = out.split(secret).join(MASK);
  out = out.replace(/\b(?:https?):\/\/[^\s<>"']+/gi, (url) => redactUrl(url));
  return out.replace(/((?:cookie|authorization|api[_-]?key|access[_-]?token)\s*[:=]\s*)[^\r\n]+/gi, `$1${MASK}`);
}

function secretValues(value, out = []) {
  if (isObject(value)) for (const child of Object.values(value)) secretValues(child, out);
  else if (typeof value === 'string' && value) out.push(value);
  return out;
}

export function engineDefaults() {
  return {
    parsers: Object.fromEntries(PLATFORM_IDS.map((id) => [id, '全部发送'])),
    message: {
      opening: { enable: false }, packing: { mode: '不聚合' },
      media_display: { audio_send_mode: '语音', interleave_images: false },
      text_metadata: {
        show_title: true, show_author: true, show_timestamp: true,
        show_original_link: true, show_description: true, quote_user_message: false,
        render_to_image: false,
      },
      hot_comments: { count: 0 },
    },
    download: { max_video_size_mb: 200, max_audio_size_mb: 200, max_concurrent: 2 },
    translation: { enable: false },
  };
}

async function readJson(file, fallback) {
  try {
    const text = await fs.readFile(file, 'utf8');
    if (Buffer.byteLength(text) > 256 * 1024) throw new Error('配置文件超过 256 KiB');
    const data = JSON.parse(text);
    assertTree(data);
    if (!isObject(data)) throw new Error('配置文件必须是对象');
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, file);
}

export function createSettings(ctx) {
  if (!ctx?.dataDir) throw new Error('宿主未提供插件数据目录');
  const advancedFile = path.join(ctx.dataDir, 'engine-settings.json');
  const credentialsFile = path.join(ctx.dataDir, 'credentials.json');
  let advanced = engineDefaults();
  let credentials = {};
  let writeTail = Promise.resolve();
  const serial = (fn) => {
    const result = writeTail.then(fn);
    writeTail = result.catch(() => {});
    return result;
  };
  const normalize = () => {
    const cfg = readConfig(ctx);
    advanced.parsers ??= {};
    for (const id of PLATFORM_IDS) {
      if (!PLATFORM_MODES.includes(advanced.parsers[id])) advanced.parsers[id] = '全部发送';
    }
    advanced.translation ??= {};
    advanced.translation.enable = cfg.translation;
    delete advanced.translation.enabled;
    advanced.message ??= {};
    advanced.message.hot_comments = { ...advanced.message.hot_comments, count: cfg.hotComments };
    advanced.message.text_metadata = { ...advanced.message.text_metadata, quote_user_message: false };
    advanced.download = {
      ...advanced.download,
      max_video_size_mb: Math.min(Number(advanced.download?.max_video_size_mb) || cfg.maxFileMiB, cfg.maxFileMiB),
      max_audio_size_mb: Math.min(Number(advanced.download?.max_audio_size_mb) || cfg.maxFileMiB, cfg.maxFileMiB),
    };
  };
  const ready = serial(async () => {
    const loaded = splitSecrets(await readJson(advancedFile, {}));
    advanced = deepMerge(advanced, loaded.clean);
    credentials = deepMerge(await readJson(credentialsFile, {}), loaded.secrets);
    normalize();
    await writeJson(advancedFile, advanced);
    await writeJson(credentialsFile, credentials);
  });
  const api = {
    ready, advancedFile, credentialsFile,
    current: () => ({ ...readConfig(ctx), platformModes: { ...advanced.parsers } }),
    publicConfig: () => ({ ...readConfig(ctx) }),
    advanced: () => redact(copy(advanced), secretValues(credentials)),
    sanitize: (value) => redact(value, secretValues(credentials)),
    credentialHints: () => {
      const out = {};
      const visit = (obj, prefix = '') => {
        for (const [key, value] of Object.entries(obj)) {
          const full = prefix ? `${prefix}.${key}` : key;
          if (isObject(value)) visit(value, full);
          else out[full] = { set: Boolean(value), value: value ? MASK : '' };
        }
      };
      visit(credentials);
      return out;
    },
    platforms: () => PLATFORM_IDS.map((id) => ({
      id, name: PLATFORM_NAMES[id], mode: advanced.parsers[id],
      enabled: advanced.parsers[id] !== '关闭', verification: '未联网验证',
    })),
    async saveConfig(patch) {
      const valid = validateConfig(patch);
      await ready;
      return serial(async () => {
        if (typeof ctx.setConfig !== 'function') throw new Error('宿主不支持写插件配置');
        await ctx.setConfig(valid);
        normalize();
        await writeJson(advancedFile, advanced);
        return api.publicConfig();
      });
    },
    async saveAdvanced(patch) {
      if (!isObject(patch) || Buffer.byteLength(JSON.stringify(patch)) > 256 * 1024) throw new Error('高级配置必须是 256 KiB 内的 JSON 对象');
      assertTree(patch);
      if (patch.parsers && (!isObject(patch.parsers) || Object.entries(patch.parsers).some(([id, mode]) => !PLATFORM_IDS.includes(id) || !PLATFORM_MODES.includes(mode)))) throw new Error('平台 ID 或输出模式不合法');
      await ready;
      return serial(async () => {
        const parts = splitSecrets(patch);
        // The managed host owns transport authentication and cache roots.
        delete parts.clean.qq;
        advanced = deepMerge(advanced, parts.clean);
        credentials = deepMerge(credentials, parts.secrets);
        normalize();
        await writeJson(advancedFile, advanced);
        await writeJson(credentialsFile, credentials);
        return api.advanced();
      });
    },
    async saveCredentials(patch) {
      if (!isObject(patch)) throw new Error('凭据必须是 JSON 对象');
      assertTree(patch);
      if (Buffer.byteLength(JSON.stringify(patch)) > 128 * 1024) throw new Error('凭据过大');
      const parts = splitSecrets(patch);
      const hasLeaf = (obj) => Object.values(obj).some((x) => isObject(x) ? hasLeaf(x) : x !== undefined);
      if (hasLeaf(parts.clean)) throw new Error('凭据配置只接受 cookie、token、api_key 等字段');
      await ready;
      return serial(async () => {
        credentials = deepMerge(credentials, parts.secrets);
        await writeJson(credentialsFile, credentials);
        return api.credentialHints();
      });
    },
    flush: () => writeTail,
  };
  return api;
}
