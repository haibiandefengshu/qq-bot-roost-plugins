// Optional integration smoke: uses only already installed Roost voice dependencies.
// Run: node --test plugins/media-parser/test/voice-runtime.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { loadVoiceRuntime, prepareAudio } from '../voice.js';
import { validateLocalFile } from '../files.js';

const frameworkRoot = process.env.ROOST_TEST_ROOT || path.join(os.homedir(), '.dsh', 'dsh-roost', 'roost');
const runtime = await loadVoiceRuntime({ frameworkRoot });

function tone(seconds) {
  const rate = 24000;
  const samples = Math.floor(seconds * rate);
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let sample = 0; sample < samples; sample += 1) {
    bytes.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * 440 * sample / rate)), 44 + sample * 2);
  }
  return bytes;
}

test('本机已装 silk-wasm：真实短 WAV 经 Roost helper 编码后可解码且具有音量', async (t) => {
  if (!runtime.available) return t.skip(runtime.reason || '本机未安装可选编码依赖，不会自动安装');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'media-voice-runtime-'));
  t.after(async () => { await fs.rm(directory, { recursive: true, force: true }); });
  const filename = path.join(directory, 'two-seconds.wav');
  await fs.writeFile(filename, tone(2));
  const file = await validateLocalFile(filename, { cacheRoot: directory });
  const prepared = await prepareAudio(file, { ctx: { dataDir: directory }, runtime });
  assert.equal(prepared.type, 'voice');
  const bytes = await fs.readFile(prepared.file.path);
  assert.equal(runtime.silk.isSilk(bytes), true);
  const duration = Number(runtime.silk.getDuration(bytes));
  assert.ok(duration >= 1950 && duration <= 2100);
  const decoded = await runtime.silk.decode(bytes, 24000);
  const pcm = Buffer.from(decoded?.data ?? decoded);
  let energy = 0;
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) energy += pcm.readInt16LE(offset) ** 2;
  const rms = Math.sqrt(energy / (pcm.length / 2));
  assert.ok(rms > 100, `实际解码音量过低：${rms}`);
  t.diagnostic(`实际 SILK ${bytes.length} 字节，${duration}ms，解码 RMS ${Math.round(rms)}；未上传或发送`);
});

test('本机长音频实测：61 秒 WAV 保留完整原文件，不进入框架截断路径', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'media-long-runtime-'));
  t.after(async () => { await fs.rm(directory, { recursive: true, force: true }); });
  const filename = path.join(directory, 'sixty-one-seconds.wav');
  const bytes = tone(61);
  await fs.writeFile(filename, bytes);
  const before = createHash('sha256').update(bytes).digest('hex');
  const file = await validateLocalFile(filename, { cacheRoot: directory });
  const prepared = await prepareAudio(file, { ctx: { dataDir: directory }, runtime });
  assert.equal(prepared.type, 'file');
  assert.equal(prepared.file.path, file.path);
  const after = createHash('sha256').update(await fs.readFile(prepared.file.path)).digest('hex');
  assert.equal(after, before);
  assert.equal(prepared.seconds, 61);
  t.diagnostic(`完整 WAV ${bytes.length} 字节，61 秒，SHA-256 一致；未上传或发送`);
});
