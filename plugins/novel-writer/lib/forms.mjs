import {
  DRAFT_EXPIRE_MS, DRAFT_PAUSE_MS, clip, multilineClip,
} from './util.mjs';

const NEW_STEPS = [
  'title', 'core', 'genre', 'world', 'style', 'avoid', 'people_ask',
  'person_name', 'person_identity', 'person_personality', 'person_relation',
  'person_goal', 'after_person', 'target_chars', 'review',
];

const STEP_FIELD = {
  title: 'title',
  core: 'core',
  genre: 'genre',
  world: 'world',
  style: 'style',
  avoid: 'avoid',
  person_name: 'name',
  person_identity: 'identity',
  person_personality: 'personality',
  person_relation: 'relationship',
  person_goal: 'goal',
  target_chars: 'targetChars',
};

const MULTI_STEPS = new Set(['world', 'style', 'avoid', 'person_personality', 'person_goal']);

const LABELS = {
  title: '书名',
  core: '核心故事',
  genre: '题材',
  world: '世界观',
  style: '文风',
  avoid: '不希望出现的内容',
  person_name: '人物姓名',
  person_identity: '人物身份',
  person_personality: '人物性格',
  person_relation: '人物关系',
  person_goal: '人物目标',
  target_chars: '目标字数',
};

export const DRAFT_COMMANDS = new Set(['完成', '跳过', '上一步', '暂停', '取消']);

function clone(value) {
  return structuredClone(value);
}

function nextStep(step) {
  const index = NEW_STEPS.indexOf(step);
  return NEW_STEPS[Math.min(NEW_STEPS.length - 1, index + 1)] || 'title';
}

function saveHistory(draft) {
  draft.history = Array.isArray(draft.history) ? draft.history : [];
  draft.history.push({
    step: draft.step,
    data: clone(draft.data || {}),
  });
  if (draft.history.length > 32) draft.history.shift();
}

export function newDraft({ title = '' } = {}) {
  const data = { title: clip(title, 80), people: [], targetChars: 3000 };
  return {
    version: 1,
    active: true,
    kind: 'new_book',
    step: data.title ? 'core' : 'title',
    data,
    history: [],
    pausedAt: 0,
    updatedAt: Date.now(),
    lastMessageId: '',
    seenMessages: [],
  };
}

export function importDraft() {
  return {
    version: 1,
    active: true,
    kind: 'import',
    step: 'import_content',
    data: { content: '', fileName: '' },
    history: [],
    pausedAt: 0,
    updatedAt: Date.now(),
    lastMessageId: '',
    seenMessages: [],
  };
}

export function modifyDraft(chapterNo) {
  return {
    version: 1,
    active: true,
    kind: 'modify_chapter',
    step: 'chapter_body',
    data: { chapterNo: Number(chapterNo), title: '', body: '' },
    history: [],
    pausedAt: 0,
    updatedAt: Date.now(),
    lastMessageId: '',
    seenMessages: [],
  };
}

export function outlineDraft() {
  return {
    version: 1,
    active: true,
    kind: 'outline',
    step: 'outline_body',
    data: { lines: [] },
    history: [],
    pausedAt: 0,
    updatedAt: Date.now(),
    lastMessageId: '',
    seenMessages: [],
  };
}

export function pauseDraft(draft, now = Date.now()) {
  draft.pausedAt = now;
  draft.updatedAt = now;
  if (draft.kind === 'new_book') refreshNewPrompt(draft);
  return draft;
}

export function expireDraft(draft, now = Date.now()) {
  if (!draft?.active) return draft;
  const updatedAt = Number(draft.updatedAt) || 0;
  if (updatedAt && now - updatedAt > DRAFT_EXPIRE_MS) {
    return {
      version: 1, active: false, kind: '', step: '', data: {}, history: [],
      pausedAt: 0, updatedAt: now, lastMessageId: '', seenMessages: [], expired: true, expiryChanged: true,
    };
  }
  if (!draft.pausedAt && updatedAt && now - updatedAt > DRAFT_PAUSE_MS) {
    draft.pausedAt = now;
    draft.expiryChanged = true;
  }
  return draft;
}

function currentLabel(draft) {
  const step = draft?.step || '';
  if (draft?.kind === 'new_book') return LABELS[step] || '确认资料';
  if (draft?.kind === 'modify_chapter') return '替换正文';
  if (draft?.kind === 'outline') return '故事大纲';
  if (draft?.kind === 'import') return '导入内容';
  return '填写内容';
}

