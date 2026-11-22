import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import {
  prepareAudio, wavDuration, findFrameworkRoot, loadVoiceRuntime, probeAudioDuration,
} from '../voice.js';
import { validateLocalFile, removeOwnedFile } from '../files.js';

function wav(seconds, rate = 24000) {
  const bytes = Math.round(seconds * rate * 2);
  const buffer = Buffer.alloc(44 + bytes);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVE', 8);
  buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(bytes, 40);
  for (let offset = 44; offset < buffer.length; offset += 2) buffer.writeInt16LE(offset % 8 ? 700 : -700, offset);
  return buffer;
}

function silkBuffer(milliseconds) {
  const buffer = Buffer.alloc(16);
  buffer.write('#!SILK_V3', 0); buffer.writeUInt32LE(Math.round(milliseconds), 10);
  return buffer;
}

const codec = {
  isSilk: (buffer) => buffer.toString('ascii', 0, 9) === '#!SILK_V3',
  getDuration: (buffer) => buffer.readUInt32LE(10),
  isWav: (buffer) => buffer.toString('ascii', 0, 4) === 'RIFF',
  getWavFileInfo: (buffer) => ({
    fmt: { sampleRate: buffer.readUInt32LE(24), numberOfChannels: buffer.readUInt16LE(22), bitsPerSample: buffer.readUInt16LE(34), bytesPerSec: buffer.readUInt32LE(28) },
    chunkInfo: [{ chunkId: 'data', dataLength: buffer.readUInt32LE(40) }],
  }),
  encode: async (buffer) => ({ data: silkBuffer(wavDuration(buffer) * 1000) }),
  decode: async () => ({ data: Buffer.from([0, 4, 0, 4, 0, 4, 0, 4]) }),
};

async function fixture(t, bytes, name = 'audio.wav') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'media-voice-'));
  const filename = path.join(directory, name);
  await fs.writeFile(filename, bytes);
  const file = await validateLocalFile(filename, { cacheRoot: directory });
  t.after(async () => { await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, file, ctx: { dataDir: directory } };
}

test('WAV 时长来自完整数据块，不使用任意文件名或未验证元数据', () => {
  assert.equal(wavDuration(wav(1.5)), 1.5);
  const bad = wav(1);
  bad.writeUInt32LE(0xffffffff, 40);
  assert.equal(wavDuration(bad), 0);
});

test('复用本机 Roost 导出的 toSilk，短 WAV 进入有效语音记录', async (t) => {
  const root = path.join(os.homedir(), '.dsh', 'dsh-roost', 'roost');
  const voice = await import(pathToFileURL(path.join(root, 'src', 'onebot', 'voice.js')).href).catch(() => null);
  if (!voice) return t.skip('设置本机 Roost 后可验证真实转换 helper');
  const f = await fixture(t, wav(2));
  let conversions = 0;
  const runtime = {
    available: true, silk: codec,
    voice: { ...voice, toSilk: async (...args) => { conversions += 1; return voice.toSilk(...args); } },
  };
  const result = await prepareAudio(f.file, { ctx: f.ctx, runtime });
  assert.equal(conversions, 1);
  assert.equal(result.type, 'voice');
  assert.equal(result.seconds, 2);
  assert.ok(codec.isSilk(await fs.readFile(result.file.path)));
  assert.ok(result.file.path.startsWith(path.join(f.directory, 'delivery-cache')));
  await removeOwnedFile(result.file, f.directory);
});

test('超过 60 秒的 WAV 原文件完整保留，不调用可能截断的框架 helper', async (t) => {
  const bytes = wav(61);
  const f = await fixture(t, bytes);
  let conversions = 0;
  const result = await prepareAudio(f.file, {
    ctx: f.ctx, runtime: { available: true, silk: codec, voice: { toSilk() { conversions += 1; } } },
  });
  assert.equal(result.type, 'file');
  assert.equal(conversions, 0);
  assert.match(result.reason, /60 秒.*完整音频/);
  assert.deepEqual(await fs.readFile(result.file.path), bytes);
});

test('缺少编码或 ffmpeg 时回退完整音频文件，file 模式不尝试转换', async (t) => {
  const bytes = Buffer.from('compressed-music');
  const f = await fixture(t, bytes, 'song.mp3');
  for (const runtime of [
    { available: false, reason: '语音编码依赖不可用' },
    { available: true, silk: codec, voice: { findFfmpeg: async () => '' } },
  ]) {
    const result = await prepareAudio(f.file, { ctx: f.ctx, runtime });
    assert.equal(result.type, 'file');
    assert.match(result.reason, /完整音频文件/);
    assert.equal(result.file.path, f.file.path);
    assert.deepEqual(await fs.readFile(result.file.path), bytes);
  }
  const fileMode = await prepareAudio(f.file, { ctx: f.ctx, config: { audioMode: 'file' } });
  assert.equal(fileMode.type, 'file');
});

test('SILK 长于 60 秒以及编码结果发生截断时不能伪装短语音', async (t) => {
  const f = await fixture(t, silkBuffer(61000), 'long.silk');
  let conversions = 0;
  const result = await prepareAudio(f.file, {
    ctx: f.ctx, runtime: { available: true, silk: codec, voice: { toSilk() { conversions += 1; } } },
  });
  assert.equal(result.type, 'file');
  assert.equal(conversions, 0);
  const short = await fixture(t, wav(2));
  const truncated = await prepareAudio(short.file, {
    ctx: short.ctx, runtime: {
      available: true, silk: codec,
      voice: { toSilk: async () => ({ silk: silkBuffer(500) }) },
    },
  });
  assert.equal(truncated.type, 'file');
  assert.match(truncated.reason, /完整性/);
});

