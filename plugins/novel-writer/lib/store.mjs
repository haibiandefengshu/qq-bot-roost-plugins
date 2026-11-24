import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  atomicJson, clip, ownerKey as ownerKeyOf, readJson, withLock,
} from './util.mjs';

const EMPTY_LIBRARY = () => ({
  version: 1,
  nextBookNo: 1,
  currentBookId: '',
  books: [],
});

const EMPTY_DRAFT = () => ({
  version: 1,
  active: false,
  kind: '',
  step: '',
  data: {},
  history: [],
  pausedAt: 0,
  updatedAt: 0,
  lastMessageId: '',
  seenMessages: [],
});

const MESSAGE_RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MESSAGE_RECEIPT_MAX = 1000;

export class NovelStore {
  constructor(root) {
    this.root = String(root);
    this.owners = join(this.root, 'owners');
    this.tasks = join(this.root, 'tasks');
    this.tmp = join(this.root, 'tmp');
    mkdirSync(this.owners, { recursive: true, mode: 0o700 });
    mkdirSync(this.tasks, { recursive: true, mode: 0o700 });
    mkdirSync(this.tmp, { recursive: true, mode: 0o700 });
  }

  key(invocation) {
    return ownerKeyOf(invocation);
  }

  ownerDir(owner) {
    if (!/^[a-f0-9]{64}$/.test(String(owner))) throw new Error('书库身份格式有误');
    return join(this.owners, owner);
  }

  libraryFile(owner) {
    return join(this.ownerDir(owner), 'library.json');
  }

  draftFile(owner) {
    return join(this.ownerDir(owner), 'draft.json');
  }

  messageReceiptsFile(owner) {
    return join(this.ownerDir(owner), 'message-receipts.json');
  }

  taskFile(id) {
    if (!/^task-[a-f0-9-]{36}$/.test(String(id))) throw new Error('任务号格式有误');
    return join(this.tasks, `${id}.json`);
  }

  taskIndexFile() {
    return join(this.tasks, 'index.json');
  }

  library(owner) {
    const value = readJson(this.libraryFile(owner), EMPTY_LIBRARY());
    if (!value || value.version !== 1 || !Array.isArray(value.books)) {
      throw new Error('书库索引损坏，原文件已保留');
    }
    return value;
  }

  draft(owner) {
    const value = readJson(this.draftFile(owner), EMPTY_DRAFT());
    if (!value || value.version !== 1 || typeof value.data !== 'object') {
      throw new Error('填写草稿损坏，原文件已保留');
    }
    return value;
  }

  async updateLibrary(owner, fn) {
    return await withLock(this.ownerDir(owner), 'library', null, async () => {
      const current = this.library(owner);
      const next = await fn(structuredClone(current));
      atomicJson(this.libraryFile(owner), next);
      return next;
    });
  }

  async updateDraft(owner, fn) {
    return await withLock(this.ownerDir(owner), 'draft', null, async () => {
      const current = this.draft(owner);
      const next = await fn(structuredClone(current));
      atomicJson(this.draftFile(owner), next);
      return next;
    });
  }

  messageSeen(owner, key, now = Date.now()) {
    const value = readJson(this.messageReceiptsFile(owner), { version: 1, items: {} });
    if (!value || value.version !== 1 || typeof value.items !== 'object') {
      throw new Error('消息回执索引损坏，原文件已保留');
    }
    const at = Number(value.items[clip(key, 700)]);
    return Number.isFinite(at) && at > 0 && now - at <= MESSAGE_RECEIPT_TTL_MS;
  }

  async rememberMessage(owner, key, now = Date.now()) {
    const id = clip(key, 700);
    if (!id) return false;
    return await withLock(this.ownerDir(owner), 'message-receipts', null, async () => {
      const value = readJson(this.messageReceiptsFile(owner), { version: 1, items: {} });
      if (!value || value.version !== 1 || typeof value.items !== 'object') {
        throw new Error('消息回执索引损坏，原文件已保留');
      }
      if (value.items[id]) return false;
      value.items[id] = now;
      const cutoff = now - MESSAGE_RECEIPT_TTL_MS;
      value.items = Object.fromEntries(
        Object.entries(value.items)
          .filter(([, at]) => Number(at) >= cutoff)
          .sort((a, b) => Number(b[1]) - Number(a[1]))
          .slice(0, MESSAGE_RECEIPT_MAX),
      );
      atomicJson(this.messageReceiptsFile(owner), value);
      return true;
    });
  }

