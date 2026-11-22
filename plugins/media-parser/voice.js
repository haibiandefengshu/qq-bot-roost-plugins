import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  assertActive, mediaWorkDir, validateLocalFile, MediaFileError,
} from './files.js';

export const MAX_VOICE_SEC = 60;
export const MAX_VOICE_BYTES = 20 * 1048576;
const runtimeCache = new Map();
const INPUT_RESTRICTIONS = [
  '-protocol_whitelist', 'file,pipe',
  '-format_whitelist', 'mov,matroska,webm,mp3,wav,ogg,flac,aac,amr',
];

function ancestors(start) {
  const found = [];
  let current = path.resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    found.push(current);
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }
  return found;
}

/** Locate the installation from the running entry point or the installed plugin. */
export async function findFrameworkRoot(explicitRoot) {
  const candidates = explicitRoot ? [path.resolve(explicitRoot)] : [
    ...ancestors(path.dirname(process.argv[1] || process.cwd())),
    ...ancestors(path.dirname(fileURLToPath(import.meta.url))),
    ...ancestors(process.cwd()),
  ];
  for (const candidate of [...new Set(candidates)]) {
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(candidate, 'package.json'), 'utf8'));
      if (metadata.name !== 'qq-bot-roost') continue;
      const helper = await fs.stat(path.join(candidate, 'src', 'onebot', 'voice.js'));
      if (helper.isFile()) return candidate;
    } catch { /* the next ancestor may be the actual installation */ }
  }
  return '';
}

/** This is the only module that knows Roost's internal compatibility paths. */
export async function loadVoiceRuntime({ frameworkRoot } = {}) {
  const root = await findFrameworkRoot(frameworkRoot);
  if (!root) return { available: false, reason: '未找到框架语音转换接口' };
  if (runtimeCache.has(root)) return runtimeCache.get(root);
  try {
    const voice = await import(pathToFileURL(path.join(root, 'src', 'onebot', 'voice.js')).href);
    const deps = await import(pathToFileURL(path.join(root, 'src', 'ext-deps.js')).href);
    if (typeof voice.toSilk !== 'function' || typeof voice.findFfmpeg !== 'function'
      || typeof deps.load !== 'function') {
      return { available: false, reason: '当前框架语音转换接口不兼容' };
    }
    // Never call ensureSilk/ensureFfmpeg: parsing must not install runtime packages.
    const silk = deps.cached?.('silk-wasm') || await deps.load('silk-wasm');
    if (!silk || typeof silk.isSilk !== 'function' || typeof silk.getDuration !== 'function') {
      return { available: false, reason: '语音编码依赖不可用' };
    }
    const runtime = {
      available: true, root, voice, silk,
      maxSeconds: Math.min(MAX_VOICE_SEC, Number(voice.MAX_VOICE_SEC) || MAX_VOICE_SEC),
      maxBytes: Math.min(MAX_VOICE_BYTES, Number(voice.MAX_VOICE_BYTES) || MAX_VOICE_BYTES),
    };
    runtimeCache.set(root, runtime);
    return runtime;
  } catch {
    return { available: false, reason: '框架语音转换接口不可用' };
  }
}

export function wavDuration(buffer) {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF'
    || buffer.toString('ascii', 8, 12) !== 'WAVE') return 0;
  let bytesPerSecond = 0;
  let dataBytes = 0;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (size > buffer.length - start) return 0;
    const id = buffer.toString('ascii', offset, offset + 4);
    if (id === 'fmt ' && size >= 16) bytesPerSecond = buffer.readUInt32LE(start + 8);
    if (id === 'data') dataBytes += size;
    offset = start + size + (size & 1);
  }
  return bytesPerSecond > 0 && dataBytes > 0 ? dataBytes / bytesPerSecond : 0;
}

/**
 * Decode once to measure the complete compressed input. The framework's toSilk
 * truncates unknown/long inputs to 60s, so it must only receive verified short audio.
 */
