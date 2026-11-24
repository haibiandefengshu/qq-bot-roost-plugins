import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { synthesizeChapter } from './audio.mjs';
import {
  applyNewBookInput, draftPrompt, expireDraft, importDraft, modifyDraft, newDraft,
  outlineDraft, pauseDraft,
} from './forms.mjs';
import {
  PERSONA_SYSTEM, normalizeBookPersonas, normalizePersona,
  parsePersonaJson, personaPrompt,
} from './people.mjs';
import { NovelStore } from './store.mjs';
import {
  backupJson, chapterRange, charCount, parseBackup, parseImportedTxt, readingTxt, txtFileName,
} from './text.mjs';
import {
  AUDIO_SEGMENT_TTL_MS, CLEANUP_INTERVAL_MS, OUTPUT_TTL_MS,
  atomicBytes, atomicJson, clip, hash, multilineClip, safeName, shortId, withLock,
} from './util.mjs';
import {
  WRITER_SYSTEM, buildChapterContext, outlinePrompt, parseChapterJson, parseOutlineJson,
  parseSummaryJson, summaryPrompt,
} from './writing.mjs';

const PLUGIN_VERSION = JSON.parse(
  readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'),
).version;

const SETTING_FIELDS = Object.freeze({
  题材: 'genre', genre: 'genre',
  世界观: 'world', world: 'world',
  文风: 'style', style: 'style',
  避雷: 'avoid', avoid: 'avoid',
  字数: 'targetChars', 目标字数: 'targetChars', targetChars: 'targetChars',
});

const PERSONA_FIELDS = Object.freeze({
  姓名: 'name', name: 'name',
  别名: 'aliases', aliases: 'aliases',
  身份: 'identity', identity: 'identity',
  外貌: 'appearance', appearance: 'appearance',
  性格: 'personality', personality: 'personality',
  关系: 'relationship', relationship: 'relationship',
  目标: 'goal', goal: 'goal',
  冲突: 'conflict', conflict: 'conflict',
  秘密: 'secret', secret: 'secret',
  弧光: 'arc', arc: 'arc',
  语气: 'speech', speech: 'speech',
  备注: 'notes', notes: 'notes',
});

const HELP = Object.freeze({
  总览: [
    '《小说》快速流程',
    '新建小说 → 填写资料 → 续写 → 收 TXT → 按需朗读',
    '',
    '书架：书架、打开、当前状态',
    '设定：设定、人物、大纲',
    '创作：续写、目录、重写、修改、查找',
    '文件：发送、版本、恢复、导入、备份、删除',
    '朗读：朗读、朗读 设置、朗读 状态、自动朗读',
    '任务：任务、停止、重试、领取',
    '',
    '填写中可用：完成 / 跳过 / 上一步 / 暂停 / 取消',
    '群聊只处理 @机器人 的小说填写，或 /小说 提交 <内容>。',
    '发送 /小说 帮助 <分类> 查看完整用法。',
  ].join('\n'),
  书库: [
    '/小说 新建 [书名]：逐条创建个人书籍',
    '/小说 书架 [页]：查看自己的书',
    '/小说 打开 <编号>：切换当前书籍',
    '/小说 删除 <编号>：展示影响并确认删除',
    '',
    '书库按“机器人＋群或私聊＋用户”隔离。',
    '群友只能看到你主动发到群里的 TXT/音频，不能访问底稿。',
  ].join('\n'),
  设定: [
    '/小说 设定：查看当前设定',
    '/小说 设定 <题材|世界观|文风|避雷|目标字数> <内容>',
    '/小说 人设：查看人设卡与增删改用法',
    '/小说 人设 添加 姓名|身份|性格|关系|目标',
    '/小说 人设 修改 <编号> <身份|外貌|性格|关系|目标|冲突|秘密|弧光|语气|备注|别名> <内容>',
    '/小说 大纲：查看大纲',
    '/小说 大纲 添加：逐条追加，完成结束',
    '/小说 大纲 生成：由独立写作模型生成候选',
    '/小说 大纲 确认：应用最近生成的候选',
  ].join('\n'),
  创作: [
    '/小说 续写 [剧情要求]：默认写 1 章，默认约 3000 字',
    '/小说 续写 2章 3500字 剧情要求：批量 1–3 章',
    '/小说 重写 <章号> [要求]：新版本，不删旧稿',
    '/小说 修改 <章号>：逐条提交正文，完成并确认后存新版本',
    '/小说 目录 [页]：章节标题、字数、版本数',
    '/小说 查找 <关键词>：只查当前书',
  ].join('\n'),
  文件: [
    '/小说 发送 [最新/章号/起止范围/全本]：生成阅读 TXT',
    '/小说 版本 <章号>：查看不可变版本',
    '/小说 恢复 <章号> <版本号>：确认后恢复为新版本',
    '/小说 导入：发送 UTF-8 TXT 或备份 JSON',
    '/小说 备份：导出当前书 JSON',
    '/小说 删除 <编号>：确认后删除当前用户的整本书',
    '',
    'TXT 仅含书名、章节标题和正文，UTF-8 BOM、Windows 换行。',
  ].join('\n'),
  朗读: [
    '/小说 朗读 [最新/章号/起止范围]：最多 3 章',
    '/小说 朗读 设置：查看可用来源',
    '/小说 朗读 设置 官方 [音色] [语速]',
    '/小说 朗读 设置 扩展 <音色方案编号或名称> [语速]',
    '/小说 朗读 状态：检查两种来源',
    '/小说 自动朗读 开|关：仅对当前书籍',
    '',
    '音频是普通 MP3 文件，不是 QQ 语音条。',
  ].join('\n'),
  任务: [
    '/小说 任务 [任务号]：查看阶段与进度',
    '/小说 停止 [任务号]：停止当前任务',
    '/小说 重试 [任务号]：从失败阶段恢复',
    '/小说 领取 [任务号]：在全新回复窗口发送待领取成果',
    '',
    '一次最多一个写作任务和一个朗读任务。',
    '重复消息不会重复创建任务；重启时正在执行的任务标记为中断。',
  ].join('\n'),
});

const COMMAND_LIST = [
  '帮助', '新建', '书架', '打开', '设定', '人物', '大纲', '续写', '目录',
  '重写', '修改', '查找', '发送', '版本', '恢复', '朗读', '自动朗读',
  '人设', '任务', '停止', '重试', '领取', '导入', '备份', '删除', '继续', '提交',
];

function helpFor(category = '') {
  const key = clip(category || '总览', 30);
  if (key === '总览') return HELP.总览;
  if (HELP[key]) return `/小说 帮助 ${key}\n\n${HELP[key]}`;
  return `没有「${key}」分类。可用：${Object.keys(HELP).join('、')}`;
}

function pageText(title, rows, page = 1, pageSize = 12) {
  const numbered = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.max(1, Math.min(numbered, Number(page) || 1));
  const chunk = rows.slice((current - 1) * pageSize, current * pageSize);
  return [
    `${title}（${current}/${numbered}）`,
    ...chunk,
    numbered > 1 ? `翻页：/小说 ${title.split(' ')[0]} ${current + 1}` : '',
  ].filter(Boolean).join('\n');
}