  book(owner, bookId) {
    const key = clip(bookId, 100);
    const book = this.library(owner).books.find((item) => item.id === key);
    return book || null;
  }

  currentBook(owner) {
    const library = this.library(owner);
    return library.books.find((item) => item.id === library.currentBookId) || null;
  }

  async deleteBook(owner, bookId) {
    const key = clip(bookId, 100);
    return await withLock(this.ownerDir(owner), 'library', null, async () => {
      const library = this.library(owner);
      const book = library.books.find((item) => item.id === key);
      if (!book) throw new Error('书籍不存在');
      library.books = library.books.filter((item) => item.id !== key);
      if (library.currentBookId === key) library.currentBookId = library.books[0]?.id || '';
      atomicJson(this.libraryFile(owner), library);
      const directory = join(this.ownerDir(owner), 'books', key);
      rmSync(directory, { recursive: true, force: true });
      return book;
    });
  }

  chapterDir(owner, bookId) {
    return join(this.ownerDir(owner), 'books', clip(bookId, 100), 'chapters');
  }

  versionFile(owner, bookId, chapterNo, versionNo) {
    const chapter = Number(chapterNo);
    const version = Number(versionNo);
    if (!Number.isInteger(chapter) || chapter < 1 || !Number.isInteger(version) || version < 1) {
      throw new Error('章节或版本号格式有误');
    }
    return join(this.chapterDir(owner, bookId), String(chapter), `v${String(version).padStart(4, '0')}.json`);
  }

  readVersion(owner, bookId, chapterNo, versionNo) {
    const value = readJson(this.versionFile(owner, bookId, chapterNo, versionNo), null);
    if (!value || value.chapterNo !== Number(chapterNo) || value.versionNo !== Number(versionNo)) {
      throw new Error('章节版本不存在或已损坏');
    }
    return value;
  }

  async appendVersion(owner, bookId, chapterNo, {
    title, body, summary = '', states = [], source = 'write', taskId = '',
    expectedVersion = null, signal = null,
  }) {
    return await withLock(this.ownerDir(owner), 'library', signal, async () => {
      signal?.throwIfAborted?.();
      const library = this.library(owner);
      const book = library.books.find((item) => item.id === bookId);
      if (!book) throw new Error('书籍不存在');
      const chapter = book.chapters.find((item) => item.no === Number(chapterNo));
      const currentVersion = Number(chapter?.currentVersion) || 0;
      if (expectedVersion !== null && currentVersion !== Number(expectedVersion)) {
        throw Object.assign(
          new Error(`第 ${chapterNo} 章已有新版本：预期 v${expectedVersion}，当前 v${currentVersion}`),
          {
            name: 'NovelVersionConflictError',
            code: 'CHAPTER_VERSION_CONFLICT',
            chapterNo: Number(chapterNo),
            expectedVersion: Number(expectedVersion),
            currentVersion,
          },
        );
      }
      const previous = chapter?.versions?.at(-1) || 0;
      const versionNo = previous + 1;
      const row = {
        version: 1,
        chapterNo: Number(chapterNo),
        versionNo,
        title: clip(title, 120),
        body: String(body ?? '').replace(/\r\n?/g, '\n').trim(),
        summary: clip(summary, 2500),
        states: Array.isArray(states) ? states.map((item) => clip(item, 500)).filter(Boolean).slice(0, 100) : [],
        source: clip(source, 30),
        taskId: clip(taskId, 80),
        createdAt: Date.now(),
        immutable: true,
      };
      if (!row.title || !row.body) throw new Error('章节标题和正文不能为空');
      atomicJson(this.versionFile(owner, bookId, chapterNo, versionNo), row);
      const now = Date.now();
      if (chapter) {
        chapter.versions.push(versionNo);
        chapter.currentVersion = versionNo;
        chapter.title = row.title;
        chapter.chars = Array.from(row.body.replace(/\s/g, '')).length;
        chapter.updatedAt = now;
        chapter.summary = row.summary;
        chapter.states = row.states;
        this.markMemoryStale(book, Number(chapterNo));
      } else {
        book.chapters.push({
          no: Number(chapterNo),
          title: row.title,
          chars: Array.from(row.body.replace(/\s/g, '')).length,
          currentVersion: versionNo,
          versions: [versionNo],
          summary: row.summary,
          states: row.states,
          createdAt: now,
          updatedAt: now,
        });
        book.chapters.sort((a, b) => a.no - b.no);
      }
      book.updatedAt = now;
      atomicJson(this.libraryFile(owner), library);
      return row;
    });
  }

