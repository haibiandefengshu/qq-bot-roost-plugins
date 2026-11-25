import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeQr, qrToPng, qrToPngDataUrl, qrToSvg } from '../bili-qr.js';

const KEY = ['a1b2', 'c3d4', 'e5f6', '0718', '293a', '4b5c', '6d7e', '8f90'].join('');
const SAMPLE = `https://passport.bilibili.com/h5-app/passport/login/scan?navhide=1&qrcode_key=${KEY}&from=`;

test('QR encoder produces a stable bit matrix and PNG data URL', () => {
  const first = encodeQr(SAMPLE, { ec: 'L' });
  const second = encodeQr(SAMPLE, { ec: 'L' });
  assert.equal(first.size, 17 + 4 * first.version);
  assert.deepEqual(first.modules, second.modules);
  assert.equal(first.modules.length, first.size);
  assert.equal(first.modules[0][0], true);
  assert.equal(first.modules[0][first.size - 1], true);
  assert.equal(first.modules[first.size - 1][0], true);
  assert.match(qrToSvg(first), /^<svg xmlns=/);
  const png = qrToPng(first, { scale: 4, margin: 2 });
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(png.length > 100);
  const dataUrl = qrToPngDataUrl(SAMPLE);
  assert.match(dataUrl, /^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
  assert.ok(dataUrl.length > 200);
});

test('QR encoder rejects empty input and out-of-range payloads', () => {
  assert.throws(() => encodeQr(''), /内容为空/);
  assert.throws(() => encodeQr('x'.repeat(300)), /内容太长/);
});
