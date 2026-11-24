import { clip, hash, multilineClip, shortId } from './util.mjs';

const TEXT_FIELDS = Object.freeze({
  name: [80, false],
  identity: [300, false],
  appearance: [3000, true],
  personality: [4000, true],
  relationship: [2000, true],
  goal: [2000, true],
  conflict: [2000, true],
  secret: [2000, true],
  arc: [3000, true],
  speech: [2000, true],
  notes: [4000, true],
});

function aliases(value) {
  const rows = Array.isArray(value) ? value : String(value ?? '').split(/[、,，\n]/);
  return [...new Set(rows.map((item) => clip(item, 80)).filter(Boolean))].slice(0, 30);
}

export function normalizePersona(value = {}, { createId = false } = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const person = {
    id: clip(source.id, 100) || (createId ? shortId('person') : ''),
    aliases: aliases(source.aliases),
  };
  for (const [field, [max, multiline]] of Object.entries(TEXT_FIELDS)) {
    const raw = Array.isArray(source[field])
      ? source[field].map((item) => String(item ?? '').trim()).filter(Boolean).join('\n')
      : source[field];
    person[field] = multiline ? multilineClip(raw, max) : clip(raw, max);
  }
  if (!person.name) throw new Error('人物姓名不能为空');
  return person;
}

export function normalizeBookPersonas(people) {
  if (!Array.isArray(people)) return [];
  const seen = new Set();
  const result = [];
  for (const [index, value] of people.slice(0, 200).entries()) {
    try {
      const person = normalizePersona(value);
      if (!person.id) {
        person.id = `legacy-${hash('person', index, person.name, person.identity, person.personality).slice(0, 32)}`;
      }
      if (seen.has(person.id)) person.id = `${person.id}-${index}`;
      seen.add(person.id);
      result.push(person);
    } catch {
      // 旧版异常条目保留在磁盘里，不拖垮整本书的其他资料。
    }
  }
  return result;
}

export function personaContext(person) {
  const card = normalizePersona(person);
  return [
    `姓名：${card.name}`,
    card.aliases.length ? `别名：${card.aliases.join('、')}` : '',
    `身份：${card.identity || '未设定'}`,
    card.appearance ? `外貌：${card.appearance}` : '',
    `性格：${card.personality || '未设定'}`,
    `关系：${card.relationship || '未设定'}`,
    `目标：${card.goal || '未设定'}`,
    card.conflict ? `核心冲突：${card.conflict}` : '',
    card.secret ? `秘密或隐情：${card.secret}` : '',
    card.arc ? `人物弧光：${card.arc}` : '',
    card.speech ? `语言风格：${card.speech}` : '',
    card.notes ? `补充设定：${card.notes}` : '',
  ].filter(Boolean).join('｜');
}

export const PERSONA_SYSTEM = [
  '你是小说角色设定编辑，只依据当前书籍的固定资料创建一张可直接用于写作的人设卡。',
  '不要读取聊天记录、调用工具或输出本地路径。',
  '角色必须与既有世界观、剧情和其他人物兼容，避免与现有同名人物冲突。',
  '只输出一个 JSON 对象，不要 Markdown 代码围栏或 JSON 之外的文字。',
  '字段：name、aliases（字符串数组）、identity、appearance、personality、relationship、goal、conflict、secret、arc、speech、notes。',
].join('\n');

export function personaPrompt(book, hint = '') {
  const people = normalizeBookPersonas(book?.people)
    .map((person) => personaContext(person))
    .join('\n') || '尚无人物';
  return [
    `书名：${book?.title || '未命名小说'}`,
    `题材：${book?.settings?.genre || '未设定'}`,
    `核心故事：${book?.settings?.core || '未设定'}`,
    `世界观：${book?.settings?.world || '未设定'}`,
    `文风：${book?.settings?.style || '未设定'}`,
    `现有大纲：${(book?.outline || []).join('\n') || '尚无'}`,
    `现有角色：\n${people}`,
    `新增角色要求：${clip(hint, 2000) || '根据当前剧情设计一个能推动冲突、具有独立目标和秘密的主要角色。'}`,
    '请只输出一张人设卡的严格 JSON。',
  ].join('\n\n');
}

export function parsePersonaJson(raw) {
  let value = String(raw ?? '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  let parsed;
  try { parsed = JSON.parse(value); }
  catch {
    const start = value.indexOf('{');
    const end = value.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { parsed = JSON.parse(value.slice(start, end + 1)); } catch {}
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('模型没有按要求返回人设卡 JSON');
  }
  return normalizePersona(parsed);
}