function refreshNewPrompt(draft) {
  const data = draft.data || {};
  const step = draft.step;
  const prompts = {
    title: '请发送书名（1–80 字）。',
    core: '请用至少一句话说明核心故事。',
    genre: '请发送题材；也可以回复“跳过”。',
    world: '请逐条发送世界观设定，连续内容会按顺序追加；发送“完成”进入下一步。',
    style: '请逐条发送文风要求；发送“完成”进入下一步。',
    avoid: '请逐条发送不希望出现的内容；发送“完成”进入下一步。',
    people_ask: '是否添加主要人物？回复“是”或“否”。',
    person_name: '请发送人物姓名。',
    person_identity: '请发送人物身份。',
    person_personality: '请逐条发送人物性格；发送“完成”进入下一步。',
    person_relation: '请发送这个人物与其他人物/主角的关系。',
    person_goal: '请逐条发送人物目标；发送“完成”进入下一步。',
    after_person: '是否继续添加人物？回复“是”或“否”。',
    target_chars: `请发送单章目标字数（1000–5000），默认 ${data.targetChars || 3000}。`,
    review: [
      '资料已收齐，请回复“确认”正式建书，或回复“上一步”修改。',
      `书名：${data.title || '（未填）'}`,
      `核心故事：${clip(data.core, 240) || '（未填）'}`,
      `题材：${clip(data.genre, 80) || '未填写'}`,
      `单章目标：${Number(data.targetChars) || 3000} 字`,
      `人物：${(data.people || []).map((person) => person.name).join('、') || '未添加'}`,
    ].join('\n'),
  };
  return prompts[step] || '请继续填写。';
}

export function draftPrompt(draft) {
  if (!draft?.active) return '';
  if (draft.kind === 'new_book') return refreshNewPrompt(draft);
  if (draft.kind === 'modify_chapter') {
    return `请逐条发送第 ${draft.data.chapterNo} 章的新正文；发送“完成”后确认保存为新版本。`;
  }
  if (draft.kind === 'outline') {
    return `请逐条发送大纲；发送“完成”保存。累计 ${Array.from((draft.data.lines || []).join('\n')).length} 字。`;
  }
  if (draft.kind === 'import') {
    return draft.data.preview
      ? `导入预览：识别 ${draft.data.preview.chapters?.length || 0} 章、共 ${draft.data.preview.chars || 0} 字。回复“确认”保存为新书，或“取消”。`
      : '请发送 UTF-8 TXT 内容，或带 TXT/JSON 文件发送；发送“完成”解析预览。';
  }
  return '请继续填写。';
}

function personComplete(draft) {
  const data = draft.data;
  const person = {
    id: `person-${Date.now().toString(36)}`,
    name: clip(data.name, 80),
    identity: clip(data.identity, 160),
    personality: Array.isArray(data.personality) ? data.personality.join('\n') : clip(data.personality, 1000),
    relationship: clip(data.relationship, 300),
    goal: Array.isArray(data.goal) ? data.goal.join('\n') : clip(data.goal, 1000),
  };
  data.people = Array.isArray(data.people) ? data.people : [];
  data.people.push(person);
  delete data.name;
  delete data.identity;
  delete data.personality;
  delete data.relationship;
  delete data.goal;
}

