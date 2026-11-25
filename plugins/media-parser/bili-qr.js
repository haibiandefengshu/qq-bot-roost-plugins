/**
 * Bundled zero-dependency QR encoder (byte mode, versions 1-10) and PNG renderer.
 *
 * Adapted from the Roost `bili` plugin's local QR encoder
 * (`lib/qr-encode.mjs`, AGPL-3.0-only). Attribution and source hash are in
 * SOURCES.md. The optional shared `qrcode` dependency loader was intentionally
 * removed: the bot's QR login only needs Byte mode for a short login URL.
 */

import { deflateSync } from 'node:zlib';

const EC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

const RS_BLOCKS = {
  1: { L: [7, [[1, 19]]], M: [10, [[1, 16]]], Q: [13, [[1, 13]]], H: [17, [[1, 9]]] },
  2: { L: [10, [[1, 34]]], M: [16, [[1, 28]]], Q: [22, [[1, 22]]], H: [28, [[1, 16]]] },
  3: { L: [15, [[1, 55]]], M: [26, [[1, 44]]], Q: [18, [[2, 17]]], H: [22, [[2, 13]]] },
  4: { L: [20, [[1, 80]]], M: [18, [[2, 32]]], Q: [26, [[2, 24]]], H: [16, [[4, 9]]] },
  5: { L: [26, [[1, 108]]], M: [24, [[2, 43]]], Q: [18, [[2, 15], [2, 16]]], H: [22, [[2, 11], [2, 12]]] },
  6: { L: [18, [[2, 68]]], M: [16, [[4, 27]]], Q: [24, [[4, 19]]], H: [28, [[4, 15]]] },
  7: { L: [20, [[2, 78]]], M: [18, [[4, 31]]], Q: [18, [[2, 14], [4, 15]]], H: [26, [[4, 13], [1, 14]]] },
  8: { L: [24, [[2, 97]]], M: [22, [[2, 38], [2, 39]]], Q: [22, [[4, 18], [2, 19]]], H: [26, [[4, 14], [2, 15]]] },
  9: { L: [30, [[2, 116]]], M: [22, [[3, 36], [2, 37]]], Q: [20, [[4, 16], [4, 17]]], H: [24, [[4, 12], [4, 13]]] },
  10: { L: [18, [[2, 68], [2, 69]]], M: [26, [[4, 43], [1, 44]]], Q: [24, [[6, 19], [2, 20]]], H: [28, [[6, 15], [2, 16]]] },
};

const ALIGN = {
  1: [],
  2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);

function rsGenerator(n) {
  let poly = [1];
  for (let i = 0; i < n; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecCount) {
  const gen = rsGenerator(ecCount);
  const res = new Array(ecCount).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.shift();
    res.push(0);
    for (let i = 0; i < ecCount; i += 1) res[i] ^= gfMul(gen[i + 1], factor);
  }
  return res;
}

const MODE_BYTE = 0b0100;
const countBits = (version) => (version <= 9 ? 8 : 16);

function dataCapacity(version, ec) {
  const [, groups] = RS_BLOCKS[version][ec];
  return groups.reduce((sum, [count, words]) => sum + count * words, 0);
}

function pickVersion(byteLen, ec) {
  for (let v = 1; v <= 10; v += 1) {
    const need = 4 + countBits(v) + byteLen * 8;
    if (need <= dataCapacity(v, ec) * 8) return v;
  }
  throw new Error(`内容太长（${byteLen} 字节），这个编码器只到版本 10`);
}

function buildCodewords(bytes, version, ec) {
  const cap = dataCapacity(version, ec);
  const bits = [];
  const push = (val, len) => {
    for (let i = len - 1; i >= 0; i -= 1) bits.push((val >> i) & 1);
  };

  push(MODE_BYTE, 4);
  push(bytes.length, countBits(version));
  for (const b of bytes) push(b, 8);

  const capBits = cap * 8;
  const term = Math.min(4, capBits - bits.length);
  for (let i = 0; i < term; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j += 1) v = (v << 1) | bits[i + j];
    data.push(v);
  }
  const PAD = [0xec, 0x11];
  let k = 0;
  while (data.length < cap) {
    data.push(PAD[k % 2]);
    k += 1;
  }

  const [ecPerBlock, groups] = RS_BLOCKS[version][ec];
  const dataBlocks = [];
  const ecBlocks = [];
  let pos = 0;
  for (const [count, words] of groups) {
    for (let i = 0; i < count; i += 1) {
      const block = data.slice(pos, pos + words);
      pos += words;
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, ecPerBlock));
    }
  }

  const out = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  }
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (const b of ecBlocks) out.push(b[i]);
  }
  return out;
}

