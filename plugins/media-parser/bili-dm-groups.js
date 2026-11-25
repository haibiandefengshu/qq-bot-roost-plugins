const CACHE_KEY = 'mediaParserDmGroupIds';
const MAX_CACHE = 200;
const MAX_STATS_ROWS = 50;
const MAX_ID_LENGTH = 200;
const MAX_NAME_LENGTH = 80;

export const GROUP_EMPTY_HINT = '群列表来自机器人最近识别的群，未出现请在目标群发一条消息后刷新';

function safeId(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > MAX_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(text)) return '';
  return text;
}

function safeName(value) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.slice(0, MAX_NAME_LENGTH);
}

function groupKind(row) {
  if (!row || typeof row !== 'object') return '';
  return String(row.kind ?? row.chatKind ?? row.scene ?? '').toLowerCase();
}

function groupIdOf(row, key) {
  if (!row || typeof row !== 'object') return '';
  return safeId(row.groupOpenid ?? row.groupId ?? row.chatId ?? row.chat_id ?? row.id ?? key);
}

export function createBiliDmGroupCatalog({ ctx, store, isActive = () => true } = {}) {
  if (!ctx || typeof ctx !== 'object') throw new TypeError('createBiliDmGroupCatalog requires the host context');
  ctx.state ??= {};
  let ids = Array.isArray(ctx.state[CACHE_KEY])
    ? ctx.state[CACHE_KEY].map(safeId).filter(Boolean).slice(0, MAX_CACHE)
    : [];

  const active = () => {
    try { return isActive() === true; } catch { return false; }
  };

  const persist = () => {
    ctx.state[CACHE_KEY] = ids.slice(0, MAX_CACHE);
  };

  const binding = () => {
    try {
      const value = typeof store?.binding === 'function' ? store.binding() : null;
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  };

  function observe(msg) {
    if (!active() || !msg || msg.kind !== 'group') return false;
    if (msg.isBot || msg.isSelf || msg.self || msg.raw?.author?.is_you || msg.raw?.author?.bot) return false;
    const id = safeId(msg.groupId || msg.chatId);
    if (!id) return false;
    ids = [id, ...ids.filter((item) => item !== id)].slice(0, MAX_CACHE);
    persist();
    return true;
  }

  async function statsIds() {
    const ledger = ctx.ledger;
    if (!ledger || typeof ledger.stats !== 'function') return [];
    let stats;
    try { stats = await Promise.resolve(ledger.stats()); } catch { return []; }
    const byChat = stats && typeof stats === 'object' ? stats.byChat : null;
    if (!byChat) return [];
    let entries = [];
    if (byChat instanceof Map) entries = [...byChat.entries()];
    else if (Array.isArray(byChat)) {
      entries = byChat.map((row) => Array.isArray(row) && row.length === 2 ? [row[0], row[1]] : ['', row]);
    } else if (typeof byChat === 'object') entries = Object.entries(byChat);
    const out = [];
    for (const [key, row] of entries.slice(0, MAX_STATS_ROWS)) {
      if (groupKind(row) !== 'group') continue;
      const id = groupIdOf(row, key);
      if (id) out.push(id);
    }
    return out;
  }

  async function verify(id) {
    const groupId = safeId(id);
    if (!groupId || typeof ctx.getGroup !== 'function') return null;
    let profile;
    try { profile = await ctx.getGroup(groupId); } catch { return null; }
    if (!profile || typeof profile !== 'object' || profile.enabled === false) return null;
    const owned = profile.groupOpenid || profile.groupId || profile.chatId;
    if (owned !== undefined && safeId(owned) !== groupId) return null;
    return { id: groupId, name: safeName(profile.name) || safeName(profile.note) || '未命名群' };
  }

  async function list() {
    const saved = binding();
    const selectedGroup = safeId(saved.notifyKind === 'group' ? saved.groupTarget : '');
    const selected = {
      sendToGroup: Boolean(saved.notifyKind === 'group' && selectedGroup),
      groupId: selectedGroup,
    };
    if (!active()) return { groups: [], selected };
    const candidates = [];
    const add = (id) => {
      const value = safeId(id);
      if (value && !candidates.includes(value) && candidates.length < MAX_CACHE) candidates.push(value);
    };
    add(selected.groupId);
    for (const id of await statsIds()) add(id);
    for (const id of ids) add(id);
    const groups = [];
    for (const id of candidates) {
      if (!active()) return { groups: [], selected };
      const group = await verify(id);
      if (group) groups.push(group);
    }
    return { groups, selected };
  }

  async function resolve(groupId) {
    if (!active()) return null;
    return verify(groupId);
  }

  return { observe, list, resolve };
}