export function applyNewBookInput(draft, input, now = Date.now()) {
  const value = multilineClip(input, 50_000);
  if (!value) return { draft, reply: draftPrompt(draft), done: false };
  if (value === '暂停') {
    pauseDraft(draft, now);
    return { draft, reply: `已暂停：${currentLabel(draft)}。七天内发送“/小说 继续”恢复。`, done: false };
  }
  if (value === '取消') {
    return {
      draft: { ...draft, active: false, step: '', data: {}, history: [], pausedAt: 0, updatedAt: now },
      reply: '已取消本次填写；后台任务不受影响。', done: false,
    };
  }
  if (value === '上一步') {
    const previous = draft.history?.pop?.();
    if (!previous) return { draft, reply: `已经是第一步：${draftPrompt(draft)}`, done: false };
    draft.step = previous.step;
    draft.data = previous.data;
    draft.updatedAt = now;
    return { draft, reply: `已返回「${currentLabel(draft)}」。\n${draftPrompt(draft)}`, done: false };
  }

  let step = draft.step;
  if (step === 'title' || step === 'core' || step === 'genre'
      || step === 'person_name' || step === 'person_identity'
      || step === 'person_relation' || step === 'target_chars') {
    if (value !== '跳过' || !['genre', 'person_identity', 'person_relation'].includes(step)) saveHistory(draft);
    const field = STEP_FIELD[step];
    if (step === 'target_chars') {
      const number = Number.parseInt(value, 10);
      if (!['跳过', '完成'].includes(value) && (!Number.isInteger(number) || number < 1000 || number > 5000)) {
        return { draft, reply: '目标字数要在 1000–5000 之间。', done: false };
      }
      draft.data[field] = ['跳过', '完成'].includes(value) ? 3000 : number;
    } else if (value !== '跳过' && value !== '完成') {
      draft.data[field] = clip(value, step === 'core' ? 4000 : 500);
    }
    if (step === 'title' && !draft.data.title) return { draft, reply: '书名不能跳过，请发送 1–80 字书名。', done: false };
    if (step === 'core' && !draft.data.core) return { draft, reply: '核心故事不能跳过，请至少用一句话说明。', done: false };
    if (step === 'person_name' && (value === '跳过' || value === '完成')) {
      return { draft, reply: '人物姓名不能跳过；如需结束添加请回复“取消”后重新进入。', done: false };
    }
    draft.step = nextStep(step);
    draft.updatedAt = now;
    return { draft, reply: draftPrompt(draft), done: false };
  }

  if (MULTI_STEPS.has(step)) {
    if (value === '完成' || value === '跳过') {
      saveHistory(draft);
      if (step === 'person_goal' && value === '完成') personComplete(draft);
      if (step === 'person_goal' && value === '跳过') personComplete(draft);
      draft.step = nextStep(step);
      draft.updatedAt = now;
      return { draft, reply: draftPrompt(draft), done: false };
    }
    saveHistory(draft);
    const field = STEP_FIELD[step];
    const old = String(draft.data[field] || '');
    draft.data[field] = multilineClip(old ? `${old}\n${value}` : value, 12_000);
    draft.updatedAt = now;
    return {
      draft,
      reply: `已保存到「${LABELS[step]}」，累计 ${Array.from(draft.data[field]).length} 字。继续发送，或回复“完成”。`,
      done: false,
    };
  }

  if (step === 'people_ask' || step === 'after_person') {
    if (!['是', '否', '跳过', '完成'].includes(value)) {
      return { draft, reply: '请回复“是”或“否”。', done: false };
    }
    saveHistory(draft);
    draft.step = (value === '是') ? 'person_name' : (step === 'people_ask' ? 'target_chars' : 'target_chars');
    draft.updatedAt = now;
    return { draft, reply: draftPrompt(draft), done: false };
  }

  if (step === 'person_personality' || step === 'person_goal') {
    if (value === '完成') {
      draft.step = nextStep(step);
      draft.updatedAt = now;
      return { draft, reply: draftPrompt(draft), done: false };
    }
    saveHistory(draft);
    const field = STEP_FIELD[step];
    draft.data[field] = Array.isArray(draft.data[field]) ? draft.data[field] : [];
    draft.data[field].push(clip(value, 1000));
    draft.updatedAt = now;
    return {
      draft,
      reply: `已记录${LABELS[step]}第 ${draft.data[field].length} 条。继续发送，或回复“完成”。`,
      done: false,
    };
  }

  // Person goal finishing moves to the "add another?" gate.
  if (step === 'person_goal' && value !== '完成') {
    return { draft, reply: draftPrompt(draft), done: false };
  }
  if (step === 'review') {
    if (value !== '确认') return { draft, reply: '请回复“确认”建书，或“上一步”修改。', done: false };
    if (!draft.data.title || !draft.data.core) return { draft, reply: '书名和核心故事仍是必填。', done: false };
    return {
      draft: { ...draft, active: false, step: '', history: [], pausedAt: 0, updatedAt: now },
      reply: '资料已确认。',
      done: true,
    };
  }
  return { draft, reply: draftPrompt(draft), done: false };
}

/**
 * The previous generic branch returns from person_goal before the add-another
 * gate. Run this small transition immediately after it.
 */
export function normalizePersonTransition(draft) {
  if (draft?.step !== 'after_person') return draft;
  if (draft.data?.name || !Array.isArray(draft.data?.people) || !draft.data.people.length) return draft;
  return draft;
}

export function completePersonIfNeeded(draft) {
  if (!draft?.active || draft.kind !== 'new_book') return false;
  if (draft.step !== 'person_goal') return false;
  personComplete(draft);
  draft.step = 'after_person';
  draft.updatedAt = Date.now();
  return true;
}