function newMatrix(size) {
  return Array.from({ length: size }, () => new Array(size).fill(false));
}

function placeFinder(m, fn, size) {
  const corners = [[0, 0], [size - 7, 0], [0, size - 7]];
  for (const [r0, c0] of corners) {
    for (let dr = -1; dr <= 7; dr += 1) {
      for (let dc = -1; dc <= 7; dc += 1) {
        const r = r0 + dr;
        const c = c0 + dc;
        if (r < 0 || c < 0 || r >= size || c >= size) continue;
        const inRing = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6
          && (dr === 0 || dr === 6 || dc === 0 || dc === 6);
        const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        m[r][c] = inRing || inCore;
        fn[r][c] = true;
      }
    }
  }
}

function placeTiming(m, fn, size) {
  for (let i = 8; i < size - 8; i += 1) {
    const on = i % 2 === 0;
    if (!fn[6][i]) { m[6][i] = on; fn[6][i] = true; }
    if (!fn[i][6]) { m[i][6] = on; fn[i][6] = true; }
  }
}

function placeAlign(m, fn, version, size) {
  const centers = ALIGN[version] || [];
  for (const r of centers) {
    for (const c of centers) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const on = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          m[r + dr][c + dc] = on;
          fn[r + dr][c + dc] = true;
        }
      }
    }
  }
}

function reserveFormat(fn, size) {
  for (let i = 0; i < 9; i += 1) {
    if (i !== 6) fn[8][i] = true;
    fn[i][8] = true;
  }
  for (let i = 0; i < 8; i += 1) {
    fn[8][size - 1 - i] = true;
    fn[size - 1 - i][8] = true;
  }
  fn[size - 8][8] = true;
}

function reserveVersion(fn, version, size) {
  if (version < 7) return;
  for (let i = 0; i < 6; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      fn[size - 11 + j][i] = true;
      fn[i][size - 11 + j] = true;
    }
  }
}

