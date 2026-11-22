import { PLATFORM_IDS } from './settings.js';

export const PLATFORM_DOMAINS = Object.freeze({
  bilibili: ['bilibili.com', 'b23.tv'],
  douyin: ['douyin.com', 'iesdouyin.com'],
  kuaishou: ['kuaishou.com', 'gifshow.com', 'chenzhongtech.com', 'kspkg.com'],
  acfun: ['acfun.cn'], hongguo: ['hongguoduanju.com', 'novelquickapp.com'],
  netease: ['music.163.com', '163cn.tv'], ximalaya: ['ximalaya.com', 'xima.tv'],
  weibo: ['weibo.com', 'weibo.cn', 't.cn'],
  xiaohongshu: ['xiaohongshu.com', 'xhslink.com', 'xhslink.cn'],
  xianyu: ['goofish.com', 'm.tb.cn'], toutiao: ['toutiao.com', 'toutiaoapi.com'],
  xiaoheihe: ['xiaoheihe.cn'],
  xueqiu: ['xueqiu.com'], wechat: ['mp.weixin.qq.com', 'weixin.qq.com', 'channels.weixin.qq.com'],
  zhihu: ['zhihu.com'], tieba: ['tieba.baidu.com'], nga: ['bbs.nga.cn', 'ngabbs.com', 'nga.178.com'],
  hupu: ['hupu.com'], douban: ['douban.com', 'dou.bz', 'doubanurl.cn', 'arkread.com'],
  v2ex: ['v2ex.com'], juejin: ['juejin.cn'], csdn: ['blog.csdn.net'], cnblogs: ['cnblogs.com'],
  gitee: ['gitee.com'], tiktok: ['tiktok.com'], youtube: ['youtube.com', 'youtube-nocookie.com', 'youtu.be'],
  steam: ['store.steampowered.com', 'steamcommunity.com'], twitter: ['twitter.com', 'x.com', 't.co'],
  pixiv: ['pixiv.net'], github: ['github.com'], gitlab: ['gitlab.com'],
});

const URL_RE = /https?:\/\/[^\s<>"'，。！？；：、（）【】《》「」]+/gi;
const BILI_ID_RE = /(?<![a-z0-9_/:.=-])(?:BV[a-z0-9]{10}(?![a-z0-9])|av\d+(?![a-z0-9]))(?:\?[^\s<>"'，。！？；：、（）【】《》「」]*)?/gi;

export function trimShareUrl(value) {
  let out = String(value ?? '').replace(/&amp;/gi, '&').replace(/[\u200B-\u200D\uFEFF]/g, '');
  out = out.replace(/[.,;!?:，。！？；：、）】》」]+$/u, '');
  for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
    while (out.endsWith(close) && out.split(close).length > out.split(open).length) out = out.slice(0, -1);
  }
  return out;
}

export function platformOf(value) {
  let url;
  try { url = new URL(trimShareUrl(value)); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port))) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'live.bilibili.com' || host === 'live.douyin.com' || host === 'live.kuaishou.com') return null;
  for (const id of PLATFORM_IDS) {
    if (PLATFORM_DOMAINS[id].some((domain) => host === domain || host.endsWith(`.${domain}`))) return id;
  }
  return null;
}

// Only explicit link fields from a real structured card are inspected. A card
// placeholder and local attachment path cannot become a guessed download URL.
export function structuredLinks(msg) {
  const result = [];
  const seen = new Set();
  let nodes = 0;
  const walk = (value, depth = 0) => {
    if (++nodes > 500 || depth > 7 || result.length >= 30 || !value) return;
    if (typeof value === 'string') {
      if (value.length < 128 * 1024 && /^\s*[\[{]/.test(value)) {
        try { walk(JSON.parse(value), depth + 1); } catch {}
      }
      return;
    }
    if (typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) { for (const item of value.slice(0, 50)) walk(item, depth + 1); return; }
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:url|href|jump_?url|target_?url|qqdocurl|share_?url)$/i.test(key) && typeof item === 'string' && /^https?:\/\//i.test(item)) result.push(item);
      else if (typeof item === 'object' || /^(?:data|json|content)$/i.test(key)) walk(item, depth + 1);
    }
  };
  walk(msg?.cards);
  walk(msg?.embeds);
  walk(msg?.raw?.embeds);
  walk(msg?.raw?.ark);
  walk(msg?.raw?.json);
  walk(msg?.raw?.message);
  walk(msg?.raw?.card);
  return result;
}

export function extractLinks(input, { maxLinks = 3, platformModes = {}, includeDisabled = false } = {}) {
  const msg = typeof input === 'string' ? null : input;
  const text = String(msg ? msg.content ?? '' : input ?? '').slice(0, 128 * 1024);
  const candidates = [];
  const covered = [];
  for (const match of text.matchAll(URL_RE)) {
    const raw = trimShareUrl(match[0]);
    covered.push([match.index, match.index + match[0].length]);
    candidates.push({ url: raw, position: match.index, from: 'text' });
  }
  for (const match of text.matchAll(BILI_ID_RE)) {
    if (covered.some(([start, end]) => match.index >= start && match.index < end)) continue;
    candidates.push({
      url: `https://www.bilibili.com/video/${trimShareUrl(match[0])}`,
      position: match.index, from: 'bilibili-id',
    });
  }
  for (const [index, url] of structuredLinks(msg).entries()) candidates.push({ url: trimShareUrl(url), position: text.length + index, from: 'card' });
  candidates.sort((a, b) => a.position - b.position);
  const unique = new Set();
  const out = [];
  const limit = Math.min(3, Math.max(1, Number(maxLinks) || 3));
  for (const candidate of candidates) {
    if (candidate.url.length > 4096) continue;
    const platform = platformOf(candidate.url);
    if (!platform || (!includeDisabled && platformModes[platform] === '关闭')) continue;
    const url = new URL(candidate.url);
    // Fragment can identify a music resource (网易云 #/song); query identifies
    // pages, episodes and signed shares and must stay part of the resource key.
    const key = url.href;
    if (unique.has(key)) continue;
    unique.add(key);
    out.push({ ...candidate, url: key, key, platform });
    if (out.length === limit) break;
  }
  return out;
}

const escapedDomains = [...new Set(Object.values(PLATFORM_DOMAINS).flat())]
  .map((domain) => domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
// Keep middleware guidance generated from the same host table as recognition.
export const REPLY_JUDGE_BYPASS = String.raw`https?:\/\/(?:[a-z0-9-]+\.)*(?:${escapedDomains})(?::(?:80|443))?(?=[\/?#\s]|$)|(?<![a-z0-9_/:.=-])(?:BV[a-z0-9]{10}(?![a-z0-9])|av\d+(?![a-z0-9]))`;
