import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createService } from '../lib/service.mjs';

function wav(samples = 2400, rate = 24000, channels = 1) {
  const data = Buffer.alloc(samples * channels * 2);
  const out = Buffer.alloc(44 + data.length);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + data.length, 4);
  out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * channels * 2, 28);
  out.writeUInt16LE(channels * 2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(data.length, 40);
  data.copy(out, 44);
  return out;
}

test('long-form adapter returns raw complete WAV without short-speech markers', async () => {
  const calls = [];
  const fake = {
    async weights(values, signal) {
      signal.throwIfAborted();
      calls.push(['weights', values.textLang]);
    },
    async wav(values, speech, signal) {
      signal.throwIfAborted();
      calls.push(['wav', values.textLang, speech.text]);
      return wav(Math.max(240, Array.from(speech.text).length * 240));
    },
    async probe() { return { ok: true }; },
  };
  const service = createService({
    dir: mkdtempSync(join(tmpdir(), 'voice-longform-')),
    clientFactory: () => fake,
    getConfig: () => ({}),
  });
  const text = '第一段。'.repeat(30);
  const values = {
    enabled: true, api: 'http://127.0.0.1:9880', refAudio: 'ref.wav', promptText: '提示',
    promptLang: 'zh', sovitsWeights: 's.wav', gptWeights: 'g.ckpt', textLang: 'zh',
    speed: 1, textSplitMethod: 'cut5', fragmentInterval: 0.3, topK: 15, topP: 1,
    temperature: 1, freeze: false, serviceDir: '', maxChars: 60, cooldownSec: 3,
    timeoutSec: 60, replyNote: false, keywords: '', lines: [], translateApi: '',
    translateModel: 'gpt-4o-mini',
  };
  const out = await service.runLongForm(text, values);
  assert.equal(calls[1][2], text);
  assert.ok(out.bytes > 44);
  assert.equal(out.contentType, 'audio/wav');
  assert.equal('marker' in out, false);
  assert.equal('reply' in out, false);
});