export function probeAudioDuration(filename, ffmpeg, {
  signal, deadlineAt, isActive, spawnProcess = spawn, maxSeconds = MAX_VOICE_SEC,
} = {}) {
  assertActive({ signal, deadlineAt, isActive });
  return new Promise((resolve, reject) => {
    const child = spawnProcess(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', ...INPUT_RESTRICTIONS, '-i', filename,
      '-map', '0:a:0', '-vn', '-sn', '-dn', '-progress', 'pipe:1', '-nostats', '-f', 'null', '-',
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let seconds = 0;
    let remainder = '';
    let finished = false;
    let stderrLength = 0;
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(activeTimer);
      signal?.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve(value);
    };
    const stop = () => { try { child.kill(); } catch {} };
    const cancel = () => { stop(); finish(new MediaFileError('cancelled', '音频检查已取消')); };
    const timer = setTimeout(() => {
      stop();
      finish(new MediaFileError('timeout', '音频检查超过总时限'));
    }, Math.max(1, Math.min(30_000, Number.isFinite(deadlineAt) ? deadlineAt - Date.now() : 30_000)));
    const activeTimer = setInterval(() => {
      try { assertActive({ signal, deadlineAt, isActive }); } catch (error) { stop(); finish(error); }
    }, 100);
    activeTimer.unref?.();
    signal?.addEventListener('abort', cancel, { once: true });
    child.stdout?.on('data', (chunk) => {
      remainder = (remainder + chunk.toString()).slice(-4096);
      const lines = remainder.split(/\r?\n/);
      remainder = lines.pop() || '';
      for (const line of lines) {
        const match = /^out_time_us=(\d+)$/.exec(line);
        if (match) seconds = Math.max(seconds, Number(match[1]) / 1_000_000);
      }
      if (seconds > maxSeconds) { stop(); finish(null, seconds); }
    });
    child.stderr?.on('data', (chunk) => { stderrLength += chunk.length; if (stderrLength > 65536) stop(); });
    child.on('error', () => finish(new MediaFileError('audio-probe', '音频时长检查不可用')));
    child.on('exit', (code) => {
      if (code === 0 && seconds > 0) finish(null, seconds);
      else finish(new MediaFileError('audio-probe', '无法确认完整音频时长'));
    });
  });
}

