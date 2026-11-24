import { clip, multilineClip, safeName } from './util.mjs';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export function charCount(value) {
  return Array.from(String(value ?? '').replace(/\s/g, '')).length;
}

export function chapterRange(book, spec = '最新') {
  const chapters = (book?.chapters || []).slice().sort((a, b) => a.no - b.no);
  if (!chapters.length) throw new Error('这本书还没有章节');
  const value = String(spec ?? '').trim() || '最新';
  if (value === '最新') return [chapters.at(-1).no];
  if (value === '全本') return chapters.map((item) => item.no);
  const range = /^(\d+)\s*[-–—~至]\s*(\d+)$/.exec(value);
  if (range) {
    const start = Math.max(1, Math.min(Number(range[1]), Number(range[2])));
    const end = Math.max(Number(range[1]), Number(range[2]));
    const selected = chapters.filter((item) => item.no >= start && item.no <= end).map((item) => item.no);
    if (!selected.length) throw new Error('这个范围内没有章节');
    return selected;
  }
  const no = Number.parseInt(value, 10);
  if (Number.isInteger(no) && chapters.some((item) => item.no === no)) return [no];
  throw new Error('章节范围只支持：最新、章号、起止范围、全本');
}

export function readingTxt(book, rows) {
  const title = clip(book.title || '未命名小说', 120);
  const body = (rows || [])
    .slice()
    .sort((a, b) => a.chapterNo - b.chapterNo)
    .map((row) => `${row.title}\n\n${row.body.replace(/\r\n?/g, '\n').trim()}`)
    .join('\n\n');
  const normalized = `${title}\n\n${body}\n`.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n');
  return Buffer.concat([BOM, Buffer.from(normalized, 'utf8')]);
}

export function txtFileName(book, rows, suffix = '') {
  const numbers = rows.map((row) => row.chapterNo);
  const range = numbers.length === 1
    ? `第${numbers[0]}章`
    : `第${Math.min(...numbers)}-${Math.max(...numbers)}章`;
  return `${safeName(book.title, '小说')}-${range}${suffix ? `-${safeName(suffix, '')}` : ''}.txt`;
}

export function parseImportedTxt(buffer, fileName = '') {
  let value = Buffer.from(buffer || []);
  if (value.length >= 3 && value[0] === 0xef && value[1] === 0xbb && value[2] === 0xbf) {
    value = value.subarray(3);
  }
  const text = value.toString('utf8').replace(/\r\n?/g, '\n').trim();
  if (!text) throw new Error('导入文件是空的');
  if (text.includes('\ufffd')) throw new Error('TXT 不是有效 UTF-8，请另存为 UTF-8 后重试');
  const lines = text.split('\n');
  const chapters = [];
  let bookTitle = safeName(String(fileName).replace(/\.[^.]+$/, ''), '导入小说');
  let current = null;
  const heading = /^\s*(?:第[0-9一二三四五六七八九十百千万零〇两]+章|Chapter\s+\d+)[^\n]{0,80}\s*$/i;
  for (const line of lines) {
    if (heading.test(line)) {
      if (current) chapters.push(current);
      current = { title: line.trim(), body: [] };
      continue;
    }
    if (!current) {
      if (!chapters.length && line.trim() && line.trim() === lines.find((item) => item.trim())?.trim()) {
        bookTitle = safeName(line, bookTitle);
      }
      continue;
    }
    current.body.push(line);
  }
  if (current) chapters.push(current);
  if (!chapters.length) {
    chapters.push({ title: '正文', body: lines });
  }
  const normalized = chapters.map((item, index) => ({
    no: index + 1,
    title: clip(item.title || `第${index + 1}章`, 120),
    body: multilineClip(item.body.join('\n'), 2_000_000),
    chars: charCount(item.body.join('\n')),
  })).filter((item) => item.body);
  if (!normalized.length) throw new Error('没有识别到可导入的正文');
  return {
    title: clip(bookTitle, 80) || '导入小说',
    chapters: normalized,
    chars: normalized.reduce((sum, item) => sum + item.chars, 0),
  };
}

export function backupJson(book, versions, now = Date.now()) {
  return Buffer.from(`${JSON.stringify({
    format: 'roost-novel-backup',
    version: 1,
    exportedAt: new Date(now).toISOString(),
    book: {
      title: book.title,
      settings: book.settings,
      people: book.people,
      outline: book.outline,
      autoRead: book.autoRead === true,
      voice: book.voice,
      chapters: versions,
    },
  }, null, 2)}\n`, 'utf8');
}

export function parseBackup(buffer) {
  const value = JSON.parse(Buffer.from(buffer || []).toString('utf8').replace(/^\uFEFF/, ''));
  if (!value || value.format !== 'roost-novel-backup' || value.version !== 1 || !value.book) {
    throw new Error('这不是受支持的小说备份文件');
  }
  const title = clip(value.book.title, 80);
  const chapters = (Array.isArray(value.book.chapters) ? value.book.chapters : [])
    .map((item) => ({
      no: Number(item.chapterNo),
      title: clip(item.title, 120),
      body: multilineClip(item.body, 2_000_000),
      summary: clip(item.summary, 2500),
      states: Array.isArray(item.states) ? item.states.map((state) => clip(state, 500)).filter(Boolean).slice(0, 100) : [],
    }))
    .filter((item) => Number.isInteger(item.no) && item.no > 0 && item.title && item.body)
    .sort((a, b) => a.no - b.no);
  if (!title || !chapters.length) throw new Error('备份缺少书名或章节正文');
  return {
    title,
    settings: value.book.settings && typeof value.book.settings === 'object' ? value.book.settings : {},
    people: Array.isArray(value.book.people) ? value.book.people.slice(0, 200) : [],
    outline: Array.isArray(value.book.outline) ? value.book.outline.slice(0, 1000) : [],
    autoRead: value.book.autoRead === true,
    voice: value.book.voice && typeof value.book.voice === 'object' ? value.book.voice : {},
    chapters,
  };
}
