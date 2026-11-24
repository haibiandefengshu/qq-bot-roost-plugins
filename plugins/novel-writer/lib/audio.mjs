import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  atomicBytes, atomicJson, clip, multilineClip, readJson, safeName, shortId,
} from './util.mjs';

export const MAX_CHAPTER_AUDIO = 16 * 1024 * 1024;

function sentencePieces(paragraph) {
  const text = String(paragraph);
  const parts = [];
  let buffer = '';
  for (const char of text) {
    buffer += char;
    if (/[。！？!?…；;]/u.test(char)) {
      parts.push(buffer);
      buffer = '';
    }
  }
  if (buffer) parts.push(buffer);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** Split on paragraph and sentence boundaries while preserving every non-whitespace character. */
export function splitForSpeech(input, maxChars = 200) {
  const text = multilineClip(input, 200_000);
  const limit = Math.max(20, Math.min(2000, Number(maxChars) || 200));
  const out = [];
  let cursor = 0;
  for (const paragraph of text.split(/\n+/)) {
    const source = paragraph.trim();
    if (!source) continue;
    let buffer = '';
    for (const piece of sentencePieces(source)) {
      if (Array.from(piece).length > limit) {
        if (buffer) { out.push({ text: buffer, start: cursor, end: cursor + buffer.length }); cursor += buffer.length + 1; buffer = ''; }
        let rest = piece;
        while (Array.from(rest).length > limit) {
          const chars = Array.from(rest);
          let cut = limit;
          for (let i = limit; i > Math.floor(limit * 0.6); i -= 1) {
            if (/[，,、：:]/u.test(chars[i - 1] || '')) { cut = i; break; }
          }
          const chunk = chars.slice(0, cut).join('');
          out.push({ text: chunk, start: cursor, end: cursor + chunk.length });
          cursor += chunk.length;
          rest = chars.slice(cut).join('');
        }
        buffer = rest;
        continue;
      }
      const next = buffer ? `${buffer}${piece}` : piece;
      if (Array.from(next).length > limit && buffer) {
        out.push({ text: buffer, start: cursor, end: cursor + buffer.length });
        cursor += buffer.length + 1;
        buffer = piece;
      } else {
        buffer = next;
      }
    }
    if (buffer) {
      out.push({ text: buffer, start: cursor, end: cursor + buffer.length });
      cursor += buffer.length + 1;
    }
  }
  if (!out.length) throw new Error('正文没有可朗读内容');
  return out.map((item, index) => ({ ...item, index }));
}

function ffmpeg(bin, args, { signal } = {}) {
  return new Promise((resolvePromise, reject) => {
    let stderr = '';
    const child = spawn(String(bin), args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener?.('abort', abort, { once: true });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    child.on('error', (error) => {
      signal?.removeEventListener?.('abort', abort);
      reject(new Error(`FFmpeg 启动失败：${error.message}`));
    });
    child.on('exit', (code, signalName) => {
      signal?.removeEventListener?.('abort', abort);
      if (signal?.aborted) return reject(Object.assign(new Error('朗读任务已取消'), { name: 'AbortError' }));
      if (code === 0) return resolvePromise();
      const safe = stderr
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .slice(-3)
        .join('；')
        .replace(/[A-Za-z]:\\[^\s；]+/g, '本地路径')
        .slice(0, 280);
      reject(new Error(`FFmpeg 处理失败${signalName ? `（${signalName}）` : ''}${safe ? `：${safe}` : ''}`));
    });
  });
}

function concatFile(file, rows) {
  const body = rows.map((row) => `file '${row.replace(/'/g, "'\\''")}'`).join('\n');
  writeFileSync(file, `${body}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function encode(bin, rows, listFile, output, signal) {
  concatFile(listFile, rows);
  await ffmpeg(bin, [
    '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', '96k', output,
  ], { signal });
  if (!statSync(output).isFile() || statSync(output).size < 128) throw new Error('合并后的 MP3 为空');
  await ffmpeg(bin, ['-v', 'error', '-i', output, '-f', 'null', '-'], { signal });
  return statSync(output).size;
}

export async function synthesizeChapter({
  chapterNo,
  text,
  voice,
  workDir,
  outputDir = workDir,
  ffmpegBinary,
  runtime,
  taskId,
  signal,
  checkCancelled = () => {},
  progress = () => {},
}) {
  if (!ffmpegBinary) throw new Error('缺少 FFmpeg 依赖，TXT 仍可用；请在小说面板安装共享 FFmpeg 后重试');
  if (!runtime?.voice?.synthesizeSegment) throw new Error('宿主没有提供语音分段合成能力');
  if (!runtime?.artifacts?.register) throw new Error('宿主没有提供成果登记能力');
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const stateFile = join(workDir, 'state.json');
  const state = readJson(stateFile, {
    version: 1, chapterNo, taskId, segments: [], normalized: [], outputs: [],
  });
  if (!Array.isArray(state.segments)) state.segments = [];
  if (!Array.isArray(state.normalized)) state.normalized = [];
  const pieces = splitForSpeech(text, voice.chunkChars);
  const normalized = [];
  for (const piece of pieces) {
    checkCancelled();
    const base = join(workDir, `segment-${String(piece.index + 1).padStart(4, '0')}`);
    const saved = state.segments.find((item) => item.index === piece.index && item.text === piece.text);
    let source = saved?.path;
    if (!source || !statSync(source).isFile()) {
      const result = await runtime.voice.synthesizeSegment(piece.text, voice, { signal });
      const bytes = Buffer.from(result?.audio || []);
      if (!bytes.length) throw new Error(`第 ${piece.index + 1} 段语音为空`);
      const ext = /\bwav\b/i.test(result?.contentType || '') ? '.wav' : '.audio';
      source = `${base}${ext}`;
      atomicBytes(source, bytes);
      state.segments = state.segments.filter((item) => item.index !== piece.index);
      state.segments.push({ index: piece.index, text: piece.text, path: source, bytes: bytes.length, at: Date.now() });
      atomicJson(stateFile, state);
    }
    checkCancelled();
    const normalizedPath = `${base}.pcm.wav`;
    const existing = state.normalized.find((item) => item.index === piece.index && item.path === normalizedPath);
    if (!existing || !statSync(normalizedPath).isFile()) {
      await ffmpeg(ffmpegBinary, [
        '-y', '-v', 'error', '-i', source, '-vn', '-ac', '1', '-ar', '24000',
        '-c:a', 'pcm_s16le', normalizedPath,
      ], { signal });
      state.normalized = state.normalized.filter((item) => item.index !== piece.index);
      state.normalized.push({ index: piece.index, path: normalizedPath, bytes: statSync(normalizedPath).size });
      atomicJson(stateFile, state);
    }
    normalized.push(normalizedPath);
    progress(piece.index + 1, pieces.length);
  }

  const baseName = `${safeName(`第${chapterNo}章-${taskId}`, `chapter-${chapterNo}`)}`;
  const outputBase = join(outputDir, `${shortId('audio')}-${baseName}`);
  const full = `${outputBase}.mp3`;
  const listFile = join(workDir, 'concat.txt');
  checkCancelled();
  const fullBytes = await encode(ffmpegBinary, normalized, listFile, full, signal);
  checkCancelled();
  const outputs = [];
  const rows = [];
  if (fullBytes <= MAX_CHAPTER_AUDIO) {
    rows.push({ path: full, bytes: fullBytes });
  } else {
    let group = [];
    let bytes = 0;
    for (const path of normalized) {
      const size = statSync(path).size;
      if (group.length && bytes + size > MAX_CHAPTER_AUDIO * 4.1) {
        const output = `${outputBase}-part-${rows.length + 1}.mp3`;
        checkCancelled();
        const outputBytes = await encode(ffmpegBinary, group, `${listFile}.${rows.length + 1}`, output, signal);
        checkCancelled();
        rows.push({ path: output, bytes: outputBytes });
        group = [];
        bytes = 0;
      }
      group.push(path);
      bytes += size;
    }
    if (group.length) {
      const output = `${outputBase}-part-${rows.length + 1}.mp3`;
      checkCancelled();
      const outputBytes = await encode(ffmpegBinary, group, `${listFile}.${rows.length + 1}`, output, signal);
      checkCancelled();
      rows.push({ path: output, bytes: outputBytes });
    }
  }
  return rows.map((row, index) => ({
    ...row,
    part: index + 1,
    parts: rows.length,
    fileName: `${safeName(`第${chapterNo}章`, `第${chapterNo}章`)}${rows.length > 1 ? `-${index + 1}` : ''}.mp3`,
  }));
}