/** Transcode only formats already accepted by the restricted full-duration probe. */
export async function transcodeCanonicalWav(filename, ffmpeg, {
  ctx, signal, deadlineAt, isActive, spawnProcess = spawn,
} = {}) {
  const active = { signal, deadlineAt, isActive };
  assertActive(active);
  const directory = await mediaWorkDir(ctx?.dataDir);
  const output = path.join(directory, `${randomUUID()}.wav`);
  // Reserve the task's own destination; no engine-provided filename becomes output.
  const handle = await fs.open(output, 'wx', 0o600);
  await handle.close();
  try {
    await new Promise((resolve, reject) => {
      const child = spawnProcess(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-nostdin', ...INPUT_RESTRICTIONS, '-i', filename,
        '-map', '0:a:0', '-vn', '-sn', '-dn', '-f', 'wav', '-ar', '24000', '-ac', '1',
        '-c:a', 'pcm_s16le', '-fs', String(MAX_VOICE_BYTES + 1), '-y', output,
      ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let finished = false;
      let stderrLength = 0;
      const finish = (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearInterval(activeTimer);
        signal?.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve();
      };
      const stop = () => { try { child.kill(); } catch {} };
      const cancel = () => { finish(new MediaFileError('cancelled', '音频转换已取消')); stop(); };
      const timer = setTimeout(() => {
        finish(new MediaFileError('timeout', '音频转换超过总时限'));
        stop();
      }, Math.max(1, Math.min(30_000, Number.isFinite(deadlineAt) ? deadlineAt - Date.now() : 30_000)));
      const activeTimer = setInterval(() => {
        try { assertActive(active); } catch (error) { finish(error); stop(); }
      }, 100);
      activeTimer.unref?.();
      signal?.addEventListener('abort', cancel, { once: true });
      child.stderr?.on('data', (chunk) => {
        stderrLength += chunk.length;
        if (stderrLength > 65536) {
          finish(new MediaFileError('audio-convert', '音频转换输出异常'));
          stop();
        }
      });
      child.on('error', () => finish(new MediaFileError('audio-convert', '音频转换程序不可用')));
      child.on('exit', (code) => finish(code === 0 ? null : new MediaFileError('audio-convert', '音频未能安全转换')));
    });
    assertActive(active);
    const record = await validateLocalFile(output, { cacheRoot: directory, maxBytes: MAX_VOICE_BYTES, ...active });
    return await fs.readFile(record.path);
  } finally { await fs.rm(output, { force: true }).catch(() => {}); }
}

export async function prepareAudio(file, {
  ctx, config = {}, frameworkRoot, runtime: providedRuntime, signal, deadlineAt, isActive,
  spawnProcess = spawn,
} = {}) {
  const active = { signal, deadlineAt, isActive };
  assertActive(active);
  const fallback = (reason, seconds = 0) => ({
    type: 'file', file, seconds, reason: `${reason}，以完整音频文件发送`,
  });
  if (config.audioMode === 'file') return { type: 'file', file, reason: '', seconds: 0 };
  if (file.size > MAX_VOICE_BYTES) return fallback('音频超过语音体积限制');
  let source = await fs.readFile(file.path);
  assertActive(active);
  const wavSeconds = wavDuration(source);
  if (wavSeconds > MAX_VOICE_SEC) return fallback(`音频超过 ${MAX_VOICE_SEC} 秒语音限制`, wavSeconds);
  const runtime = providedRuntime ?? await loadVoiceRuntime({ frameworkRoot });
  assertActive(active);
  if (!runtime.available) return fallback(runtime.reason || '语音转换不可用');
  const { voice, silk } = runtime;
  const limit = Math.min(MAX_VOICE_SEC, runtime.maxSeconds || MAX_VOICE_SEC);
  const sizeLimit = Math.min(MAX_VOICE_BYTES, runtime.maxBytes || MAX_VOICE_BYTES);
  if (file.size > sizeLimit) return fallback('音频超过语音体积限制');
  let seconds = wavSeconds;
  let generatedFile = '';
  try {
    if (silk.isSilk(source)) seconds = Number(silk.getDuration(source)) / 1000;
    const info = silk.isWav?.(source) ? silk.getWavFileInfo?.(source)?.fmt : null;
    const direct = info && Number(info.sampleRate) === 24000
      && Number(info.numberOfChannels) === 1 && Number(info.bitsPerSample) === 16;
    if (!silk.isSilk(source) && (!direct || !seconds)) {
      const ffmpeg = String(config.ffmpegPath || '').trim() || await voice.findFfmpeg();
      assertActive(active);
      if (!ffmpeg) return fallback('音频转换依赖不可用');
      // HLS/concat/playlists cannot use ffmpeg as an unrestricted URL fetcher.
      seconds = await probeAudioDuration(file.path, ffmpeg, { ...active, maxSeconds: limit, spawnProcess });
      if (seconds > limit) return fallback(`音频超过 ${limit} 秒语音限制`, seconds);
      source = await transcodeCanonicalWav(file.path, ffmpeg, { ctx, ...active, spawnProcess });
      const canonical = silk.isWav?.(source) ? silk.getWavFileInfo?.(source)?.fmt : null;
      if (!canonical || Number(canonical.sampleRate) !== 24000 || Number(canonical.numberOfChannels) !== 1
        || Number(canonical.bitsPerSample) !== 16 || !wavDuration(source)
        || wavDuration(source) + 0.15 < seconds) return fallback('音频转换结果未通过完整性检查', seconds);
    }
    assertActive(active);
    if (!Number.isFinite(seconds) || seconds <= 0) return fallback('无法确认完整音频时长');
    if (seconds > limit) return fallback(`音频超过 ${limit} 秒语音限制`, seconds);
    // Pass an already loaded encoder, avoiding the helper's dependency installer.
    const converted = await voice.toSilk(source, silk);
    assertActive(active);
    const bytes = converted?.silk;
    const convertedSeconds = Buffer.isBuffer(bytes) ? Number(silk.getDuration(bytes)) / 1000 : 0;
    if (!Buffer.isBuffer(bytes) || !bytes.length || !silk.isSilk(bytes)
      || bytes.length > sizeLimit || !convertedSeconds || convertedSeconds > limit
      || convertedSeconds + 0.15 < seconds) return fallback('语音编码结果未通过完整性检查', seconds);
    const directory = await mediaWorkDir(ctx?.dataDir);
    const filename = path.join(directory, `${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}-${randomUUID()}.silk`);
    generatedFile = filename;
    await fs.writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
    const validated = await validateLocalFile(filename, { cacheRoot: directory, maxBytes: sizeLimit, ...active });
    return { type: 'voice', file: { ...validated, owned: true }, seconds: convertedSeconds, reason: '' };
  } catch (error) {
    if (generatedFile) await fs.rm(generatedFile, { force: true }).catch(() => {});
    if (error?.code === 'cancelled' || error?.code === 'timeout') throw error;
    return fallback('音频未能转换成有效语音', seconds);
  }
}