function publicError(error) {
  const raw = String(error?.message || error || '未知错误');
  return raw
    .replace(/[A-Za-z]:\\[^\s，；]+/g, '本地路径')
    .replace(/(?:token|secret|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=***')
    .slice(0, 500);
}

function confirmedYes(value) {
  return /^(确认|确定|是|执行)$/.test(String(value ?? '').trim());
}

function serviceClosedError() {
  return Object.assign(new Error('小说服务已关闭，拒绝新的操作'), {
    name: 'ServiceClosedError',
    code: 'SERVICE_CLOSED',
  });
}

function normalizedInvocation(invocation) {
  if (!invocation || invocation.source !== 'qq'
      || !invocation.botId || !invocation.chatId || !invocation.userId
      || !invocation.messageId || !invocation.receivedAt) {
    throw new Error('没有可信的 QQ 消息身份，拒绝访问私人书库');
  }
  if (!['group', 'c2c'].includes(invocation.kind)) {
    throw new Error('小说首版只支持 QQ 群聊和单聊');
  }
}

function removeOldEntries(root, cutoff, now) {
  let removed = 0;
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return removed;
    throw error;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    let stats;
    try { stats = statSync(path); } catch { continue; }
    const touchedAt = Math.min(
      Number(stats.mtimeMs) || now,
      Number(stats.birthtimeMs) || Number(stats.ctimeMs) || now,
    );
    if (touchedAt > cutoff) continue;
    rmSync(path, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

export class NovelService {
  constructor({ runtime, config = {}, log = () => {}, now = Date.now } = {}) {
    if (!runtime?.dataDir) throw new Error('小说扩展缺少宿主专属数据目录');
    this.runtime = runtime;
    this.config = config || {};
    this.log = typeof log === 'function' ? log : () => {};
    this.now = now;
    this.panelGenerateTimeoutMs = 60_000;
    this.store = new NovelStore(runtime.dataDir);
    this.outputDir = join(runtime.dataDir, 'outputs');
    this.workDir = join(runtime.dataDir, 'work');
    mkdirSync(this.outputDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.workDir, { recursive: true, mode: 0o700 });
    this.ownerQueues = new Map();
    this.serialRuns = new Set();
    this.controllers = new Map();
    this.lanes = new Set();
    this.activeRuns = new Set();
    this.closing = false;
    this.shutdownPromise = null;
    this.store.recoverInterrupted();
    this.cleanupTimer = setInterval(
      () => this.cleanupExpired().catch((error) => this.log(`清理过期小说文件失败：${publicError(error)}`)),
      CLEANUP_INTERVAL_MS,
    );
    this.cleanupTimer.unref?.();
    setImmediate(() => {
      this.cleanupExpired().catch((error) => this.log(`清理过期小说文件失败：${publicError(error)}`));
      this.pump();
    });
  }

  serial(owner, fn) {
    if (this.closing) return Promise.reject(serviceClosedError());
    const previous = this.ownerQueues.get(owner) || Promise.resolve();
    const run = () => {
      if (this.closing) throw serviceClosedError();
      return fn();
    };
    const task = previous.then(run, run);
    const tail = task.catch(() => {});
    this.ownerQueues.set(owner, tail);
    tail.then(() => { if (this.ownerQueues.get(owner) === tail) this.ownerQueues.delete(owner); });
    const tracked = task.then(() => {}, () => {});
    this.serialRuns.add(tracked);
    tracked.then(() => this.serialRuns.delete(tracked));
    return task;
  }

  async shutdown({ timeoutMs = 15_000 } = {}) {
    if (this.shutdownPromise) return await this.shutdownPromise;
    this.closing = true;
    try { clearInterval(this.cleanupTimer); } catch {}
    this.cleanupTimer = null;
    this.shutdownPromise = (async () => {
      for (const controller of this.controllers.values()) {
        try {
          controller.abort(Object.assign(new Error('宿主关闭'), { name: 'AbortError' }));
        } catch {}
      }
      const pending = [...this.activeRuns, ...this.serialRuns];
      if (!pending.length) return;
      let timer;
      try {
        await Promise.race([
          Promise.allSettled(pending),
          new Promise((resolve) => {
            timer = setTimeout(resolve, Math.max(1, Number(timeoutMs) || 15_000));
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
    return await this.shutdownPromise;
  }

  async expireOwnerDraft(owner) {
    const next = expireDraft(this.store.draft(owner), this.now());
    if (!next.expired && !next.expiryChanged) return next;
    const stored = structuredClone(next);
    delete stored.expired;
    delete stored.expiryChanged;
    await this.store.updateDraft(owner, () => stored);
    delete next.expired;
    delete next.expiryChanged;
    return next;
  }

  async cleanupExpired(now = this.now()) {
    if (this.closing) return { drafts: 0, segments: 0, outputs: 0 };
    let drafts = 0;
    let entries;
    try { entries = readdirSync(this.store.owners, { withFileTypes: true }); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      entries = [];
    }
    for (const entry of entries) {
      if (this.closing) break;
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const current = this.store.draft(entry.name);
      const next = expireDraft(current, now);
      if (!next.expired && !next.expiryChanged) continue;
      const stored = structuredClone(next);
      delete stored.expired;
      delete stored.expiryChanged;
      await this.store.updateDraft(entry.name, () => stored);
      drafts += 1;
    }

    if (this.closing) return { drafts, segments: 0, outputs: 0 };
    const segments = removeOldEntries(
      join(this.workDir, 'speech'),
      now - AUDIO_SEGMENT_TTL_MS,
      now,
    );
    let outputs = 0;
    if (typeof this.runtime.artifacts?.cleanup === 'function') {
      const result = await this.runtime.artifacts.cleanup({ now, maxAgeMs: OUTPUT_TTL_MS });
      outputs += Number(result?.removed) || 0;
    }
    outputs += removeOldEntries(this.outputDir, now - OUTPUT_TTL_MS, now);
    return { drafts, segments, outputs };
  }

  async handleQq(payload = {}, invocation = null) {
    normalizedInvocation(invocation);
    const owner = this.store.key(invocation);
    const receipt = `command:${invocation.messageId}`;
    return await this.serial(owner, async () => {
      if (this.store.messageSeen(owner, receipt, this.now())) {
        return { handled: true, text: '' };
      }
      const result = await this.#handleQq(payload, invocation, owner);
      if (result?.handled === true) {
        await this.store.rememberMessage(owner, receipt, this.now());
      }
      return result;
    });
  }

  async #handleQq(payload, invocation, owner) {
    const rawText = clip(payload.text, 60_000);
    const args = Array.isArray(payload.args)
      ? payload.args.map((item) => clip(item, 20_000))
      : rawText.split(/\s+/).filter(Boolean);
    const command = clip(payload.command, 30) || '小说';
    if (command !== '小说') return { handled: false };

    const existingDraft = await this.expireOwnerDraft(owner);

    const agg = args.join(' ').trim();
    const sub = args[0] || '';
    if (payload.duplicate === true) return { handled: true, text: '' };
    if (!sub) return this.#rootReply(owner, existingDraft);
    if (sub === '帮助') return { handled: true, text: helpFor(args[1] || '') };

    if (sub === '提交') {
      return await this.#submitDraft(owner, args.slice(1).join(' '), payload, invocation, existingDraft);
    }
    if (sub === '继续') {
      if (!existingDraft.active) return { handled: true, text: '没有可恢复的填写草稿。' };
      existingDraft.pausedAt = 0;
      existingDraft.updatedAt = this.now();
      await this.store.updateDraft(owner, () => existingDraft);
      return { handled: true, text: `已继续。\n${draftPrompt(existingDraft)}` };
    }
    if (sub === '暂停' && existingDraft.active) {
      if (existingDraft.pausedAt) return { handled: true, text: '填写已经暂停。发送 /小说 继续 恢复。' };
      pauseDraft(existingDraft, this.now());
      await this.store.updateDraft(owner, () => existingDraft);
      return { handled: true, text: '填写已暂停，七天内可发送 /小说 继续 恢复。' };
    }

    if (existingDraft.active && existingDraft.pausedAt) {
      return { handled: true, text: `填写已暂停在「${draftPrompt(existingDraft).split('\n')[0]}」。发送 /小说 继续 恢复。` };
    }

    const handlers = {
      新建: () => this.#newBook(owner, args.slice(1).join(' ')),
      书架: () => this.#shelf(owner, args[1]),
      打开: () => this.#openBook(owner, args[1]),
      设定: () => this.#settings(owner, args.slice(1)),
      人物: () => this.#people(owner, args.slice(1)),
      人设: () => this.#people(owner, args.slice(1)),
      大纲: () => this.#outline(owner, args.slice(1), invocation),
      续写: () => this.#continueWriting(owner, args.slice(1), invocation, payload),
      目录: () => this.#catalog(owner, args[1]),
      重写: () => this.#rewrite(owner, args.slice(1), invocation, payload),
      修改: () => this.#modify(owner, args.slice(1)),
      查找: () => this.#search(owner, args.slice(1).join(' ')),
      发送: () => this.#sendTxt(owner, args.slice(1).join(' '), invocation),
      版本: () => this.#versions(owner, args[1]),
      恢复: () => this.#prepareRestore(owner, args.slice(1)),
      朗读: () => this.#speech(owner, args.slice(1), invocation),
      自动朗读: () => this.#autoSpeech(owner, args.slice(1)),
      任务: () => this.#tasks(owner, args[1]),
      停止: () => this.#stop(owner, args[1]),
      重试: () => this.#retry(owner, args[1]),
      领取: () => this.#claim(owner, args[1], invocation),
      导入: () => this.#beginImport(owner),
      备份: () => this.#backup(owner, invocation),
      删除: () => this.#prepareDelete(owner, args.slice(1)),
    };
    const handler = handlers[sub];
    if (!handler) return { handled: true, text: `未知操作「${sub}」。发送 /小说 查看总菜单。` };
    const result = await handler();
    return { handled: true, ...(typeof result === 'string' ? { text: result } : result) };
  }

  async handleDirect(payload = {}, invocation = null) {
    normalizedInvocation(invocation);
    const owner = this.store.key(invocation);
    const receipt = `direct:${invocation.messageId}`;
    return await this.serial(owner, async () => {
      if (this.store.messageSeen(owner, receipt, this.now())) {
        return { handled: true, text: '' };
      }
      if (invocation.kind === 'group' && invocation.mentioned !== true) return { handled: false };
      const draft = await this.expireOwnerDraft(owner);
      if (!draft.active) return { handled: false };
      const result = draft.pausedAt
        ? { handled: true, text: '填写已暂停。发送 /小说 继续 恢复。' }
        : await this.#submitDraft(owner, clip(payload.text, 60_000), payload, invocation, draft);
      if (result?.handled === true) {
        await this.store.rememberMessage(owner, receipt, this.now());
      }
      return result;
    });
  }

  async handlePanel(payload = {}, invocation = null) {
    if (!invocation || invocation.source !== 'panel' || invocation.ownerVerified !== true) {
      throw new Error('面板动作没有通过主人校验');
    }
    const op = clip(payload.op || 'status', 40);
    const panelQueue = this.store.key(invocation);
    return await this.serial(panelQueue, async () => {
      if (op === 'status') {
        const [voice, dependencies] = await Promise.all([
          this.#voiceSources(),
          Promise.resolve().then(() => this.runtime.dependencies?.status?.()).catch((error) => ({ error: publicError(error) })),
        ]);
        return {
          ok: true,
          data: {
            version: PLUGIN_VERSION,
            dataReady: true,
            model: this.runtime.model?.status?.() || { configured: false },
            voice,
            dependencies: dependencies || {},
            ffmpeg: Boolean(this.runtime.ffmpegBinary?.()),
            stats: this.store.stats(),
          },
        };
      }
      if (op === 'books') {
        const owners = this.#panelOwnerChoices();
        const selectedOwnerId = owners.some((item) => item.id === payload.ownerId)
          ? payload.ownerId
          : owners[0]?.id || '';
        const selected = owners.find((item) => item.id === selectedOwnerId);
        return {
          ok: true,
          data: {
            selectedOwnerId,
            owners,
            currentBookId: selected?.currentBookId || '',
            books: selected?.books || [],
            voice: await this.#voiceSources(),
          },
        };
      }
      if (op === 'recover') {
        this.store.recoverInterrupted();
        setImmediate(() => this.pump());
        return { ok: true, message: '已扫描中断任务，未开始的任务会继续排队' };
      }
      if (op === 'installDeps') {
        const result = await this.runtime.dependencies?.install?.();
        return { ok: result?.ok !== false, message: result?.message || '依赖安装完成', data: result };
      }
      const owner = this.#resolvePanelOwner(payload);
      if (op === 'book') {
        const book = this.#panelBook(owner, payload.bookId);
        return { ok: true, data: { book: this.#panelBookDetail(owner, book) } };
      }
      if (op === 'open') {
        const bookId = clip(payload.bookId, 100);
        await this.store.updateLibrary(owner, (library) => {
          const hit = library.books.find((book) => book.id === bookId);
          if (!hit) throw new Error('书籍不存在');
          library.currentBookId = hit.id;
          return library;
        });
        return { ok: true, message: '已切换当前书籍', data: { bookId } };
      }
      if (op === 'saveBook') {
        return await this.#panelSaveBook(owner, payload);
      }
      if (op === 'savePersona') {
        return await this.#panelSavePersona(owner, payload);
      }
      if (op === 'generatePersona') {
        return await this.#panelGeneratePersona(owner, payload);
      }
      if (op === 'deletePersona') {
        return await this.#panelDeletePersona(owner, payload);
      }
      if (op === 'chapter') {
        return { ok: true, data: this.#panelChapter(owner, payload) };
      }
      if (op === 'saveChapter') {
        return await this.#panelSaveChapter(owner, payload);
      }
      if (op === 'setReading') {
        return await this.#panelSetReading(owner, payload);
      }
      if (op === 'deleteBook') {
        return await this.#panelDeleteBook(owner, payload);
      }
      if (op === 'tasks') {
        const rows = this.store.tasksFor(owner)
          .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt))
          .slice(0, 100)
          .map((task) => this.publicTask(task));
        return { ok: true, data: { tasks: rows } };
      }
      throw new Error('未知面板操作');
    });
  }

  async #voiceSources() {
    let rows;
    try { rows = await this.runtime.voice?.listSources?.(); }
    catch (error) { rows = { error: publicError(error) }; }
    const rawOfficial = rows?.official && typeof rows.official === 'object' ? rows.official : {};
    const readSpeed = (value) => {
      const number = Number(value);
      return Number.isFinite(number) && number >= 0.5 && number <= 2 ? number : null;
    };
    const savedSpeed = readSpeed(rawOfficial.savedSpeed)
      ?? readSpeed(rawOfficial.globalSpeed)
      ?? readSpeed(rawOfficial.speed)
      ?? 1;
    const effectiveSpeed = readSpeed(rawOfficial.effectiveSpeed)
      ?? readSpeed(rawOfficial.speed)
      ?? savedSpeed;
    const supportsSpeed = rawOfficial.supportsSpeed !== false;
    const supportsSpeedOverride = rawOfficial.supportsSpeedOverride === true
      || (rawOfficial.supportsSpeedOverride === undefined && supportsSpeed === true);
    const supportsVoiceOverride = rawOfficial.supportsVoiceOverride === true
      || (rawOfficial.supportsVoiceOverride === undefined
        && (rawOfficial.supportsVoice === true || supportsSpeed === true));
    const rawExtension = rows?.extension && typeof rows.extension === 'object' ? rows.extension : {};
    const stringList = (value, max) => (Array.isArray(value) ? value : [])
      .map((item) => clip(item, max)).filter(Boolean).slice(0, 12);
    return {
      official: {
        available: rawOfficial.available === true,
        configured: rawOfficial.configured === true,
        provider: clip(rawOfficial.provider, 40),
        voice: clip(rawOfficial.voice, 100),
        speed: effectiveSpeed,
        savedSpeed,
        effectiveSpeed,
        globalSpeed: readSpeed(rawOfficial.globalSpeed) ?? savedSpeed,
        maxChars: Math.max(1, Math.min(5000, Number(rawOfficial.maxChars) || 300)),
        supportsSpeed,
        supportsSpeedOverride,
        supportsVoiceOverride,
        engineChecked: rawOfficial.engineChecked === true,
        missing: stringList(rawOfficial.missing, 80),
        limitations: stringList(rawOfficial.limitations, 240),
        error: rawOfficial.error ? publicError(rawOfficial.error) : '',
      },
      extension: {
        available: rawExtension.available === true,
        configured: rawExtension.configured === true,
        longForm: rawExtension.longForm === true,
        missing: stringList(rawExtension.missing, 80),
        limitations: stringList(rawExtension.limitations, 240),
        error: rawExtension.error ? publicError(rawExtension.error) : '',
        message: clip(rawExtension.message, 240),
        profiles: (Array.isArray(rawExtension.profiles) ? rawExtension.profiles : [])
          .filter((item) => item?.id && item?.name)
          .slice(0, 100)
          .map((item) => ({ id: clip(item.id, 100), name: clip(item.name, 80) })),
      },
      error: rows?.error ? publicError(rows.error) : '',
    };
  }

  #panelOwnerChoices() {
    let entries;
    try { entries = readdirSync(this.store.owners, { withFileTypes: true }); }
    catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const owners = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      let library;
      try { library = this.store.library(entry.name); }
      catch { continue; }
      const books = library.books.map((book) => this.#panelBookSummary(book));
      const tasks = this.store.tasksFor(entry.name);
      if (!books.length && !tasks.length) continue;
      const latest = Math.max(
        books.reduce((max, book) => Math.max(max, book.updatedAt || 0), 0),
        tasks.reduce((max, task) => Math.max(max, Number(task.updatedAt) || 0), 0),
      );
      const first = books.find((book) => book.id === library.currentBookId) || books[0];
      owners.push({
        id: entry.name,
        label: first
          ? `《${first.title}》${books.length > 1 ? ` 等 ${books.length} 本` : ''}`
          : `历史任务 ${tasks.length} 个`,
        latest,
        currentBookId: library.currentBookId,
        books,
      });
    }
    return owners.sort((a, b) => b.latest - a.latest);
  }

  #resolvePanelOwner(payload = {}) {
    const owners = this.#panelOwnerChoices();
    const requested = clip(payload.ownerId, 64);
    const owner = requested
      ? owners.find((item) => item.id === requested)
      : owners[0];
    if (!owner) throw new Error('面板还没有可管理的私人书库；请先在 QQ 创建小说');
    return owner.id;
  }

  #panelBook(owner, bookId = '') {
    const id = clip(bookId, 100);
    const library = this.store.library(owner);
    const book = id
      ? library.books.find((item) => item.id === id)
      : library.books.find((item) => item.id === library.currentBookId);
    if (!book) throw new Error(id ? '书籍不存在' : '还没有书籍');
    return book;
  }

  #panelBookSummary(book) {
    const chapters = Array.isArray(book.chapters) ? book.chapters : [];
    return {
      id: clip(book.id, 100),
      no: Number(book.no) || 0,
      title: clip(book.title, 80),
      chapterCount: chapters.length,
      chars: chapters.reduce((sum, chapter) => sum + (Number(chapter.chars) || 0), 0),
      updatedAt: Number(book.updatedAt) || 0,
    };
  }

  #panelBookDetail(owner, book) {
    const settings = book.settings && typeof book.settings === 'object' ? book.settings : {};
    return {
      ...this.#panelBookSummary(book),
      settings: {
        core: clip(settings.core, 4000),
        genre: clip(settings.genre, 500),
        world: multilineClip(settings.world, 12_000),
        style: multilineClip(settings.style, 12_000),
        avoid: multilineClip(settings.avoid, 12_000),
        targetChars: Math.max(1000, Math.min(5000, Number(settings.targetChars) || 3000)),
      },
      outline: Array.isArray(book.outline)
        ? book.outline.map((item) => clip(item, 1000)).filter(Boolean).slice(0, 1000)
        : [],
      personas: normalizeBookPersonas(book.people),
      autoRead: book.autoRead === true,
      voice: {
        source: clip(book.voice?.source, 24),
        profileId: clip(book.voice?.profileId, 100),
        voice: clip(book.voice?.voice, 100),
        speed: Math.max(0.5, Math.min(2, Number(book.voice?.speed) || 1)),
      },
      chapters: (book.chapters || [])
        .slice()
        .sort((a, b) => a.no - b.no)
        .map((chapter) => {
          const item = {
            no: Number(chapter.no) || 0,
            title: clip(chapter.title, 120),
            chars: Number(chapter.chars) || 0,
            currentVersion: Number(chapter.currentVersion) || 0,
            versionCount: Array.isArray(chapter.versions) ? chapter.versions.length : 0,
            updatedAt: Number(chapter.updatedAt) || 0,
          };
          try {
            const current = this.store.readVersion(owner, book.id, chapter.no, chapter.currentVersion);
            item.audioFingerprint = clip(chapter.audioFingerprint, 100);
            item.summary = clip(current.summary, 2500);
          } catch {}
          return item;
        }),
    };
  }

  async #panelSaveBook(owner, payload) {
    const book = this.#panelBook(owner, payload.bookId);
    const rawSettings = payload.settings && typeof payload.settings === 'object' ? payload.settings : {};
    const title = clip(payload.title, 80);
    if (!title) throw new Error('书名不能为空');
    const settings = {
      core: multilineClip(rawSettings.core, 4000),
      genre: clip(rawSettings.genre, 500),
      world: multilineClip(rawSettings.world, 12_000),
      style: multilineClip(rawSettings.style, 12_000),
      avoid: multilineClip(rawSettings.avoid, 12_000),
      targetChars: Math.max(1000, Math.min(5000, Number(rawSettings.targetChars) || 3000)),
    };
    const outline = Array.isArray(payload.outline)
      ? payload.outline.map((item) => clip(item, 1000)).filter(Boolean).slice(0, 1000)
      : book.outline;
    const previous = JSON.stringify(book.settings || {});
    const outlineChanged = JSON.stringify(outline || []) !== JSON.stringify(book.outline || []);
    await this.store.updateLibrary(owner, (library) => {
      const hit = library.books.find((item) => item.id === book.id);
      if (!hit) throw new Error('书籍不存在');
      hit.title = title;
      hit.settings = settings;
      hit.outline = outline;
      hit.updatedAt = this.now();
      if (JSON.stringify(settings) !== previous) {
        for (const chapter of hit.chapters) chapter.audioFingerprint = '';
      }
      if (outlineChanged) {
        hit.generatedOutline = [];
        hit.memory = { validThrough: 0, cumulative: '', states: [] };
        hit.audioArtifacts = {};
        for (const chapter of hit.chapters) chapter.audioFingerprint = '';
      }
      return library;
    });
    return { ok: true, message: '书籍资料已保存', data: { book: this.#panelBookDetail(owner, this.#panelBook(owner, book.id)) } };
  }

  async #panelSavePersona(owner, payload) {
    const book = this.#panelBook(owner, payload.bookId);
    const input = payload.persona && typeof payload.persona === 'object' ? payload.persona : {};
    const persona = normalizePersona(input, { createId: !clip(input.id, 100) });
    let mode = 'updated';
    await this.store.updateLibrary(owner, (library) => {
      const hit = library.books.find((item) => item.id === book.id);
      if (!hit) throw new Error('书籍不存在');
      hit.people = normalizeBookPersonas(hit.people);
      const duplicate = hit.people.find((item) => item.name === persona.name && item.id !== persona.id);
      if (duplicate) throw new Error(`已有同名人物「${persona.name}」，请先改名或编辑原卡片`);
      const index = hit.people.findIndex((item) => item.id === persona.id);
      if (index >= 0) hit.people[index] = persona;
      else {
        hit.people.push(persona);
        mode = 'created';
      }
      hit.people = hit.people.slice(0, 200);
      hit.updatedAt = this.now();
      return library;
    });
    return {
      ok: true,
      message: mode === 'created' ? '人设卡已创建' : '人设卡已保存',
      data: { persona, personas: normalizeBookPersonas(this.#panelBook(owner, book.id).people) },
    };
  }

  async #panelGeneratePersona(owner, payload) {
    if (this.closing) throw serviceClosedError();
    const book = this.#panelBook(owner, payload.bookId);
    if (this.runtime.model?.status?.()?.configured !== true) {
      throw new Error('还没有配置默认模型');
    }
    const controller = new AbortController();
    const controllerId = `panel-persona:${hash(owner, book.id, this.now()).slice(0, 20)}`;
    this.controllers.set(controllerId, controller);
    let timer;
    const timeout = new Promise((_, reject) => {
      const seconds = Math.max(1, Math.round(this.panelGenerateTimeoutMs / 1000));
      timer = setTimeout(() => {
        const error = new Error(`人设卡生成超过 ${seconds} 秒，已结束本次操作`);
        controller.abort(error);
        reject(error);
      }, this.panelGenerateTimeoutMs);
    });
    const generation = Promise.resolve().then(() => this.runtime.model.generate({
      taskId: controllerId.replace(':', '-'),
      stage: 'persona_generate',
      system: PERSONA_SYSTEM,
      messages: [{ role: 'user', content: personaPrompt(book, payload.hint) }],
      maxTokens: 3600,
      temperature: 0.78,
      signal: controller.signal,
    }));
    generation.catch(() => {});
    let result;
    try { result = await Promise.race([generation, timeout]); }
    finally {
      clearTimeout(timer);
      this.controllers.delete(controllerId);
    }
    if (this.closing) throw serviceClosedError();
    const persona = parsePersonaJson(result?.text);
    return {
      ok: true,
      message: '人设卡候选已生成，请检查并保存',
      data: { persona },
    };
  }

  async #panelDeletePersona(owner, payload) {
    const book = this.#panelBook(owner, payload.bookId);
    const id = clip(payload.personaId, 100);
    if (!id) throw new Error('缺少人设卡编号');
    await this.store.updateLibrary(owner, (library) => {
      const hit = library.books.find((item) => item.id === book.id);
      if (!hit) throw new Error('书籍不存在');
      hit.people = normalizeBookPersonas(hit.people);
      const index = hit.people.findIndex((item) => item.id === id);
      if (index < 0) throw new Error('人设卡不存在');
      hit.people.splice(index, 1);
      hit.updatedAt = this.now();
      return library;
    });
    return { ok: true, message: '人设卡已删除', data: { personas: normalizeBookPersonas(this.#panelBook(owner, book.id).people) } };
  }

  #panelChapter(owner, payload) {
    const book = this.#panelBook(owner, payload.bookId);
    const chapterNo = Number.parseInt(payload.chapterNo, 10);
    const chapter = book.chapters.find((item) => item.no === chapterNo);
    if (!chapter) throw new Error('章节不存在');
    const current = this.store.readVersion(owner, book.id, chapter.no, chapter.currentVersion);
    return {
      bookId: book.id,
      chapterNo: chapter.no,
      currentVersion: chapter.currentVersion,
      versions: Array.isArray(chapter.versions) ? chapter.versions.slice() : [],
      title: current.title,
      body: current.body,
      summary: current.summary || '',
      states: Array.isArray(current.states) ? current.states.slice() : [],
    };
  }

  async #panelSaveChapter(owner, payload) {
    const book = this.#panelBook(owner, payload.bookId);
    const chapterNo = Number.parseInt(payload.chapterNo, 10);
    const chapter = book.chapters.find((item) => item.no === chapterNo);
    if (!chapter) throw new Error('章节不存在');
    const title = clip(payload.title, 120);
    const body = multilineClip(payload.body, 2_000_000);
    if (!title || !body) throw new Error('章节标题和正文不能为空');
    const expectedVersion = Number.parseInt(payload.expectedVersion, 10);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new Error('保存章节缺少版本基线，请刷新后重试');
    }
    const current = this.store.readVersion(owner, book.id, chapter.no, chapter.currentVersion);
    const version = await this.store.appendVersion(owner, book.id, chapter.no, {
      title,
      body,
      summary: current.summary || '',
      states: Array.isArray(current.states) ? current.states : [],
      source: 'panel_edit',
      expectedVersion,
    });
    return {
      ok: true,
      message: `已保存为第 ${chapter.no} 章 v${version.versionNo}，旧版本仍可恢复`,
      data: { chapter: this.#panelChapter(owner, { bookId: book.id, chapterNo }) },
    };
  }

  async #panelSetReading(owner, payload) {
    if (this.closing) throw serviceClosedError();
    const book = this.#panelBook(owner, payload.bookId);
    const sources = await this.#voiceSources();
    if (this.closing) throw serviceClosedError();
    const input = payload.voice && typeof payload.voice === 'object'
      ? payload.voice
      : payload.selection && typeof payload.selection === 'object'
        ? payload.selection
        : {};
    const useCurrentGlobal = payload.useCurrentGlobal === true;
    const source = clip(input.source, 24);
    const speedProvided = input.speed !== undefined && input.speed !== null && input.speed !== '';
    const parsedSpeed = Number(input.speed);
    const speed = Number.isFinite(parsedSpeed) && parsedSpeed >= 0.5 && parsedSpeed <= 2
      ? parsedSpeed
      : null;
    if (speedProvided && speed === null) throw new Error('语速需在 0.5 到 2 之间');
    let voice = { source: '', profileId: '', voice: '', speed: 1 };
    if (useCurrentGlobal) {
      if (source !== 'official') throw new Error('只有官方语音可以使用当前全局设置');
      if (!sources.official.available || !sources.official.configured) {
        throw new Error('官方语音尚未配置');
      }
      voice = {
        source: 'official',
        profileId: '',
        voice: sources.official.voice,
        speed: sources.official.effectiveSpeed,
      };
    } else if (source === 'official') {
      if (!sources.official.configured) throw new Error('官方语音尚未配置');
      const requestedVoice = clip(input.voice, 100);
      if (!sources.official.supportsVoiceOverride
          && requestedVoice
          && requestedVoice !== sources.official.voice) {
        throw new Error(`官方语音只能使用已保存的全局音色${sources.official.voice ? `（${sources.official.voice}）` : ''}，不支持本书单独覆盖`);
      }
      const targetSpeed = speedProvided ? speed : sources.official.effectiveSpeed;
      if (!sources.official.supportsSpeedOverride
          && targetSpeed !== sources.official.effectiveSpeed) {
        const detail = sources.official.savedSpeed !== sources.official.effectiveSpeed
          ? `（已保存全局语速 ${sources.official.savedSpeed}，当前实际生效 ${sources.official.effectiveSpeed}）`
          : '';
        throw new Error(`官方语音只能使用当前实际语速 ${sources.official.effectiveSpeed}${detail}，不支持本书单独覆盖，请在全局语音设置中调整`);
      }
      voice = {
        source,
        profileId: '',
        voice: requestedVoice || sources.official.voice,
        speed: targetSpeed,
      };
    } else if (source === 'extension') {
      if (!sources.extension.configured) throw new Error('语音回复扩展尚未配置');
      const profileId = clip(input.profileId, 100);
      const profile = sources.extension.profiles.find((item) => item.id === profileId);
      if (!profile) throw new Error('所选音色方案不存在');
      voice = { source, profileId: profile.id, voice: '', speed: speedProvided ? speed : 1 };
    } else if (source) {
      throw new Error('朗读来源只支持官方或语音回复扩展');
    }
    const autoRead = payload.autoRead === true;
    if (autoRead && !voice.source) throw new Error('请先选择朗读来源再开启自动朗读');
    await this.store.updateLibrary(owner, (library) => {
      const hit = library.books.find((item) => item.id === book.id);
      if (!hit) throw new Error('书籍不存在');
      hit.voice = voice;
      hit.autoRead = autoRead;
      hit.updatedAt = this.now();
      return library;
    });
    return {
      ok: true,
      message: '朗读设置已保存',
      data: { autoRead, voice },
    };
  }

  async #panelDeleteBook(owner, payload) {
    const book = this.#panelBook(owner, payload.bookId);
    if (String(payload.confirmTitle || '') !== book.title) {
      throw new Error(`请输入完整书名「${book.title}」确认删除`);
    }
    const active = this.store.tasksFor(owner).filter((task) =>
      ['queued', 'running'].includes(task.status) && task.input?.bookId === book.id);
    if (active.length) throw new Error('这本书还有未完成的任务，请先停止任务');
    await this.store.deleteBook(owner, book.id);
    return { ok: true, message: `已删除《${book.title}》`, data: { deleted: true } };
  }

  async #rootReply(owner, draft) {
    const library = this.store.library(owner);
    const current = library.books.find((book) => book.id === library.currentBookId);
    const open = this.store.tasksFor(owner)
      .filter((task) => ['queued', 'running'].includes(task.status) || task.outbox?.some((item) => item.state !== 'sent'))
      .slice(0, 5);
    return {
      handled: true,
      text: [
        `小说书库：${library.books.length} 本${current ? `，当前《${current.title}》` : ''}`,
        draft?.active ? `填写：${draftPrompt(draft)}` : '当前没有填写草稿',
        open.length ? `任务：${open.map((task) => `${task.id.slice(-8)} ${task.status}`).join('；')}` : '没有待处理任务',
        '',
        HELP.总览,
      ].join('\n').slice(0, 1180),
    };
  }

  async #submitDraft(owner, input, payload, invocation, draft) {
    if (!draft?.active) return { handled: false };
    if (draft.seenMessages?.includes(invocation.messageId)) return { handled: true, text: '' };
    const value = clip(input, 60_000);
    if (!value && !payload.fileBase64) return { handled: true, text: draftPrompt(draft) };

    if (draft.kind === 'new_book') {
      const result = applyNewBookInput(draft, value, this.now());
      if (result.done) {
        const created = await this.#createBook(owner, draft.data);
        result.reply = `已创建《${created.title}》，书籍编号 ${created.no}。\n下一步可发送 /小说 大纲 添加，或直接 /小说 续写 <剧情要求>。`;
      }
      result.draft.seenMessages = [...(result.draft.seenMessages || []), invocation.messageId].slice(-40);
      result.draft.lastMessageId = invocation.messageId;
      await this.store.updateDraft(owner, () => result.draft);
      return { handled: true, text: result.reply };
    }

    if (draft.kind === 'modify_chapter') {
      if (value === '取消') {
        draft.active = false;
        await this.store.updateDraft(owner, () => draft);
        return { handled: true, text: '已取消替换正文。' };
      }
      if (value === '暂停') {
        pauseDraft(draft, this.now());
        await this.store.updateDraft(owner, () => draft);
        return { handled: true, text: '替换正文草稿已暂停；发送 /小说 继续 恢复。' };
      }
      if (value === '完成' || value === '确认') {
        if (!draft.data.body?.trim()) return { handled: true, text: '正文还是空的，请继续发送或取消。' };
        this.assertNoActiveWritingTask(owner, draft.data.bookId);
        const row = await this.store.appendVersion(owner, draft.data.bookId, draft.data.chapterNo, {
          title: draft.data.title || `第${draft.data.chapterNo}章`,
          body: draft.data.body,
          source: 'manual', taskId: '',
        });
        draft.active = false;
        draft.seenMessages = [...(draft.seenMessages || []), invocation.messageId].slice(-40);
        await this.store.updateDraft(owner, () => draft);
        return { handled: true, text: `已保存第 ${row.chapterNo} 章 v${row.versionNo}。此前的版本仍可恢复；旧摘要和音频已标记失效。` };
      }
      if (value === '上一步') {
        draft.data.body = '';
        await this.store.updateDraft(owner, () => draft);
        return { handled: true, text: draftPrompt(draft) };
      }
      draft.data.body = multilineClip(draft.data.body ? `${draft.data.body}\n${value}` : value, 2_000_000);
      draft.updatedAt = this.now();
      draft.seenMessages = [...(draft.seenMessages || []), invocation.messageId].slice(-40);
      await this.store.updateDraft(owner, () => draft);
      return {
        handled: true,
        text: `第 ${draft.data.chapterNo} 章新正文已累计 ${charCount(draft.data.body)} 字。继续发送，或回复“完成”保存；确认前不会覆盖原稿。`,
      };
    }

    if (draft.kind === 'outline') {
      if (value === '取消') {
        draft.active = false;
        await this.store.updateDraft(owner, () => draft);
        return { handled: true, text: '已取消大纲填写。' };
      }
      if (value === '暂停') {
        pauseDraft(draft, this.now());
        await this.store.updateDraft(owner, () => draft);
        return { handled: true, text: '大纲填写已暂停；七天内发送 /小说 继续 恢复。' };
      }
      if (value === '完成') {
        const lines = draft.data.lines || [];
        await this.store.updateLibrary(owner, (library) => {
          const book = library.books.find((item) => item.id === draft.data.bookId);
          if (!book) throw new Error('书籍不存在');
          book.outline = lines.slice(0, 1000);
          book.updatedAt = this.now();
          return library;
        });
        draft.active = false;
        await this.store.updateDraft(owner, () => draft);
        return { handled: true, text: `大纲已保存，共 ${lines.length} 条。` };
      }
      if (value === '跳过') {
        draft.step = 'outline_body';
        return { handled: true, text: draftPrompt(draft) };
      }
      draft.data.lines = [...(draft.data.lines || []), clip(value, 1000)].slice(0, 1000);
      draft.updatedAt = this.now();
      draft.seenMessages = [...(draft.seenMessages || []), invocation.messageId].slice(-40);
      await this.store.updateDraft(owner, () => draft);
      return { handled: true, text: `已追加第 ${draft.data.lines.length} 条大纲。继续发送，或回复“完成”。` };
    }

    if (draft.kind === 'import') {
      if (value === '取消') {
        draft.active = false;
        await this.store.updateDraft(owner, () => draft);
        return { handled: true, text: '已取消导入。' };
      }
      if (value === '暂停') {
        pauseDraft(draft, this.now());
        await this.store.updateDraft(owner, () => draft);
        return { handled: true, text: '导入草稿已暂停；七天内发送 /小说 继续 恢复。' };
      }
      if (draft.data.preview && confirmedYes(value)) {
        const created = await this.#createBook(owner, {
          title: draft.data.preview.title,
          core: '从 TXT/备份导入',
          targetChars: 3000,
          people: [],
        });
        const library = this.store.library(owner);
        const book = library.books.find((item) => item.id === created.id);
        for (const chapter of draft.data.preview.chapters) {
          await this.store.appendVersion(owner, created.id, chapter.no, {
            title: chapter.title,
            body: chapter.body,
            summary: chapter.summary || '',
            states: chapter.states || [],
            source: 'import',
          });
        }
        await this.store.updateLibrary(owner, (next) => {
          const hit = next.books.find((item) => item.id === created.id);
          if (hit && draft.data.preview.settings) hit.settings = { ...hit.settings, ...draft.data.preview.settings };
          if (hit && Array.isArray(draft.data.preview.people)) {
            hit.people = normalizeBookPersonas(draft.data.preview.people);
          }
          if (hit && Array.isArray(draft.data.preview.outline)) hit.outline = draft.data.preview.outline;
          return next;
        });
        draft.active = false;
        await this.store.updateDraft(owner, () => draft);
        return { handled: true, text: `已导入《${created.title}》，共 ${draft.data.preview.chapters.length} 章。` };
      }
      if (payload.fileBase64) {
        const bytes = Buffer.from(String(payload.fileBase64), 'base64');
        if (bytes.length > 5 * 1024 * 1024) return { handled: true, text: '导入文件超过 5 MB。' };
        try {
          let preview;
          if (/\.json$/i.test(payload.fileName || '')) preview = parseBackup(bytes);
          else preview = parseImportedTxt(bytes, payload.fileName);
          draft.data.preview = preview;
          draft.data.fileName = clip(payload.fileName, 160);
          draft.updatedAt = this.now();
          await this.store.updateDraft(owner, () => draft);
          return {
            handled: true,
            text: `识别《${preview.title}》，${preview.chapters.length} 章、约 ${charCount(preview.chapters.map((item) => item.body).join(''))} 字。回复“确认”导入，或“取消”。`,
          };
        } catch (error) {
          return { handled: true, text: `导入预览失败：${publicError(error)}` };
        }
      }
      try {
        const preview = parseImportedTxt(Buffer.from(value, 'utf8'), '粘贴内容.txt');
        draft.data.preview = preview;
        draft.updatedAt = this.now();
        await this.store.updateDraft(owner, () => draft);
        return {
          handled: true,
          text: `识别《${preview.title}》，${preview.chapters.length} 章、约 ${charCount(preview.chapters.map((item) => item.body).join(''))} 字。回复“确认”导入，或“取消”。`,
        };
      } catch (error) {
        return { handled: true, text: `解析失败：${publicError(error)}` };
      }
    }

    if (draft.kind === 'confirm') {
      if (!confirmedYes(value)) {
        if (value === '取消') {
          draft.active = false;
          await this.store.updateDraft(owner, () => draft);
          return { handled: true, text: '已取消操作。' };
        }
        return { handled: true, text: '请回复“确认”执行，或“取消”。' };
      }
      return await this.#executeConfirmation(owner, draft, invocation);
    }
    return { handled: true, text: '草稿状态异常，请发送 /小说 取消 后重试。' };
  }

  async #createBook(owner, data) {
    const id = `book-${shortId('b').slice(2)}`;
    const library = await this.store.updateLibrary(owner, (library) => {
      const title = clip(data.title, 80);
      if (!title) throw new Error('书名不能为空');
      const no = Number(library.nextBookNo) || 1;
      const targetChars = Math.max(1000, Math.min(5000, Number(data.targetChars) || 3000));
      const book = {
        id,
        no,
        title,
        createdAt: this.now(),
        updatedAt: this.now(),
        settings: {
          core: clip(data.core, 4000),
          genre: clip(data.genre, 500),
          world: clip(data.world, 12_000),
          style: clip(data.style, 12_000),
          avoid: clip(data.avoid, 12_000),
          targetChars,
        },
        people: normalizeBookPersonas(data.people),
        outline: [],
        chapters: [],
        memory: { validThrough: 0, cumulative: '', states: [] },
        autoRead: false,
        voice: { source: '', profileId: '', voice: '', speed: 1 },
        audioArtifacts: {},
        generatedOutline: [],
      };
      library.books.push(book);
      library.nextBookNo = no + 1;
      library.currentBookId = id;
      return library;
    });
    const book = library.books.find((item) => item.id === id);
    if (!book) throw new Error('创建书籍索引失败');
    return { id: book.id, no: book.no, title: book.title };
  }

  async #newBook(owner, title) {
    const draft = newDraft({ title: clip(title, 80) });
    await this.store.updateDraft(owner, () => draft);
    return draftPrompt(draft);
  }

  async #shelf(owner, page = '1') {
    const library = this.store.library(owner);
    if (!library.books.length) return '书架还是空的。发送 /小说 新建 [书名] 开始。';
    const rows = library.books.slice().sort((a, b) => a.no - b.no).map((book) => {
      const mark = book.id === library.currentBookId ? '●' : '○';
      return `${mark} ${book.no}.《${book.title}》 ${book.chapters.length}章 约${book.chapters.reduce((sum, item) => sum + (item.chars || 0), 0)}字`;
    });
    return pageText('书架', rows, page, 10);
  }

  async #openBook(owner, no) {
    const number = Number.parseInt(no, 10);
    if (!Number.isInteger(number)) return '用法：/小说 打开 <书架编号>';
    const library = this.store.library(owner);
    const book = library.books.find((item) => item.no === number);
    if (!book) return '没有这个编号的书。发送 /小说 书架 查看。';
    library.currentBookId = book.id;
    await this.store.updateLibrary(owner, () => library);
    return `已打开《${book.title}》，共 ${book.chapters.length} 章。`;
  }

  currentBook(owner) {
    const book = this.store.currentBook(owner);
    if (!book) throw new Error('还没有当前书籍。发送 /小说 新建 或 /小说 打开 <编号>。');
    return book;
  }

  async #settings(owner, args) {
    const book = this.currentBook(owner);
    if (!args.length) {
      return [
        `《${book.title}》设定`,
        `题材：${book.settings?.genre || '未填写'}`,
        `世界观：${clip(book.settings?.world, 500) || '未填写'}`,
        `文风：${clip(book.settings?.style, 500) || '未填写'}`,
        `避雷：${clip(book.settings?.avoid, 500) || '未填写'}`,
        `目标字数：${book.settings?.targetChars || 3000}`,
        '修改用法：/小说 设定 <题材|世界观|文风|避雷|目标字数> <内容>',
      ].join('\n');
    }
    const field = SETTING_FIELDS[args[0]];
    if (!field) return '未知设定字段。可用：题材、世界观、文风、避雷、目标字数。';
    const value = args.slice(1).join(' ').trim();
    if (!value) return `请给出新的${args[0]}。`;
    let normalized = multilineClip(value, field === 'targetChars' ? 20 : 12_000);
    if (field === 'targetChars') {
      const number = Number.parseInt(normalized, 10);
      if (!Number.isInteger(number) || number < 1000 || number > 5000) return '目标字数要在 1000–5000 之间。';
      normalized = number;
    }
    await this.store.updateLibrary(owner, (library) => {
      const hit = library.books.find((item) => item.id === book.id);
      hit.settings[field] = normalized;
      hit.updatedAt = this.now();
      for (const chapter of hit.chapters) chapter.audioFingerprint = '';
      return library;
    });
    return `已更新「${args[0]}」。后续写作会使用新设定；已开始的写作任务使用启动时快照。`;
  }

  async #people(owner, args) {
    const book = this.currentBook(owner);
    if (!args.length || args[0] === '列表') {
      const people = normalizeBookPersonas(book.people);
      const rows = people.map((person, index) =>
        `${index + 1}. ${person.name}${person.aliases.length ? `（${person.aliases.join('、')}）` : ''}｜${clip(person.identity, 60) || '身份未填'}｜目标：${clip(person.goal, 50) || '未填'}`);
      return [
        rows.length ? rows.join('\n') : '还没有人设卡。',
        '',
        '添加：/小说 人设 添加 姓名|身份|性格|关系|目标',
        '修改：/小说 人设 修改 <编号> <身份|外貌|性格|关系|目标|冲突|秘密|弧光|语气|备注|别名> <内容>',
        '删除：/小说 人设 删除 <编号> 确认',
        '也可以打开 DSH「表达 → 小说/人设卡创作」面板编辑完整人设卡。',
      ].join('\n');
    }
    if (args[0] === '添加') {
      const fields = args.slice(1).join(' ').split('|').map((item) => clip(item, 1000));
      if (!fields[0]) return '添加人设卡至少要提供姓名。用法：/小说 人设 添加 姓名|身份|性格|关系|目标';
      await this.store.updateLibrary(owner, (library) => {
        const hit = library.books.find((item) => item.id === book.id);
        hit.people = normalizeBookPersonas(hit.people);
        if (hit.people.some((person) => person.name === fields[0])) {
          throw new Error(`已有同名人物「${fields[0]}」`);
        }
        hit.people.push(normalizePersona({
          name: fields[0], identity: fields[1] || '',
          personality: fields[2] || '', relationship: fields[3] || '', goal: fields[4] || '',
        }, { createId: true }));
        hit.people = hit.people.slice(0, 200);
        hit.updatedAt = this.now();
        return library;
      });
      return `已添加人设卡「${fields[0]}」。`;
    }
    if (args[0] === '修改') {
      const index = Number.parseInt(args[1], 10) - 1;
      const field = PERSONA_FIELDS[args[2]];
      const value = multilineClip(args.slice(3).join(' '), 2000);
      if (!field || !value) {
        return '用法：/小说 人设 修改 <编号> <身份|外貌|性格|关系|目标|冲突|秘密|弧光|语气|备注|别名> <内容>';
      }
      await this.store.updateLibrary(owner, (library) => {
        const hit = library.books.find((item) => item.id === book.id);
        hit.people = normalizeBookPersonas(hit.people);
        const person = hit.people[index];
        if (!person) throw new Error('人设卡编号不存在');
        const next = normalizePersona({
          ...person,
          [field]: field === 'aliases' ? value.split(/[、,，\n]/) : value,
        });
        if (hit.people.some((item) => item.name === next.name && item.id !== next.id)) {
          throw new Error(`已有同名人物「${next.name}」`);
        }
        hit.people[index] = next;
        hit.updatedAt = this.now();
        return library;
      });
      return '人设卡已更新。';
    }
    if (args[0] === '删除') {
      const index = Number.parseInt(args[1], 10) - 1;
      if (args.at(-1) !== '确认') return '删除人设卡不可恢复；请在命令末尾加“确认”。';
      await this.store.updateLibrary(owner, (library) => {
        const hit = library.books.find((item) => item.id === book.id);
        hit.people = normalizeBookPersonas(hit.people);
        if (!hit.people[index]) throw new Error('人设卡编号不存在');
        hit.people.splice(index, 1);
        hit.updatedAt = this.now();
        return library;
      });
      return '人设卡已删除。';
    }
    return '人设卡操作：列表、添加、修改、删除。';
  }

  async #outline(owner, args, invocation) {
    const book = this.currentBook(owner);
    const action = args[0] || '';
    if (!action) return book.outline?.length
      ? book.outline.map((line, index) => `${index + 1}. ${line}`).join('\n').slice(0, 1800)
      : '还没有大纲。发送 /小说 大纲 添加 开始填写，或 /小说 大纲 生成 请求模型生成。';
    if (action === '添加') {
      const draft = outlineDraft();
      draft.data.bookId = book.id;
      draft.data.lines = [...(book.outline || [])];
      await this.store.updateDraft(owner, () => draft);
      return draftPrompt(draft);
    }
    if (action === '生成') {
      const task = await this.enqueue({
        kind: 'outline',
        owner,
        invocation,
        input: { bookId: book.id },
        dedupe: `${invocation.messageId}:outline`,
      });
      const text = `大纲生成任务已开始：${task.id}\n完成后发送 /小说 任务 ${task.id} 查看，应用前会要求确认。`;
      return { text, taskId: task.id, watchTaskIds: [task.id] };
    }
    if (action === '确认') {
      if (!Array.isArray(book.generatedOutline) || !book.generatedOutline.length) return '没有待应用的大纲候选。';
      const outline = book.generatedOutline.slice(0, 1000);
      const audioChapters = book.chapters.filter((chapter) => chapter.audioFingerprint).length;
      const draft = {
        version: 1,
        active: true,
        kind: 'confirm',
        step: 'confirm_apply_outline',
        data: {
          action: 'apply_outline',
          bookId: book.id,
          title: book.title,
          outline,
          previousCount: book.outline?.length || 0,
          resetMemoryThrough: Number(book.memory?.validThrough) || 0,
          invalidatedAudioChapters: audioChapters,
        },
        history: [],
        pausedAt: 0,
        updatedAt: this.now(),
        lastMessageId: '',
        seenMessages: [],
      };
      await this.store.updateDraft(owner, () => draft);
      return [
        `即将应用《${book.title}》的新大纲：${draft.data.previousCount} 条 → ${outline.length} 条。`,
        `记忆将重置（原有效至第 ${draft.data.resetMemoryThrough} 章），${audioChapters} 章的音频缓存会失效。`,
        '只影响当前这本书。回复“确认”应用，或“取消”。',
      ].join('\n');
    }
    return '大纲操作：直接查看、添加、生成、确认。';
  }

  parseWriteOptions(text) {
    let value = String(text ?? '').trim();
    const countMatch = /(?:^|\s)([1-3])\s*章(?:\s|$)/.exec(value);
    const charsMatch = /(?:^|\s)(\d{4,5})\s*字(?:\s|$)/.exec(value);
    const count = countMatch ? Number(countMatch[1]) : 1;
    const chars = charsMatch ? Number(charsMatch[1]) : 0;
    value = value.replace(/(?:^|\s)[1-3]\s*章(?=\s|$)/g, ' ')
      .replace(/(?:^|\s)\d{4,5}\s*字(?=\s|$)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (chars && (chars < 1000 || chars > 5000)) throw new Error('单章目标字数要在 1000–5000 之间');
    return { count: Math.max(1, Math.min(3, count)), chars, request: value };
  }

  async #continueWriting(owner, args, invocation) {
    const book = this.currentBook(owner);
    const options = this.parseWriteOptions(args.join(' '));
    const targetChars = options.chars || Number(book.settings?.targetChars) || 3000;
    if (targetChars < 1000 || targetChars > 5000) throw new Error('单章目标字数要在 1000–5000 之间');
    const task = await this.enqueue({
      kind: 'write',
      owner,
      invocation,
      input: { bookId: book.id, count: options.count, targetChars, request: options.request },
      dedupe: `${invocation.messageId}:write`,
    });
    const text = [
      `写作任务已开始：${task.id}`,
      `《${book.title}》${options.count} 章，单章目标 ${targetChars} 字。`,
      '任务会在后台生成；完成后发送 TXT 文件。用 /小说 任务 查看进度。',
    ].join('\n');
    return { text, taskId: task.id, watchTaskIds: [task.id] };
  }

  async #rewrite(owner, args, invocation) {
    const book = this.currentBook(owner);
    const chapterNo = Number.parseInt(args[0], 10);
    if (!Number.isInteger(chapterNo) || !book.chapters.some((item) => item.no === chapterNo)) {
      return '用法：/小说 重写 <已有章号> [要求]';
    }
    const request = args.slice(1).join(' ').trim();
    const task = await this.enqueue({
      kind: 'rewrite',
      owner,
      invocation,
      input: {
        bookId: book.id,
        chapterNo,
        targetChars: book.chapters.find((item) => item.no === chapterNo)?.chars || book.settings?.targetChars || 3000,
        request,
      },
      dedupe: `${invocation.messageId}:rewrite:${chapterNo}`,
    });
    const text = `章节重写任务已开始：${task.id}\n会生成第 ${chapterNo} 章的新版本，原稿保留。`;
    return { text, taskId: task.id, watchTaskIds: [task.id] };
  }

  async #modify(owner, args) {
    const book = this.currentBook(owner);
    const chapterNo = Number.parseInt(args[0], 10);
    const chapter = book.chapters.find((item) => item.no === chapterNo);
    if (!chapter) return '用法：/小说 修改 <已有章号>，随后逐条发送替换正文。';
    const latest = this.store.readVersion(owner, book.id, chapter.no, chapter.currentVersion);
    const draft = modifyDraft(chapter.no);
    draft.data.bookId = book.id;
    draft.data.title = latest.title;
    await this.store.updateDraft(owner, () => draft);
    return `准备修改第 ${chapterNo} 章。请逐条发送新正文；回复“完成”保存为新版本，原稿不会删除。`;
  }

  async #catalog(owner, page = '1') {
    const book = this.currentBook(owner);
    if (!book.chapters.length) return `《${book.title}》还没有章节。`;
    const rows = book.chapters.map((item) => `第${item.no}章 ${item.title}｜${item.chars || 0}字｜v${item.currentVersion}｜${item.versions.length}版${item.audioFingerprint ? '｜有音频缓存' : ''}`);
    return pageText(`目录 ${book.title}`, rows, page, 10);
  }

  async #search(owner, query) {
    const book = this.currentBook(owner);
    const keyword = clip(query, 100);
    if (!keyword) return '用法：/小说 查找 <关键词>';
    const hits = [];
    for (const chapter of book.chapters) {
      const row = this.store.readVersion(owner, book.id, chapter.no, chapter.currentVersion);
      const at = row.body.indexOf(keyword);
      if (at >= 0) {
        const start = Math.max(0, at - 35);
        hits.push(`第${chapter.no}章 ${chapter.title}\n…${row.body.slice(start, at + keyword.length + 55)}…`);
      }
      if (hits.length >= 20) break;
    }
    return hits.length ? hits.join('\n\n').slice(0, 1800) : `当前书中没有找到「${keyword}」。`;
  }

  latestVersions(owner, book, numbers) {
    const selected = numbers.map((no) => {
      const chapter = book.chapters.find((item) => item.no === no);
      if (!chapter) throw new Error(`没有第 ${no} 章`);
      return this.store.readVersion(owner, book.id, chapter.no, chapter.currentVersion);
    });
    return selected.sort((a, b) => a.chapterNo - b.chapterNo);
  }

  async writeArtifact(fileName, bytes, owner, bookId, kind, signal = null) {
    signal?.throwIfAborted?.();
    const file = join(this.outputDir, `${shortId('out')}-${safeName(fileName, 'novel')}`);
    atomicBytes(file, bytes);
    signal?.throwIfAborted?.();
    const artifact = await this.runtime.artifacts.register({
      ownerKey: owner, bookId, kind, path: file, fileName, bytes: bytes.length,
    });
    signal?.throwIfAborted?.();
    return { ...artifact, path: file };
  }

  async #sendTxt(owner, range, invocation) {
    const book = this.currentBook(owner);
    const numbers = chapterRange(book, range || '最新');
    const rows = this.latestVersions(owner, book, numbers);
    const bytes = readingTxt(book, rows);
    const fileName = txtFileName(book, rows);
    const artifact = await this.writeArtifact(fileName, bytes, owner, book.id, 'txt');
    return {
      text: `阅读 TXT 已生成：${fileName}`,
      outbox: [{
        artifactId: artifact.id, path: artifact.path, fileName, kind: 'txt',
        requestId: `novel-txt-${hash(artifact.id).slice(0, 24)}`,
      }],
    };
  }

  async #versions(owner, no) {
    const book = this.currentBook(owner);
    const chapterNo = Number.parseInt(no, 10);
    const chapter = book.chapters.find((item) => item.no === chapterNo);
    if (!chapter) return '用法：/小说 版本 <章号>';
    return [
      `第 ${chapterNo} 章 ${chapter.title}`,
      ...chapter.versions.map((version) => {
        const row = this.store.readVersion(owner, book.id, chapterNo, version);
        const mark = version === chapter.currentVersion ? '●' : '○';
        return `${mark} v${version}｜${charCount(row.body)}字｜${row.source}｜${new Date(row.createdAt).toLocaleString('zh-CN', { hour12: false })}`;
      }),
      `恢复：/小说 恢复 ${chapterNo} <版本号>`,
    ].join('\n').slice(0, 1800);
  }

  async #prepareRestore(owner, args) {
    const book = this.currentBook(owner);
    const chapterNo = Number.parseInt(args[0], 10);
    const versionNo = Number.parseInt(args[1], 10);
    const chapter = book.chapters.find((item) => item.no === chapterNo);
    if (!chapter?.versions.includes(versionNo)) return '用法：/小说 恢复 <章号> <已有版本号>';
    const draft = {
      version: 1, active: true, kind: 'confirm', step: 'confirm',
      data: { bookId: book.id, action: 'restore', chapterNo, versionNo },
      history: [], pausedAt: 0, updatedAt: this.now(), lastMessageId: '', seenMessages: [],
    };
    await this.store.updateDraft(owner, () => draft);
    return `即将把第 ${chapterNo} 章 v${versionNo} 恢复为新的最新版本。旧版本全部保留；相关摘要和音频缓存会失效。回复“确认”执行，或“取消”。`;
  }

  async #prepareDelete(owner, args) {
    const bookNo = Number.parseInt(args[0], 10);
    const book = this.store.library(owner).books.find((item) => item.no === bookNo);
    if (!book) return '用法：/小说 删除 <书架编号>';
    const draft = {
      version: 1, active: true, kind: 'confirm', step: 'confirm',
      data: { bookId: book.id, action: 'delete_book', title: book.title },
      history: [], pausedAt: 0, updatedAt: this.now(), lastMessageId: '', seenMessages: [],
    };
    await this.store.updateDraft(owner, () => draft);
    return `即将删除《${book.title}》：全部 ${book.chapters.length} 章及所有历史版本、人物、设定和大纲。TXT/音频文件到期后会清理。\n只影响当前用户的这本书。回复“确认”删除，或“取消”。`;
  }

  async #executeConfirmation(owner, draft, invocation) {
    const data = draft.data || {};
    if (data.action === 'apply_outline') {
      const outline = Array.isArray(data.outline)
        ? data.outline.map((line) => clip(line, 1000)).filter(Boolean).slice(0, 1000)
        : [];
      if (!outline.length) throw new Error('待应用的大纲候选为空');
      await this.store.updateLibrary(owner, (library) => {
        const book = library.books.find((item) => item.id === data.bookId);
        if (!book) throw new Error('书籍不存在');
        book.outline = outline;
        book.generatedOutline = [];
        book.memory = { validThrough: 0, cumulative: '', states: [] };
        book.audioArtifacts = {};
        for (const chapter of book.chapters) chapter.audioFingerprint = '';
        book.updatedAt = this.now();
        return library;
      });
      draft.active = false;
      await this.store.updateDraft(owner, () => draft);
      return {
        handled: true,
        text: `已应用《${data.title || '当前书'}》的大纲，共 ${outline.length} 条。记忆和受影响音频缓存已失效。`,
      };
    }
    if (data.action === 'restore') {
      this.assertNoActiveWritingTask(owner, data.bookId);
      const current = this.currentBook(owner);
      const old = this.store.readVersion(owner, data.bookId, data.chapterNo, data.versionNo);
      const row = await this.store.appendVersion(owner, data.bookId, data.chapterNo, {
        title: old.title, body: old.body, summary: old.summary, states: old.states,
        source: 'restore', taskId: '',
      });
      draft.active = false;
      await this.store.updateDraft(owner, () => draft);
      return { handled: true, text: `已从 v${data.versionNo} 恢复为第 ${current.chapters.find((item) => item.no === data.chapterNo)?.no} 章 v${row.versionNo}。` };
    }
    if (data.action === 'delete_book') {
      await this.store.deleteBook(owner, data.bookId);
      draft.active = false;
      await this.store.updateDraft(owner, () => draft);
      return { handled: true, text: `已删除《${data.title || '这本书'}》及其版本索引。` };
    }
    draft.active = false;
    await this.store.updateDraft(owner, () => draft);
    return { handled: true, text: '未知确认操作，已取消。' };
  }

  async #beginImport(owner) {
    const draft = importDraft();
    await this.store.updateDraft(owner, () => draft);
    return '请发送 UTF-8 TXT 正文，或直接带 TXT/JSON 备份文件发送；数据会先解析预览，确认后才写入书库。';
  }

  async #backup(owner, invocation) {
    if (invocation.kind === 'group' && invocation.mentioned !== true) {
      return '群聊发送备份需要 @机器人。';
    }
    const book = this.currentBook(owner);
    const versions = book.chapters.flatMap((chapter) =>
      chapter.versions.map((version) => this.store.readVersion(owner, book.id, chapter.no, version)));
    const bytes = backupJson(book, versions, this.now());
    const fileName = `${safeName(book.title)}-备份.json`;
    const artifact = await this.writeArtifact(fileName, bytes, owner, book.id, 'backup');
    return {
      text: `《${book.title}》备份已生成；不含凭证、其他用户或任务投递记录。`,
      outbox: [{
        artifactId: artifact.id, path: artifact.path, fileName, kind: 'backup',
        requestId: `novel-backup-${hash(artifact.id).slice(0, 24)}`,
      }],
    };
  }

  async #speech(owner, args, invocation) {
    const book = this.currentBook(owner);
    const action = args[0] || '';
    if (action === '状态') {
      const sources = await this.#voiceSources();
      const official = sources.official;
      const lines = [
        `官方语音：${official.configured ? '可用' : '不可用'}${official.provider ? `（${official.provider}）` : ''}`,
        official.configured
          ? `官方语速：已保存 ${official.savedSpeed}，实际生效 ${official.effectiveSpeed}${official.savedSpeed !== official.effectiveSpeed ? '（来源固定语速）' : ''}`
          : '',
        official.missing.length ? `官方缺少：${official.missing.join('、')}` : '',
        official.error ? `官方错误：${official.error}` : '',
        ...official.limitations.slice(0, 3).map((line) => `说明：${line}`),
        `语音回复扩展：${sources.extension.configured ? '可用' : '不可用'}${sources.extension.profiles?.length ? `，方案 ${sources.extension.profiles.map((item) => `${item.name}[${item.id.slice(0, 8)}]`).join('、')}` : ''}`,
        sources.extension.missing.length ? `扩展缺少：${sources.extension.missing.join('、')}` : '',
        sources.extension.error ? `扩展错误：${sources.extension.error}` : '',
        `FFmpeg：${this.runtime.ffmpegBinary?.() ? '可用' : '未安装（TXT 不受影响）'}`,
      ];
      return lines.filter(Boolean).join('\n');
    }
    if (action === '设置') {
      const sources = await this.#voiceSources();
      if (args.length === 1) {
        return [
          `当前：${this.describeVoice(book.voice)}`,
          '官方：/小说 朗读 设置 官方 [音色] [语速]',
          '语音回复扩展：/小说 朗读 设置 扩展 <方案编号或名称> [语速]',
          `官方状态：${sources.official.configured ? '可用' : '不可用'}${sources.official.configured ? `；已保存语速 ${sources.official.savedSpeed}，实际生效 ${sources.official.effectiveSpeed}` : ''}`,
          sources.official.missing.length ? `官方缺少：${sources.official.missing.join('、')}` : '',
          `扩展状态：${sources.extension.configured ? '可用' : '不可用'}`,
          sources.extension.missing.length ? `扩展缺少：${sources.extension.missing.join('、')}` : '',
          sources.extension.profiles?.length
            ? `可用方案：${sources.extension.profiles.map((item) => `${item.name}(${item.id.slice(0, 8)})`).join('、')}`
            : '',
        ].filter(Boolean).join('\n');
      }
      const sourceName = args[1];
      const source = sourceName === '官方' ? 'official' : sourceName === '扩展' || sourceName === '语音回复' ? 'extension' : '';
      if (!source) return '来源只支持“官方”或“扩展”。';
      let voice = {};
      if (source === 'official') {
        const official = sources.official;
        if (!official.configured) return '官方语音当前不可用，请主人先在语音设置中配置并启用。';
        const speedArg = args.at(-1);
        const parsedSpeed = Number(speedArg);
        const hasSpeed = Number.isFinite(parsedSpeed) && parsedSpeed >= 0.5 && parsedSpeed <= 2;
        const requestedVoice = clip(hasSpeed ? args.slice(2, -1).join(' ') : args.slice(2).join(' '), 100);
        if (!official.supportsVoiceOverride && requestedVoice && requestedVoice !== official.voice) {
          return `官方语音只能使用已保存的全局音色${official.voice ? `（${official.voice}）` : ''}，不支持本书单独覆盖。`;
        }
        const targetSpeed = hasSpeed ? parsedSpeed : official.effectiveSpeed;
        if (!official.supportsSpeedOverride && targetSpeed !== official.effectiveSpeed) {
          const detail = official.savedSpeed !== official.effectiveSpeed
            ? `（已保存全局语速 ${official.savedSpeed}，当前实际生效 ${official.effectiveSpeed}）`
            : '';
          return `官方语音只能使用当前实际语速 ${official.effectiveSpeed}${detail}，不支持本书单独覆盖。`;
        }
        voice = {
          source,
          profileId: '',
          voice: requestedVoice || official.voice,
          speed: targetSpeed,
        };
      } else {
        if (!sources.extension?.configured) return '语音回复扩展当前不可用，请主人先完成它的配置。';
        const speedArg = args.at(-1);
        const speed = Number(speedArg);
        const hasSpeed = Number.isFinite(speed) && speed >= 0.5 && speed <= 2;
        const selector = clip(hasSpeed ? args.slice(2, -1).join(' ') : args.slice(2).join(' '), 100);
        if (!selector) return '请给出音色方案名称或编号。';
        const profile = sources.extension.profiles.find((item) => item.id === selector)
          || sources.extension.profiles.find((item) => item.name === selector)
          || sources.extension.profiles.find((item) => item.id.startsWith(selector));
        if (!profile) return '没有匹配的音色方案。';
        voice = { source, profileId: profile.id, voice: '', speed: hasSpeed ? speed : 1 };
      }
      await this.store.updateLibrary(owner, (library) => {
        const hit = library.books.find((item) => item.id === book.id);
        hit.voice = voice;
        return library;
      });
      return `已设置当前书朗读方式：${this.describeVoice(voice)}`;
    }

    const range = action || '最新';
    const numbers = chapterRange(book, range);
    if (numbers.length > 3) return '手动朗读一次最多 3 章。请指定章号或更小范围。';
    if (!book.voice?.source) return '还没有设置朗读方式。先发送 /小说 朗读 状态，再发送 /小说 朗读 设置 官方 或 扩展。';
    if (!this.runtime.ffmpegBinary?.()) return 'FFmpeg 未安装，朗读暂不可用；TXT 功能不受影响。';
    const task = await this.enqueue({
      kind: 'speech',
      owner,
      invocation,
      input: { bookId: book.id, chapters: numbers, selection: book.voice },
      dedupe: `${invocation.messageId}:speech:${numbers.join(',')}`,
    });
    const text = `朗读任务已开始：${task.id}\n章节：${numbers.join('、')}；完成后发送普通 MP3 文件。`;
    return { text, taskId: task.id, watchTaskIds: [task.id] };
  }

  describeVoice(voice) {
    if (!voice?.source) return '未设置';
    const name = voice.source === 'official'
      ? `官方语音${voice.voice ? `（${voice.voice}）` : ''}`
      : `语音回复扩展（${voice.profileId?.slice(0, 8) || '方案'}）`;
    return `${name}，语速 ${Number(voice.speed) || 1}`;
  }

  async #autoSpeech(owner, args) {
    const book = this.currentBook(owner);
    const value = args[0] || '';
    if (!['开', '关'].includes(value)) return `《${book.title}》自动朗读：${book.autoRead ? '开' : '关'}\n用法：/小说 自动朗读 开|关`;
    if (value === '开' && !book.voice?.source) return '请先设置朗读来源，再开启自动朗读。';
    await this.store.updateLibrary(owner, (library) => {
      const hit = library.books.find((item) => item.id === book.id);
      hit.autoRead = value === '开';
      return library;
    });
    return `《${book.title}》自动朗读已${value}。自动朗读不阻塞正文和 TXT。`;
  }

  publicTask(task) {
    if (!task) return null;
    return {
      id: task.id,
      kind: task.kind,
      status: task.status,
      stage: task.stage,
      progress: task.progress,
      error: task.error || '',
      notice: task.notice || '',
      followUps: Array.isArray(task.followUps) ? task.followUps.slice(0, 10) : [],
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      outbox: (task.outbox || []).map((item) => ({
        kind: item.kind, state: item.state, fileName: item.fileName,
      })),
      conflict: task.pendingCandidate?.chapterNo ? {
        chapterNo: task.pendingCandidate.chapterNo,
        expectedVersion: task.pendingCandidate.expectedVersion,
        currentVersion: task.pendingCandidate.currentVersion,
      } : task.conflict || null,
    };
  }

  async #tasks(owner, id) {
    if (id) {
      const task = this.store.task(id);
      if (!task || task.ownerKey !== owner) return '没有这个任务。';
      return this.formatTask(task);
    }
    const tasks = this.store.tasksFor(owner).sort((a, b) => b.createdAt - a.createdAt).slice(0, 12);
    if (!tasks.length) return '还没有小说任务。';
    return tasks.map((task) => this.formatTask(task, true)).join('\n\n').slice(0, 1800);
  }

  formatTask(task, short = false) {
    const progress = task.progress || {};
    const line = `${task.id}｜${task.kind}｜${task.status}｜${task.stage || '-'}${progress.total ? ` ${progress.done || 0}/${progress.total}` : ''}`;
    return short ? line : [
      line,
      task.error ? `错误：${task.error}` : '',
      task.notice || '',
      ...(task.outbox || []).map((item) => `${item.kind}:${item.state}:${item.fileName}`),
    ].filter(Boolean).join('\n');
  }

  async #stop(owner, id) {
    let task = id ? this.store.task(id) : this.store.tasksFor(owner).filter((item) => ['queued', 'running'].includes(item.status)).at(-1);
    if (!task || task.ownerKey !== owner) return '没有可停止的任务。';
    if (['done', 'cancelled'].includes(task.status)) return `任务已经是 ${task.status}。`;
    task.cancelRequested = true;
    this.cancelOutbox(task);
    if (['queued', 'interrupted', 'error', 'conflict'].includes(task.status)) {
      task.status = 'cancelled';
      task.stage = 'cancelled';
      task.notice = '任务已停止；迟到结果不会落稿或发送。';
    }
    await this.store.saveTask(task);
    this.controllers.get(task.id)?.abort();
    if (task.status === 'cancelled') await this.cancelFollowUps(task);
    return `已停止 ${task.id}。迟到模型结果不会保存或发送；已提交正文仍保留。`;
  }

  async #retry(owner, id) {
    const old = id ? this.store.task(id) : this.store.tasksFor(owner)
      .filter((item) => ['error', 'interrupted', 'conflict'].includes(item.status)).at(-1);
    if (!old || old.ownerKey !== owner) return '没有可重试的失败、中断或冲突任务。';
    if (!['error', 'interrupted', 'cancelled', 'conflict'].includes(old.status)) return '这个任务不是可重试状态。';
    const task = await this.enqueue({
      kind: old.kind,
      owner,
      invocation: old.invocation,
      input: structuredClone(old.input),
      dedupe: '',
      resume: {
        completed: structuredClone(old.completed || {}),
        generated: structuredClone(old.generated || []),
        pendingSummary: structuredClone(old.pendingSummary || null),
        planned: structuredClone(old.planned || []),
        stage: old.stage,
      },
      sourceTaskId: old.id,
    });
    const text = `已创建重试任务：${task.id}\n会复用已完成章节、摘要或音频分段。`;
    return { text, taskId: task.id, watchTaskIds: [task.id] };
  }

  async #claim(owner, id, invocation) {
    const tasks = id
      ? [this.store.task(id)].filter(Boolean)
      : this.store.tasksFor(owner).filter((task) => task.outbox?.some((item) => !['sent', 'cancelled'].includes(item.state)));
    if (tasks.some((task) => task.ownerKey !== owner)) return '任务不存在。';
    return await this.outboxFor(owner, tasks, invocation);
  }

  async watch(owner, taskId, invocation) {
    const task = this.store.task(taskId);
    if (!task || task.ownerKey !== owner) throw new Error('任务不存在或不属于当前书库');
    const outbox = await this.outboxFor(owner, [task], invocation);
    if (!['done', 'error', 'cancelled', 'interrupted', 'conflict'].includes(task.status)) return { handled: true, task: this.publicTask(task) };
    return {
      handled: true,
      task: this.publicTask(task),
      text: task.notice || '',
      outbox: outbox.outbox || [],
    };
  }

  async deliver(owner, payload) {
    const task = this.store.task(clip(payload.taskId, 80));
    if (!task || task.ownerKey !== owner) throw new Error('成果不属于当前书库');
    const artifactId = clip(payload.artifactId, 80);
    const item = task.outbox?.find((row) => row.artifactId === artifactId);
    if (!item) throw new Error('任务里没有这个成果');
    const state = clip(payload.state, 20);
    if (!['sent', 'pending', 'failed', 'sending'].includes(state)) throw new Error('投递状态无效');
    item.state = state;
    item.attempts = (Number(item.attempts) || 0) + 1;
    item.resultId = clip(payload.resultId, 160);
    item.error = state === 'failed' ? clip(payload.error, 240) : '';
    item.updatedAt = this.now();
    await this.store.saveTask(task);
    return { ok: true, state };
  }

  async outboxFor(owner, tasks, invocation) {
    const items = [];
    for (const task of tasks) {
      if (task.cancelRequested === true || ['cancelled', 'conflict'].includes(task.status)) continue;
      for (const item of task.outbox || []) {
        if (item.state === 'sent' || item.state === 'sending' || item.state === 'cancelled') continue;
        try {
          const artifact = this.runtime.artifacts.resolve(item.artifactId, owner);
          items.push({
            taskId: task.id,
            artifactId: item.artifactId,
            path: artifact.path,
            fileName: item.fileName || artifact.fileName,
            kind: item.kind,
            requestId: item.requestId,
          });
        } catch (error) {
          item.state = 'failed';
          item.error = publicError(error);
        }
      }
    }
    return {
      handled: true,
      text: items.length ? '有待领取文件。' : '当前没有可发送的新文件。',
      outbox: items.slice(0, 20),
      replyContext: {
        kind: invocation.kind,
        receivedAt: invocation.receivedAt,
        messageId: invocation.messageId,
      },
    };
  }

  async enqueue({
    kind, owner, invocation, input, dedupe = '', resume = null, sourceTaskId = '',
  }) {
    if (this.closing) throw serviceClosedError();
    const existing = this.store.findDedupe(owner, dedupe);
    if (existing) return existing;
    if (this.closing) throw serviceClosedError();
    const now = this.now();
    const task = {
      version: 1,
      id: `task-${shortId('t').slice(2)}`,
      ownerKey: owner,
      kind,
      status: 'queued',
      stage: 'queued',
      progress: { done: 0, total: 0 },
      input: structuredClone(input),
      invocation: {
        source: 'qq', requestId: clip(invocation.requestId, 128), pluginId: clip(invocation.pluginId, 80),
        botId: clip(invocation.botId, 128), kind: invocation.kind, chatId: clip(invocation.chatId, 256),
        userId: clip(invocation.userId, 256), messageId: clip(invocation.messageId, 512),
        receivedAt: Number(invocation.receivedAt), mentioned: invocation.mentioned === true,
        eventId: clip(invocation.eventId, 512),
      },
      dedupeKey: clip(dedupe, 200),
      sourceTaskId: clip(sourceTaskId, 80),
      completed: resume?.completed || {},
      generated: resume?.generated || [],
      planned: resume?.planned || [],
      pendingSummary: resume?.pendingSummary || null,
      outbox: [],
      followUps: [],
      error: '',
      notice: '',
      cancelRequested: false,
      createdAt: now,
      updatedAt: now,
    };
    if (resume?.stage) task.resumeStage = clip(resume.stage, 60);
    await this.store.createTask(task);
    setImmediate(() => this.pump());
    return task;
  }

  laneOf(kind) {
    return kind === 'speech' ? 'speech' : 'writing';
  }

  pump() {
    if (this.closing) return;
    for (const lane of ['writing', 'speech']) {
      if (this.closing) return;
      if (this.lanes.has(lane)) continue;
      const task = this.store.queuedTasks().find((item) => this.laneOf(item.kind) === lane);
      if (!task) continue;
      this.lanes.add(lane);
      let run;
      run = this.runTask(task).finally(() => {
        this.activeRuns.delete(run);
        this.lanes.delete(lane);
        if (!this.closing) setImmediate(() => this.pump());
      });
      this.activeRuns.add(run);
    }
  }

  isCancelled(task, signal) {
    return task.cancelRequested === true || signal?.aborted === true;
  }

  throwIfCancelled(task, signal) {
    if (!this.isCancelled(task, signal)) return;
    throw Object.assign(new Error('任务已取消'), { name: 'AbortError' });
  }

  cancelOutbox(task) {
    for (const item of task.outbox || []) {
      if (item.state !== 'sent') item.state = 'cancelled';
    }
  }

  async cancelFollowUps(task) {
    for (const id of task.followUps || []) {
      const followUp = this.store.task(id);
      if (!followUp || followUp.status === 'cancelled') continue;
      followUp.cancelRequested = true;
      if (['queued', 'interrupted', 'error', 'conflict'].includes(followUp.status)) {
        followUp.status = 'cancelled';
        followUp.stage = 'cancelled';
        followUp.notice = '上级任务已停止，未领取成果不会发送。';
      }
      this.cancelOutbox(followUp);
      this.controllers.get(id)?.abort();
      await this.store.saveTask(followUp);
      await this.cancelFollowUps(followUp);
    }
  }

  assertNoActiveWritingTask(owner, bookId) {
    const active = this.store.tasksFor(owner).find((task) =>
      ['queued', 'running'].includes(task.status)
      && ['write', 'rewrite'].includes(task.kind)
      && task.input?.bookId === bookId);
    if (!active) return;
    throw new Error(`这本书还有${active.status === 'running' ? '正在执行' : '排队中的'}写作任务 ${active.id}。请先发送 /小说 停止 ${active.id}，再保存人工版本。`);
  }

  versionConflict(chapterNo, expectedVersion, currentVersion) {
    return Object.assign(
      new Error(`检测到第 ${chapterNo} 章的人工新版本：预期 v${expectedVersion}，当前 v${currentVersion}`),
      {
        name: 'NovelVersionConflictError',
        code: 'CHAPTER_VERSION_CONFLICT',
        chapterNo: Number(chapterNo),
        expectedVersion: Number(expectedVersion),
        currentVersion: Number(currentVersion),
      },
    );
  }

  async runTask(task) {
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    task.status = 'running';
    task.stage = 'starting';
    task.error = '';
    task.notice = '';
    await this.store.saveTask(task);
    try {
      if (task.kind === 'write') await this.runWriteTask(task, controller.signal);
      else if (task.kind === 'rewrite') await this.runRewriteTask(task, controller.signal);
      else if (task.kind === 'outline') await this.runOutlineTask(task, controller.signal);
      else if (task.kind === 'speech') await this.runSpeechTask(task, controller.signal);
      else throw new Error('未知任务类型');
      this.throwIfCancelled(task, controller.signal);
      task.status = 'done';
      task.stage = 'done';
      task.notice = task.notice || `任务 ${task.id} 已完成。`;
    } catch (error) {
      if (this.closing) {
        task.status = 'interrupted';
        task.stage = 'interrupted';
        task.error = '宿主关闭时任务被中断；已完成章节、音频分段和待领取成果已保留，可重试';
        task.notice = '宿主已关闭，任务保留为可重试状态，不会视为用户停止。';
      } else if (error?.name === 'AbortError' || this.isCancelled(task, controller.signal)) {
        task.status = 'cancelled';
        task.stage = 'cancelled';
        task.error = '';
        task.notice = '任务已停止；迟到结果未保存或发送，已提交正文仍保留。';
        this.cancelOutbox(task);
        await this.cancelFollowUps(task);
      } else if (error?.code === 'CHAPTER_VERSION_CONFLICT') {
        task.status = 'conflict';
        task.stage = 'conflict';
        task.error = publicError(error);
        task.conflict = {
          chapterNo: error.chapterNo,
          expectedVersion: error.expectedVersion,
          currentVersion: error.currentVersion,
        };
        if (task.pendingCandidate) {
          task.pendingCandidate.expectedVersion = error.expectedVersion;
          task.pendingCandidate.currentVersion = error.currentVersion;
        }
        task.notice = `${task.error}。自动生成结果已保留为冲突候选，没有覆盖人工版本，也不会自动发送。发送 /小说 任务 ${task.id} 查看。`;
        this.cancelOutbox(task);
      } else {
        task.status = 'error';
        task.error = publicError(error);
        task.notice = `任务失败：${task.error}\n可发送 /小说 重试 ${task.id}`;
      }
    } finally {
      this.controllers.delete(task.id);
      await this.store.saveTask(task).catch(() => {});
    }
  }

  async generate(task, stage, system, prompt, maxTokens, signal) {
    task.stage = stage;
    await this.store.saveTask(task);
    this.throwIfCancelled(task, signal);
    const result = await this.runtime.model.generate({
      taskId: task.id,
      stage,
      system,
      messages: [{ role: 'user', content: prompt }],
      maxTokens,
      temperature: 0.72,
      signal,
    });
    this.throwIfCancelled(task, signal);
    return String(result?.text || '');
  }

  async ensureMemoryCurrent(task, owner, bookId, signal) {
    let book = this.store.library(owner).books.find((item) => item.id === bookId);
    if (!book) throw new Error('书籍不存在');
    const lastNo = book.chapters.at(-1)?.no || 0;
    let through = Number(book.memory?.validThrough) || 0;
    if (through >= lastNo) return book;
    task.stage = 'memory_rebuild';
    task.progress = { done: 0, total: Math.max(1, lastNo - through) };
    await this.store.saveTask(task);
    for (let no = through + 1; no <= lastNo; no += 1) {
      this.throwIfCancelled(task, signal);
      book = this.store.library(owner).books.find((item) => item.id === bookId);
      const chapter = book.chapters.find((item) => item.no === no);
      if (!chapter) continue;
      const version = this.store.readVersion(owner, book.id, no, chapter.currentVersion);
      const prompt = summaryPrompt(book, version);
      const raw = await this.generate(task, `memory_rebuild_${no}`, WRITER_SYSTEM, prompt, 3200, signal);
      const summary = parseSummaryJson(raw);
      this.throwIfCancelled(task, signal);
      await this.store.updateLibrary(owner, (library) => {
        const hit = library.books.find((item) => item.id === bookId);
        if (!hit) throw new Error('书籍不存在');
        const target = hit.chapters.find((item) => item.no === no);
        if (!target || target.currentVersion !== version.versionNo) {
          throw this.versionConflict(no, version.versionNo, target?.currentVersion || 0);
        }
        hit.memory = {
          validThrough: no,
          cumulative: summary.summary,
          states: summary.states,
        };
        return library;
      });
      task.progress.done = no - through;
      await this.store.saveTask(task);
    }
    return this.store.library(owner).books.find((item) => item.id === bookId);
  }

  async summarizeCommitted(task, owner, bookId, chapterNo, signal) {
    let book = this.store.library(owner).books.find((item) => item.id === bookId);
    let chapter = book?.chapters.find((item) => item.no === chapterNo);
    if (!book || !chapter) throw new Error('章节不存在，无法更新摘要');
    let version = this.store.readVersion(owner, book.id, chapter.no, chapter.currentVersion);
    task.stage = `summary_${chapterNo}`;
    task.pendingSummary = { chapterNo, versionNo: version.versionNo };
    await this.store.saveTask(task);
    const raw = await this.generate(task, `summary_${chapterNo}`, WRITER_SYSTEM, summaryPrompt(book, version), 3600, signal);
    const summary = parseSummaryJson(raw);
    this.throwIfCancelled(task, signal);
    await this.store.updateLibrary(owner, (library) => {
      const hit = library.books.find((item) => item.id === bookId);
      const target = hit.chapters.find((item) => item.no === chapterNo);
      if (!target) throw new Error('章节不存在，无法更新摘要');
      if (target.currentVersion !== version.versionNo) {
        throw this.versionConflict(chapterNo, version.versionNo, target.currentVersion);
      }
      target.summary = summary.summary;
      target.states = summary.states;
      hit.memory = {
        validThrough: chapterNo,
        cumulative: summary.summary,
        states: summary.states,
      };
      return library;
    });
    task.pendingSummary = null;
    task.completed.summaryThrough = chapterNo;
    await this.store.saveTask(task);
  }

  async exportRangeArtifact(owner, bookId, numbers, suffix = '', signal = null) {
    signal?.throwIfAborted?.();
    const book = this.store.library(owner).books.find((item) => item.id === bookId);
    if (!book) throw new Error('书籍不存在');
    const rows = this.latestVersions(owner, book, numbers);
    const bytes = readingTxt(book, rows);
    const fileName = txtFileName(book, rows, suffix);
    const artifact = await this.writeArtifact(fileName, bytes, owner, book.id, 'txt', signal);
    signal?.throwIfAborted?.();
    return { book, rows, fileName, artifact };
  }

  async queueAutoSpeech(task, owner, bookId, numbers, invocationSnapshot, signal = null) {
    this.throwIfCancelled(task, signal);
    const book = this.store.library(owner).books.find((item) => item.id === bookId);
    if (!book?.autoRead) return null;
    if (!book.voice?.source) {
      task.notice = `${task.notice || ''}\n自动朗读未开始：这本书还没有设置语音来源。`.trim();
      return null;
    }
    if (!this.runtime.ffmpegBinary?.()) {
      task.notice = `${task.notice || ''}\n自动朗读未开始：FFmpeg 未安装；TXT 已完成。`.trim();
      return null;
    }
    const speech = await this.enqueue({
      kind: 'speech',
      owner,
      invocation: invocationSnapshot,
      input: { bookId, chapters: numbers.slice(0, 3), selection: book.voice },
      dedupe: `auto:${task.id}`,
    });
    task.followUps = [...new Set([...(task.followUps || []), speech.id])];
    await this.store.saveTask(task);
    this.throwIfCancelled(task, signal);
    return speech;
  }

  async runWriteTask(task, signal) {
    const owner = task.ownerKey;
    let book = this.store.library(owner).books.find((item) => item.id === task.input.bookId);
    if (!book) throw new Error('书籍不存在');
    task.completed.chapters = Array.isArray(task.completed.chapters) ? task.completed.chapters : [];
    task.planned = Array.isArray(task.planned) && task.planned.length
      ? task.planned
      : Array.from({ length: task.input.count }, (_, index) => (book.chapters.at(-1)?.no || 0) + index + 1);
    task.progress = {
      done: task.completed.chapters.length,
      total: task.planned.length,
    };
    await this.store.saveTask(task);
    if (task.pendingSummary?.chapterNo
        && task.completed.chapters.some((item) => item.chapterNo === task.pendingSummary.chapterNo)) {
      await this.summarizeCommitted(task, owner, book.id, task.pendingSummary.chapterNo, signal);
    }
    await this.ensureMemoryCurrent(task, owner, book.id, signal);

    for (const chapterNo of task.planned) {
      this.throwIfCancelled(task, signal);
      const finished = task.completed.chapters.find((item) => item.chapterNo === chapterNo);
      if (finished) {
        if (task.pendingSummary?.chapterNo === chapterNo) {
          await this.summarizeCommitted(task, owner, book.id, chapterNo, signal);
        }
        continue;
      }
      book = this.store.library(owner).books.find((item) => item.id === task.input.bookId);
      const prior = this.latestVersions(owner, book, book.chapters.slice(-2).map((item) => item.no));
      const context = buildChapterContext({
        book,
        versions: prior,
        request: task.input.request,
        budget: Math.max(6000, Math.min(24_000, Number(this.config.maxContextChars) || 18_000)),
      });
      task.stage = `chapter_${chapterNo}`;
      const liveChapter = book.chapters.find((item) => item.no === chapterNo);
      const expectedVersion = Number(liveChapter?.currentVersion) || 0;
      await this.store.saveTask(task);
      const raw = await this.generate(
        task, `chapter_${chapterNo}`, WRITER_SYSTEM, context,
        Math.min(12_000, Math.max(3000, task.input.targetChars * 2 + 1200)), signal,
      );
      const parsed = parseChapterJson(raw, task.input.targetChars);
      task.pendingCandidate = {
        chapterNo,
        expectedVersion,
        title: parsed.chapterTitle,
        body: parsed.body,
        summary: parsed.summary,
        states: parsed.states,
        source: 'write',
        createdAt: this.now(),
      };
      await this.store.saveTask(task);
      this.throwIfCancelled(task, signal);
      const version = await this.store.appendVersion(owner, book.id, chapterNo, {
        title: parsed.chapterTitle,
        body: parsed.body,
        summary: parsed.summary,
        states: parsed.states,
        source: 'write',
        taskId: task.id,
        expectedVersion,
        signal,
      });
      this.throwIfCancelled(task, signal);
      task.pendingCandidate = null;
      task.completed.chapters.push({ chapterNo, versionNo: version.versionNo, chars: parsed.chars });
      task.pendingSummary = { chapterNo, versionNo: version.versionNo };
      task.progress.done = task.completed.chapters.length;
      await this.store.saveTask(task);
      await this.summarizeCommitted(task, owner, book.id, chapterNo, signal);
      this.throwIfCancelled(task, signal);
    }

    this.throwIfCancelled(task, signal);
    const exported = await this.exportRangeArtifact(owner, book.id, task.planned, '', signal);
    this.throwIfCancelled(task, signal);
    if (!task.outbox.length) {
      task.outbox.push({
        artifactId: exported.artifact.id,
        path: exported.artifact.path,
        fileName: exported.fileName,
        kind: 'txt',
        chapterNos: exported.rows.map((row) => row.chapterNo),
        requestId: `novel-txt-${hash(task.id, exported.artifact.id).slice(0, 24)}`,
        state: 'queued',
      });
    }
    this.throwIfCancelled(task, signal);
    task.notice = `《${exported.book.title}》第 ${task.planned.join('、')} 章已保存，TXT：${exported.fileName}`;
    await this.queueAutoSpeech(task, owner, book.id, task.planned, task.invocation, signal);
    this.throwIfCancelled(task, signal);
    await this.store.saveTask(task);
  }

  async runRewriteTask(task, signal) {
    const owner = task.ownerKey;
    const book = this.store.library(owner).books.find((item) => item.id === task.input.bookId);
    if (!book) throw new Error('书籍不存在');
    const chapter = book.chapters.find((item) => item.no === task.input.chapterNo);
    if (!chapter) throw new Error('要重写的章节不存在');
    const current = this.store.readVersion(owner, book.id, chapter.no, chapter.currentVersion);
    const prior = this.latestVersions(owner, book, book.chapters.slice(-2).map((item) => item.no));
    const context = buildChapterContext({
      book,
      versions: prior,
      request: `重写第 ${chapter.no} 章为完整新版本。要求：${task.input.request || '保持原有事实与主线，改善节奏、细节和衔接'}\n当前旧稿：${current.body}`,
      budget: Math.max(6000, Math.min(24_000, Number(this.config.maxContextChars) || 18_000)),
    });
    if (task.completed.chapterVersion) {
      task.stage = 'export';
    } else {
      const expectedVersion = Number(chapter.currentVersion) || 0;
      const raw = await this.generate(
        task, `rewrite_${chapter.no}`, WRITER_SYSTEM, context,
        Math.min(12_000, Math.max(3000, task.input.targetChars * 2 + 1200)), signal,
      );
      const parsed = parseChapterJson(raw, task.input.targetChars);
      task.pendingCandidate = {
        chapterNo: chapter.no,
        expectedVersion,
        title: parsed.chapterTitle,
        body: parsed.body,
        summary: parsed.summary,
        states: parsed.states,
        source: 'rewrite',
        createdAt: this.now(),
      };
      await this.store.saveTask(task);
      this.throwIfCancelled(task, signal);
      const version = await this.store.appendVersion(owner, book.id, chapter.no, {
        title: parsed.chapterTitle,
        body: parsed.body,
        summary: parsed.summary,
        states: parsed.states,
        source: 'rewrite',
        taskId: task.id,
        expectedVersion,
        signal,
      });
      this.throwIfCancelled(task, signal);
      task.pendingCandidate = null;
      await this.store.updateLibrary(owner, (library) => {
        const hit = library.books.find((item) => item.id === book.id);
        for (const item of hit.chapters) {
          if (item.no > chapter.no) item.needsReview = true;
        }
        return library;
      });
      task.completed.chapterVersion = version.versionNo;
      task.progress = { done: 1, total: 2 };
    }
    task.stage = 'export';
    this.throwIfCancelled(task, signal);
    const exported = await this.exportRangeArtifact(owner, book.id, [chapter.no], '重写', signal);
    this.throwIfCancelled(task, signal);
    if (!task.outbox.length) {
      task.outbox.push({
        artifactId: exported.artifact.id,
        path: exported.artifact.path,
        fileName: exported.fileName,
        kind: 'txt',
        chapterNo: chapter.no,
        requestId: `novel-rewrite-${hash(task.id, exported.artifact.id).slice(0, 24)}`,
        state: 'queued',
      });
    }
    this.throwIfCancelled(task, signal);
    task.notice = `第 ${chapter.no} 章已生成新版本，TXT：${exported.fileName}`;
    await this.queueAutoSpeech(task, owner, book.id, [chapter.no], task.invocation, signal);
    this.throwIfCancelled(task, signal);
    await this.store.saveTask(task);
  }

  async runOutlineTask(task, signal) {
    const owner = task.ownerKey;
    const book = this.store.library(owner).books.find((item) => item.id === task.input.bookId);
    if (!book) throw new Error('书籍不存在');
    const raw = await this.generate(
      task, 'outline_generate', WRITER_SYSTEM, outlinePrompt(book), 5000, signal,
    );
    const outline = parseOutlineJson(raw, book.outline);
    this.throwIfCancelled(task, signal);
    await this.store.updateLibrary(owner, (library) => {
      const hit = library.books.find((item) => item.id === task.input.bookId);
      hit.generatedOutline = outline;
      return library;
    });
    this.throwIfCancelled(task, signal);
    task.progress = { done: 1, total: 1 };
    task.notice = `已生成 ${outline.length} 条大纲候选。发送 /小说 大纲 确认 应用，或 /小说 任务 ${task.id} 查看。`;
  }

  async runSpeechTask(task, signal) {
    const owner = task.ownerKey;
    const book = this.store.library(owner).books.find((item) => item.id === task.input.bookId);
    if (!book) throw new Error('书籍不存在');
    const ffmpegBinary = this.runtime.ffmpegBinary?.();
    if (!ffmpegBinary) throw new Error('缺少 FFmpeg 依赖，TXT 仍可用；请在小说面板安装共享 FFmpeg');
    const snapshot = await this.runtime.voice.snapshot(task.input.selection, `${task.id}:${hash(JSON.stringify(task.input.selection)).slice(0, 12)}`);
    if (!snapshot?.token || !snapshot?.chunkChars || !snapshot?.fingerprint) {
      throw new Error('没有得到可用的语音配置快照');
    }
    task.generated = Array.isArray(task.generated) ? task.generated : [];
    task.progress = { done: 0, total: task.input.chapters.length * 2 };
    await this.store.saveTask(task);

    for (const chapterNo of task.input.chapters) {
      this.throwIfCancelled(task, signal);
      const liveBook = this.store.library(owner).books.find((item) => item.id === task.input.bookId);
      const chapter = liveBook.chapters.find((item) => item.no === chapterNo);
      if (!chapter) throw new Error(`第 ${chapterNo} 章不存在`);
      const version = this.store.readVersion(owner, liveBook.id, chapter.no, chapter.currentVersion);
      const fingerprint = hash(
        version.chapterNo, version.versionNo, version.body,
        snapshot.fingerprint,
      );
      const cached = liveBook.audioArtifacts?.[fingerprint];
      let parts = Array.isArray(cached) ? cached : [];
      let valid = parts.length > 0;
      for (const part of parts) {
        try { this.runtime.artifacts.resolve(part.artifactId, owner); }
        catch { valid = false; break; }
      }
      if (!valid) {
        task.stage = `speech_${chapterNo}`;
        await this.store.saveTask(task);
        const speechWorkDir = join(
          this.workDir,
          'speech',
          safeName(hash(owner, fingerprint), fingerprint),
          `chapter-${chapterNo}`,
        );
        const rows = await synthesizeChapter({
          chapterNo,
          text: version.body,
          voice: snapshot,
          workDir: speechWorkDir,
          outputDir: this.outputDir,
          ffmpegBinary,
          runtime: this.runtime,
          taskId: task.id,
          signal,
          checkCancelled: () => this.throwIfCancelled(task, signal),
          progress: (done, total) => {
            task.progress.done = Math.max(task.progress.done, done);
            task.progress.total = Math.max(total, task.input.chapters.length);
          },
        });
        parts = [];
        for (const row of rows) {
          this.throwIfCancelled(task, signal);
          const artifact = await this.runtime.artifacts.register({
            ownerKey: owner,
            bookId: liveBook.id,
            kind: 'audio',
            path: row.path,
            fileName: row.fileName,
            bytes: row.bytes,
          });
          this.throwIfCancelled(task, signal);
          parts.push({
            artifactId: artifact.id,
            fileName: row.fileName,
            bytes: row.bytes,
            part: row.part,
            parts: row.parts,
          });
        }
        this.throwIfCancelled(task, signal);
        await this.store.updateLibrary(owner, (library) => {
          const hit = library.books.find((item) => item.id === liveBook.id);
          const target = hit.chapters.find((item) => item.no === chapterNo);
          if (!target || target.currentVersion !== version.versionNo) {
            throw this.versionConflict(chapterNo, version.versionNo, target?.currentVersion || 0);
          }
          hit.audioArtifacts = hit.audioArtifacts || {};
          hit.audioArtifacts[fingerprint] = parts;
          target.audioFingerprint = fingerprint;
          return library;
        });
      }
      this.throwIfCancelled(task, signal);
      task.generated = task.generated.filter((item) => item.chapterNo !== chapterNo);
      task.generated.push({ chapterNo, fingerprint, parts });
      task.progress.done = task.input.chapters.indexOf(chapterNo) + 1;
      await this.store.saveTask(task);
    }

    this.throwIfCancelled(task, signal);
    task.outbox = task.generated.flatMap((chapter) => chapter.parts.map((part) => ({
      artifactId: part.artifactId,
      fileName: part.fileName,
      kind: 'audio',
      chapterNo: chapter.chapterNo,
      requestId: `novel-audio-${hash(task.id, part.artifactId).slice(0, 24)}`,
      state: 'queued',
    })));
    this.throwIfCancelled(task, signal);
    task.notice = `朗读完成：${task.input.chapters.join('、')} 章，共 ${task.outbox.length} 个 MP3 文件。`;
    await this.store.saveTask(task);
  }
}

export function createNovelService(options) {
  return new NovelService(options);
}