test('框架安装根动态定位且验证导出形状，绝不调用 ensure 安装方法', async (t) => {
  const f = await fixture(t, Buffer.from('placeholder'));
  await fs.writeFile(path.join(f.directory, 'package.json'), JSON.stringify({ name: 'qq-bot-roost', type: 'module' }));
  await fs.mkdir(path.join(f.directory, 'src', 'onebot'), { recursive: true });
  await fs.writeFile(path.join(f.directory, 'src', 'onebot', 'voice.js'), `
    export async function toSilk() { throw new Error('测试不得转码'); }
    export async function findFfmpeg() { return ''; }
  `);
  await fs.writeFile(path.join(f.directory, 'src', 'ext-deps.js'), `
    export async function load() { return null; }
    export function cached() { return null; }
    export function ensureSilk() { throw new Error('不允许安装'); }
    export function ensureFfmpeg() { throw new Error('不允许安装'); }
  `);
  assert.equal(await findFrameworkRoot(f.directory), f.directory);
  const loaded = await loadVoiceRuntime({ frameworkRoot: f.directory });
  assert.equal(loaded.available, false);
  assert.match(loaded.reason, /编码依赖/);
  const missing = await fixture(t, Buffer.from('x'));
  assert.equal(await findFrameworkRoot(missing.directory), '');
});

test('压缩音频时长检测使用隐藏、无 shell 的进程；超过 60 秒即回完整文件', async () => {
  let invocation;
  const duration = await probeAudioDuration('song.mp3', 'ffmpeg.exe', {
    spawnProcess: (command, args, options) => {
      invocation = { command, args, options };
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => { queueMicrotask(() => child.emit('exit', 1)); };
      queueMicrotask(() => child.stdout.write('out_time_us=61000000\nprogress=continue\n'));
      return child;
    },
  });
  assert.equal(duration, 61);
  assert.equal(invocation.options.windowsHide, true);
  assert.ok(!invocation.options.shell);
  assert.ok(!invocation.args.includes('-t'));
  assert.equal(invocation.args[invocation.args.indexOf('-protocol_whitelist') + 1], 'file,pipe');
  assert.equal(invocation.args[invocation.args.indexOf('-format_whitelist') + 1], 'mov,matroska,webm,mp3,wav,ogg,flac,aac,amr');
});

test('显式 ffmpegPath 用于受限探测和转码；框架 helper 只收到已确证的 PCM WAV', async (t) => {
  const f = await fixture(t, Buffer.from('compressed-audio'), 'song.mp3');
  const invocations = [];
  let helperInput;
  const result = await prepareAudio(f.file, {
    ctx: f.ctx, config: { ffmpegPath: 'C:/tools/custom-ffmpeg.exe' },
    runtime: {
      available: true, silk: codec,
      voice: {
        findFfmpeg: () => { throw new Error('显式路径不应覆盖框架进程级设置'); },
        toSilk: async (buffer) => { helperInput = buffer; return { silk: silkBuffer(1000) }; },
      },
    },
    spawnProcess: (command, args, options) => {
      invocations.push({ command, args, options });
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
      queueMicrotask(async () => {
        if (args.includes('pipe:1')) child.stdout.write('out_time_us=1000000\nprogress=end\n');
        else await fs.writeFile(args.at(-1), wav(1));
        child.emit('exit', 0);
      });
      return child;
    },
  });
  assert.equal(result.type, 'voice');
  assert.equal(invocations.length, 2);
  assert.ok(invocations.every((call) => call.command === 'C:/tools/custom-ffmpeg.exe'));
  assert.ok(invocations.every((call) => call.args[call.args.indexOf('-protocol_whitelist') + 1] === 'file,pipe'));
  assert.equal(wavDuration(helperInput), 1);
  assert.equal((await fs.readdir(path.join(f.directory, 'delivery-cache'))).filter((filename) => filename.endsWith('.wav')).length, 0);
});

test('伪音频 playlist 被受限 ffmpeg 拒绝后不会进入无约束的框架转换路径', async (t) => {
  const f = await fixture(t, Buffer.from('#EXTM3U\nhttp://169.254.169.254/latest\n'), 'fake.mp3');
  let converted = false;
  const result = await prepareAudio(f.file, {
    ctx: f.ctx, config: { ffmpegPath: 'ffmpeg.exe' },
    runtime: {
      available: true, silk: codec,
      voice: { toSilk: () => { converted = true; } },
    },
    spawnProcess: (_command, args, options) => {
      assert.equal(args[args.indexOf('-format_whitelist') + 1].includes('hls'), false);
      assert.equal(options.windowsHide, true);
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
      queueMicrotask(() => child.emit('exit', 1));
      return child;
    },
  });
  assert.equal(converted, false);
  assert.equal(result.type, 'file');
  assert.match(result.reason, /完整音频/);
});

test('转换期间取消后停止后续落盘和发送准备', async (t) => {
  const f = await fixture(t, wav(1));
  const controller = new AbortController();
  await assert.rejects(prepareAudio(f.file, {
    ctx: f.ctx, signal: controller.signal,
    runtime: {
      available: true, silk: codec,
      voice: { toSilk: async () => { controller.abort(); return { silk: silkBuffer(1000) }; } },
    },
  }), (error) => error.code === 'cancelled');
  await assert.rejects(fs.stat(path.join(f.directory, 'delivery-cache')));
});