  markMemoryStale(book, chapterNo) {
    book.memory = book.memory || { validThrough: 0, cumulative: '', states: [] };
    book.memory.validThrough = Math.min(Number(book.memory.validThrough) || 0, Math.max(0, chapterNo - 1));
    for (const chapter of book.chapters) {
      if (chapter.no >= chapterNo) chapter.audioFingerprint = '';
    }
  }

  createTask(task) {
    return withLock(this.tasks, 'index', null, async () => {
      const index = readJson(this.taskIndexFile(), { version: 1, items: {} });
      if (!index || index.version !== 1 || typeof index.items !== 'object') throw new Error('任务索引损坏');
      if (index.items[task.id]) return index.items[task.id];
      index.items[task.id] = {
        id: task.id,
        ownerKey: task.ownerKey,
        kind: task.kind,
        status: task.status,
        dedupeKey: task.dedupeKey || '',
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      };
      atomicJson(this.taskFile(task.id), task);
      atomicJson(this.taskIndexFile(), index);
      return task;
    });
  }

  findDedupe(owner, dedupeKey) {
    if (!dedupeKey) return null;
    const index = readJson(this.taskIndexFile(), { version: 1, items: {} });
    for (const item of Object.values(index.items || {})) {
      if (item.ownerKey !== owner || item.dedupeKey !== dedupeKey) continue;
      const task = readJson(this.taskFile(item.id), null);
      if (task) return task;
    }
    return null;
  }

  task(id) {
    return readJson(this.taskFile(id), null);
  }

  saveTask(task) {
    return withLock(this.tasks, 'index', null, async () => {
      const index = readJson(this.taskIndexFile(), { version: 1, items: {} });
      if (!index.items || !index.items[task.id]) throw new Error('任务索引里没有这个任务');
      task.updatedAt = Date.now();
      atomicJson(this.taskFile(task.id), task);
      index.items[task.id] = {
        ...index.items[task.id],
        status: task.status,
        updatedAt: task.updatedAt,
      };
      atomicJson(this.taskIndexFile(), index);
      return task;
    });
  }

  tasksFor(owner) {
    const index = readJson(this.taskIndexFile(), { version: 1, items: {} });
    return Object.values(index.items || {})
      .filter((item) => item.ownerKey === owner)
      .map((item) => readJson(this.taskFile(item.id), null))
      .filter(Boolean);
  }

  recoverInterrupted() {
    const index = readJson(this.taskIndexFile(), { version: 1, items: {} });
    for (const item of Object.values(index.items || {})) {
      const task = readJson(this.taskFile(item.id), null);
      if (!task || task.status !== 'running') continue;
      task.status = 'interrupted';
      task.error = '宿主重启时任务正在执行；已完成章节和音频分段已保留，可重试';
      task.updatedAt = Date.now();
      atomicJson(this.taskFile(task.id), task);
      index.items[item.id].status = 'interrupted';
      index.items[item.id].updatedAt = task.updatedAt;
    }
    atomicJson(this.taskIndexFile(), index);
  }

  queuedTasks() {
    const index = readJson(this.taskIndexFile(), { version: 1, items: {} });
    return Object.values(index.items || {})
      .filter((item) => item.status === 'queued')
      .sort((a, b) => Number(a.createdAt) - Number(b.createdAt))
      .map((item) => readJson(this.taskFile(item.id), null))
      .filter(Boolean);
  }

  stats() {
    const index = readJson(this.taskIndexFile(), { version: 1, items: {} });
    const counts = {};
    for (const item of Object.values(index.items || {})) {
      counts[item.status] = (counts[item.status] || 0) + 1;
    }
    let owners = 0;
    try { owners = readdirSync(this.owners).filter((name) => /^[a-f0-9]{64}$/.test(name)).length; } catch {}
    return { owners, tasks: Object.keys(index.items || {}).length, counts };
  }
}