function placeData(m, fn, codewords, size) {
  let bitIndex = 0;
  const total = codewords.length * 8;
  const bitAt = (i) => {
    if (i >= total) return 0;
    const byte = codewords[i >> 3];
    return (byte >> (7 - (i & 7))) & 1;
  };

  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (let n = 0; n < size; n += 1) {
      const row = upward ? size - 1 - n : n;
      for (let k = 0; k < 2; k += 1) {
        const c = col - k;
        if (fn[row][c]) continue;
        m[row][c] = bitAt(bitIndex) === 1;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function penalty(m, size) {
  let score = 0;

  const runScore = (line) => {
    let s = 0;
    let run = 1;
    for (let i = 1; i < line.length; i += 1) {
      if (line[i] === line[i - 1]) {
        run += 1;
      } else {
        if (run >= 5) s += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) s += 3 + (run - 5);
    return s;
  };
  const rows = [];
  const cols = [];
  for (let i = 0; i < size; i += 1) {
    rows.push(m[i]);
    const col = [];
    for (let j = 0; j < size; j += 1) col.push(m[j][i]);
    cols.push(col);
  }
  for (const line of rows) score += runScore(line);
  for (const line of cols) score += runScore(line);

  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }

  const PAT = [true, false, true, true, true, false, true];
  const matchAt = (line, i) => PAT.every((v, k) => line[i + k] === v);
  const rule3 = (line) => {
    let s = 0;
    for (let i = 0; i + 7 <= line.length; i += 1) {
      if (!matchAt(line, i)) continue;
      const before = line.slice(Math.max(0, i - 4), i);
      const after = line.slice(i + 7, i + 11);
      const blankBefore = before.length === 4 && before.every((v) => v === false);
      const blankAfter = after.length === 4 && after.every((v) => v === false);
      if (blankBefore || blankAfter) s += 40;
    }
    return s;
  };
  for (const line of rows) score += rule3(line);
  for (const line of cols) score += rule3(line);

  let dark = 0;
  for (let r = 0; r < size; r += 1) for (let c = 0; c < size; c += 1) if (m[r][c]) dark += 1;
  const total = size * size;
  const ratio = (dark * 100) / total;
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return score;
}

function formatBits(ec, mask) {
  const data = (EC_FORMAT_BITS[ec] << 3) | mask;
  let rem = data << 10;
  const G = 0b10100110111;
  for (let i = 4; i >= 0; i -= 1) {
    if ((rem >> (i + 10)) & 1) rem ^= G << i;
  }
  return ((data << 10) | rem) ^ 0b101010000010010;
}

function writeFormat(m, size, ec, mask) {
  const bits = formatBits(ec, mask);
  const bit = (i) => ((bits >> i) & 1) === 1;

  for (let i = 0; i <= 5; i += 1) m[i][8] = bit(i);
  m[7][8] = bit(6);
  m[8][8] = bit(7);
  for (let i = 8; i <= 14; i += 1) m[size - 15 + i][8] = bit(i);

  for (let i = 0; i <= 7; i += 1) m[8][size - 1 - i] = bit(i);
  m[8][7] = bit(8);
  for (let i = 9; i <= 14; i += 1) m[8][15 - i - 1] = bit(i);

  m[size - 8][8] = true;
}

function versionBits(version) {
  let rem = version << 12;
  const G = 0b1111100100101;
  for (let i = 5; i >= 0; i -= 1) {
    if ((rem >> (i + 12)) & 1) rem ^= G << i;
  }
  return (version << 12) | rem;
}

function writeVersion(m, size, version) {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i += 1) {
    const on = ((bits >> i) & 1) === 1;
    const r = Math.floor(i / 3);
    const c = i % 3;
    m[size - 11 + c][r] = on;
    m[r][size - 11 + c] = on;
  }
}

/**
 * Encode UTF-8 text into a QR bit matrix.
 * @param {string} text
 * @param {{ec?: 'L'|'M'|'Q'|'H', mask?: number}} [options]
 */
export function encodeQr(text, { ec = 'L', mask: forcedMask = null } = {}) {
  const level = String(ec).toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(EC_FORMAT_BITS, level)) {
    throw new Error(`不认识的纠错级别：${ec}`);
  }

  const bytes = Array.from(Buffer.from(String(text ?? ''), 'utf8'));
  if (!bytes.length) throw new Error('内容为空');

  const version = pickVersion(bytes.length, level);
  const size = 17 + 4 * version;

  const m = newMatrix(size);
  const fn = newMatrix(size);

  placeFinder(m, fn, size);
  placeTiming(m, fn, size);
  placeAlign(m, fn, version, size);
  reserveFormat(fn, size);
  reserveVersion(fn, version, size);

  const codewords = buildCodewords(bytes, version, level);
  placeData(m, fn, codewords, size);

  let bestMask = 0;
  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    if (forcedMask !== null && mask !== forcedMask) continue;
    const trial = m.map((row) => row.slice());
    const cond = MASKS[mask];
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        if (fn[r][c]) continue;
        if (cond(r, c)) trial[r][c] = !trial[r][c];
      }
    }
    const score = penalty(trial, size);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
      best = trial;
    }
  }
  if (!best) throw new Error(`掩码只能用 0–7，收到 ${forcedMask}`);

  writeFormat(best, size, level, bestMask);
  writeVersion(best, size, version);

  return { version, size, ec: level, mask: bestMask, modules: best };
}

export function qrToSvg(qr, { scale = 6, margin = 4, dark = '#111', light = '#fff' } = {}) {
  const { modules, size } = qr;
  const dim = (size + margin * 2) * scale;
  const rects = [];
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (!modules[r][c]) continue;
      rects.push(`<rect x="${(c + margin) * scale}" y="${(r + margin) * scale}" width="${scale}" height="${scale}"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">`
    + `<rect width="${dim}" height="${dim}" fill="${light}"/>`
    + `<g fill="${dark}">${rects.join('')}</g>`
    + '</svg>';
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

export function qrToPng(qr, { scale = 8, margin = 4 } = {}) {
  const size = qr.size;
  const dim = (size + margin * 2) * scale;

  const raw = Buffer.alloc(dim * (dim + 1));
  let p = 0;
  for (let y = 0; y < dim; y += 1) {
    raw[p] = 0;
    p += 1;
    const r = Math.floor(y / scale) - margin;
    for (let x = 0; x < dim; x += 1) {
      const c = Math.floor(x / scale) - margin;
      const dark = r >= 0 && c >= 0 && r < size && c < size && qr.modules[r][c];
      raw[p] = dark ? 0 : 255;
      p += 1;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(dim, 0);
  ihdr.writeUInt32BE(dim, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function qrToDataUrl(qr, options) {
  return `data:image/svg+xml;base64,${Buffer.from(qrToSvg(qr, options), 'utf8').toString('base64')}`;
}

export function qrToPngDataUrl(text, { ec = 'L', scale = 8, margin = 4 } = {}) {
  const qr = encodeQr(text, { ec });
  return `data:image/png;base64,${qrToPng(qr, { scale, margin }).toString('base64')}`;
}
