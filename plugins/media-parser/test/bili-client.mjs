import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BiliClientError, canonicalId, createBiliClient, parseLosslessJson,
} from '../bili-client.js';

const QR_KEY = ['a1b2', 'c3d4', 'e5f6', '0718', '293a', '4b5c', '6d7e', '8f90'].join('');
const SESS = 'SESS' + 'DATA';
const JCT = 'bili' + '_jct';
const SERVER_DATE = 'Mon, 05 Sep 2022 07:30:09 GMT';

function jsonResponse(value, { status = 200, headers = {} } = {}) {
  const merged = new Headers(headers);
  if (!merged.has('content-type')) merged.set('content-type', 'application/json');
  if (!merged.has('date')) merged.set('date', SERVER_DATE);
  return new Response(typeof value === 'string' ? value : JSON.stringify(value), { status, headers: merged });
}

function navBody(mid = '425503913', extra = {}) {
  return {
    code: 0, message: '0', ttl: 1,
    data: { isLogin: true, mid, uname: '测试账号', ...extra },
  };
}

function errorCode(fn) {
  try { fn(); } catch (error) { return error?.code; }
  return '';
}

test('lossless JSON keeps large integers as decimal strings and decodes escapes', () => {
  const value = parseLosslessJson('{"mid":9007199254740993,"neg":-9007199254740993,'
    + '"safe":42,"frac":1.5,"exp":1e3,"text":"a\\\"b\\u4e2d\\n\\\\c","list":[1,{"k":"v"}]}');
  assert.equal(value.mid, '9007199254740993');
  assert.equal(value.neg, '-9007199254740993');
  assert.equal(value.safe, 42);
  assert.equal(value.frac, 1.5);
  assert.equal(value.exp, '1e3');
  assert.equal(value.text, 'a"b中\n\\c');
  assert.deepEqual(value.list, [1, { k: 'v' }]);
});

test('lossless JSON rejects dangerous keys, duplicates, depth, size and bad grammar', () => {
  assert.equal(errorCode(() => parseLosslessJson('{"__proto__":{"x":1}}')), 'BILI_RESPONSE');
  assert.equal(errorCode(() => parseLosslessJson('{"constructor":1}')), 'BILI_RESPONSE');
  assert.equal(errorCode(() => parseLosslessJson('{"a":1,"a":2}')), 'BILI_RESPONSE');
  assert.equal(errorCode(() => parseLosslessJson('{"a":"unterminated}')), 'BILI_RESPONSE');
  assert.equal(errorCode(() => parseLosslessJson('{"a":"\\u12"}')), 'BILI_RESPONSE');
  assert.equal(errorCode(() => parseLosslessJson('{"a":"line\nbreak"}')), 'BILI_RESPONSE');
  assert.equal(errorCode(() => parseLosslessJson('{"a":1} trailing')), 'BILI_RESPONSE');
  assert.equal(errorCode(() => parseLosslessJson('{"a":1e9999}')), 'BILI_RESPONSE');
  let deep = '0';
  for (let i = 0; i < 70; i += 1) deep = `[${deep}]`;
  assert.equal(errorCode(() => parseLosslessJson(deep, { maxDepth: 20 })), 'BILI_RESPONSE');
  const wide = `[${Array.from({ length: 30 }, () => '1').join(',')}]`;
  assert.equal(errorCode(() => parseLosslessJson(wide, { maxNodes: 20 })), 'BILI_RESPONSE');
  assert.equal(errorCode(() => parseLosslessJson('"0123456789"', { maxChars: 5 })), 'BILI_RESPONSE');
  assert.equal(errorCode(() => parseLosslessJson('"中中"', { maxChars: 5 })), 'BILI_RESPONSE');
  assert.equal(parseLosslessJson('"abcd"', { maxChars: 6 }), 'abcd');
});

test('fractional or exponent ID tokens cannot round into a different safe integer', () => {
  for (const raw of ['10000000000000001e-16', '1.0000000000000001', '1e0']) {
    assert.equal(errorCode(() => canonicalId(parseLosslessJson(`{"id":${raw}}`).id)), 'BILI_RESPONSE');
  }
  assert.equal(canonicalId(parseLosslessJson('{"id":7354295169819585966}').id), '7354295169819585966');
});

test('canonical IDs reject unsafe or non-integer numeric representations', () => {
  assert.equal(canonicalId('9007199254740993'), '9007199254740993');
  assert.equal(canonicalId(42), '42');
  assert.equal(errorCode(() => canonicalId(9007199254740993)), 'BILI_RESPONSE');
  assert.equal(errorCode(() => canonicalId(1e20)), 'BILI_RESPONSE');
  assert.equal(errorCode(() => canonicalId(1.5)), 'BILI_RESPONSE');
  assert.equal(errorCode(() => canonicalId('01')), 'BILI_RESPONSE');
  assert.equal(errorCode(() => canonicalId('-1')), 'BILI_RESPONSE');
  assert.equal(errorCode(() => canonicalId(undefined)), 'BILI_RESPONSE');
});

test('nav requires login and a nonzero canonical mid and never exposes the Cookie', async () => {
  let seen;
  const client = createBiliClient({
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return jsonResponse(navBody());
    },
  });
  const cookie = `${SESS}=alpha; ${JCT}=beta`;
  const result = await client.nav(cookie);
  assert.equal(result.mid, '425503913');
  assert.equal(result.uname, '测试账号');
  assert.equal(result.serverTime, Date.parse(SERVER_DATE));
  assert.equal(seen.url, 'https://api.bilibili.com/x/web-interface/nav');
  assert.equal(seen.options.redirect, 'error');
  assert.equal(seen.options.method, 'GET');
  assert.match(seen.options.headers.cookie, new RegExp(`^${SESS}=alpha`));
  assert.equal(JSON.stringify(result).includes('alpha'), false);

  const notLogged = createBiliClient({ fetchImpl: async () => jsonResponse({ code: 0, data: { isLogin: false, mid: 0 } }) });
  await assert.rejects(notLogged.nav(cookie), { code: 'BILI_AUTH' });
  const zeroMid = createBiliClient({ fetchImpl: async () => jsonResponse(navBody('0')) });
  await assert.rejects(zeroMid.nav(cookie), { code: 'BILI_AUTH' });
  const expired = createBiliClient({ fetchImpl: async () => jsonResponse({ code: -101, message: `${SESS}=alpha` }) });
  await assert.rejects(expired.nav(cookie), (error) => {
    assert.equal(error.code, 'BILI_AUTH');
    assert.equal(String(error.message).includes('alpha'), false);
    return true;
  });
});

test('QR generate and poll use fixed endpoints and extract only allowlisted cookies', async () => {
  const calls = [];
  const pollHeaders = new Headers();
  pollHeaders.append('set-cookie', `${SESS}=alpha; Path=/; HttpOnly; Secure`);
  pollHeaders.append('set-cookie', `${JCT}=beta; Path=/`);
  pollHeaders.append('set-cookie', 'DedeUserID=123456789; Path=/');
  pollHeaders.append('set-cookie', 'sid=gamma; Path=/');
  const client = createBiliClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.includes('/generate')) {
        return jsonResponse({
          code: 0,
          data: { url: `https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=${QR_KEY}`, qrcode_key: QR_KEY },
        });
      }
      return jsonResponse({ code: 0, data: { code: 0, url: '', refresh_token: '', timestamp: 1 } }, { headers: pollHeaders });
    },
  });
  const generated = await client.generateQr();
  assert.equal(generated.key, QR_KEY);
  assert.match(generated.url, /^https:\/\/passport\.bilibili\.com\//);
  const polled = await client.pollQr(QR_KEY);
  assert.equal(polled.state, 'success');
  assert.equal(polled.cookie, `${SESS}=alpha; ${JCT}=beta; DedeUserID=123456789; sid=gamma`);
  assert.equal(polled.cookie.includes('buvid3'), false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate');
  assert.match(calls[1].url, /^https:\/\/passport\.bilibili\.com\/x\/passport-login\/web\/qrcode\/poll\?qrcode_key=/);
});

test('QR poll maps waiting/scanned/expired and supports the documented callback fallback', async () => {
  for (const [code, state] of [[86101, 'waiting'], [86090, 'scanned'], [86038, 'expired']]) {
    const client = createBiliClient({ fetchImpl: async () => jsonResponse({ code: 0, data: { code } }) });
    assert.equal((await client.pollQr(QR_KEY)).state, state);
  }
  const callback = `https://passport.biligame.com/crossDomain?DedeUserID=123&${SESS}=alpha&${JCT}=beta`;
  const client = createBiliClient({ fetchImpl: async () => jsonResponse({ code: 0, data: { code: 0, url: callback } }) });
  const result = await client.pollQr(QR_KEY);
  assert.equal(result.state, 'success');
  assert.equal(result.cookie, `${SESS}=alpha; ${JCT}=beta; DedeUserID=123`);
});

test('sessions and messages use the documented parameters and keep large IDs lossless', async () => {
  const urls = [];
  const client = createBiliClient({
    fetchImpl: async (url) => {
      urls.push(new URL(url));
      if (url.includes('get_sessions')) {
        return jsonResponse({
          code: 0,
          data: {
            session_list: [{ talker_id: '844424930131966', session_type: 1, max_seqno: '1285290404823041' }],
            has_more: 1, system_msg: { 7: 844424930131966 },
          },
        });
      }
      return jsonResponse({
        code: 0,
        data: {
          messages: [{ msg_seqno: '1285290404823041', msg_key: '7354295169819585966', sender_uid: 1 }],
          has_more: 0, min_seqno: '1', max_seqno: '1285290404823041',
        },
      });
    },
  });

  const sessions = await client.sessions('SESSDATA=secret', { endTs: '1712305278098351', size: 100 });
  assert.equal(sessions.hasMore, true);
  assert.equal(sessions.sessions[0].talker_id, '844424930131966');
  assert.equal(urls[0].hostname, 'api.vc.bilibili.com');
  assert.equal(urls[0].pathname, '/session_svr/v1/session_svr/get_sessions');
  assert.equal(urls[0].searchParams.get('session_type'), '1');
  assert.equal(urls[0].searchParams.get('group_fold'), '0');
  assert.equal(urls[0].searchParams.get('unfollow_fold'), '0');
  assert.equal(urls[0].searchParams.get('sort_rule'), '2');
  assert.equal(urls[0].searchParams.get('size'), '100');
  assert.equal(urls[0].searchParams.get('end_ts'), '1712305278098351');

  const messages = await client.messages('SESSDATA=secret', {
    talkerId: '9007199254740993', sessionType: 1, beginSeqno: '100', endSeqno: '200', size: 50,
  });
  assert.equal(messages.messages[0].msg_seqno, '1285290404823041');
  assert.equal(urls[1].pathname, '/svr_sync/v1/svr_sync/fetch_session_msgs');
  assert.equal(urls[1].searchParams.get('talker_id'), '9007199254740993');
  assert.equal(urls[1].searchParams.get('begin_seqno'), '100');
  assert.equal(urls[1].searchParams.get('end_seqno'), '200');
  assert.equal(urls[1].searchParams.get('size'), '50');
});

test('rate limits honor Retry-After and HTTP failures keep safe constant messages', async () => {
  const limited = createBiliClient({
    fetchImpl: async () => jsonResponse({ code: 0 }, { status: 429, headers: { 'retry-after': '2' } }),
  });
  await assert.rejects(limited.nav('SESSDATA=secret'), (error) => {
    assert.equal(error.code, 'BILI_RATE_LIMIT');
    assert.equal(error.retryAfterMs, 2000);
    assert.equal(error.message, '请求过于频繁，请稍后重试');
    return true;
  });
  const broken = createBiliClient({
    fetchImpl: async () => jsonResponse({ error: 'SESSDATA=secret at https://secret.example' }, { status: 500 }),
  });
  await assert.rejects(broken.nav('SESSDATA=secret'), (error) => {
    assert.equal(error.code, 'BILI_HTTP');
    assert.equal(String(error.message).includes('secret'), false);
    assert.equal(String(error.message).includes('https://'), false);
    return true;
  });
});

test('decompressed body cap, body timeout, abort and fetch that ignores abort are fenced', async () => {
  const capped = createBiliClient({
    maxBytes: 64, timeoutMs: 200,
    fetchImpl: async () => new Response('x'.repeat(65), { status: 200 }),
  });
  await assert.rejects(capped.nav('SESSDATA=secret'), { code: 'BILI_RESPONSE' });

  const never = () => new ReadableStream({ start() {} });
  const slowBody = createBiliClient({
    timeoutMs: 30,
    fetchImpl: async () => new Response(never(), { status: 200 }),
  });
  await assert.rejects(slowBody.nav('SESSDATA=secret'), { code: 'BILI_TIMEOUT' });

  const ignoringAbort = createBiliClient({ timeoutMs: 30, fetchImpl: () => new Promise(() => {}) });
  await assert.rejects(ignoringAbort.nav('SESSDATA=secret'), { code: 'BILI_TIMEOUT' });

  const controller = new AbortController();
  const aborting = createBiliClient({
    timeoutMs: 1000,
    fetchImpl: async () => new Response(never(), { status: 200 }),
  });
  const pending = aborting.nav('SESSDATA=secret', { signal: controller.signal });
  setTimeout(() => controller.abort(), 15);
  await assert.rejects(pending, { code: 'BILI_CANCELLED' });
});

test('network errors never echo server text or credentials', async () => {
  const client = createBiliClient({
    fetchImpl: async () => { throw new Error('SESSDATA=secret https://secret.example'); },
  });
  await assert.rejects(client.nav('SESSDATA=secret'), (error) => {
    assert.equal(error instanceof BiliClientError, true);
    assert.equal(error.code, 'BILI_NETWORK');
    assert.equal(String(error.message).includes('secret'), false);
    return true;
  });
});

test('body-stream rejection becomes a safe client error without the private sentinel', async () => {
  const sentinel = 'private-body-sentinel-主人私信';
  const client = createBiliClient({
    fetchImpl: async () => new Response(new ReadableStream({
      pull(controller) { controller.error(new Error(sentinel)); },
    })),
  });
  await assert.rejects(client.nav('SESSDATA=fixture-only'), (error) => {
    assert.equal(error instanceof BiliClientError, true);
    assert.equal(error.code, 'BILI_RESPONSE');
    assert.equal(String(error).includes(sentinel), false);
    return true;
  });
});

test('malformed session/message pages and ambiguous has_more never become empty successes', async () => {
  for (const data of [
    { session_list: {}, has_more: 0 }, { has_more: 0 },
    { session_list: [], has_more: '1' }, { session_list: [] },
    { session_list: null, has_more: 1 },
  ]) {
    const client = createBiliClient({ fetchImpl: async () => jsonResponse({ code: 0, data }) });
    await assert.rejects(client.sessions('SESSDATA=fixture-only'), { code: 'BILI_RESPONSE' });
  }
  for (const data of [
    { messages: 'invalid', has_more: 0 }, { has_more: 0 },
    { messages: [], has_more: 3 }, { messages: [] },
    { messages: null, has_more: true },
  ]) {
    const client = createBiliClient({ fetchImpl: async () => jsonResponse({ code: 0, data }) });
    await assert.rejects(client.messages('SESSDATA=fixture-only', { talkerId: '42' }), { code: 'BILI_RESPONSE' });
  }
  const empty = createBiliClient({
    fetchImpl: async () => jsonResponse({
      code: 0, data: { session_list: null, messages: null, has_more: 0 },
    }),
  });
  assert.deepEqual((await empty.sessions('SESSDATA=fixture-only')).sessions, []);
  assert.deepEqual((await empty.messages('SESSDATA=fixture-only', { talkerId: '42' })).messages, []);
});

test('QR generator only accepts fixed HTTPS login scan endpoints and a matching key', async () => {
  const key = 'ab'.repeat(16);
  for (const url of [
    `https://space.bilibili.com/42?qrcode_key=${key}`,
    `https://user@passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=${key}`,
    `https://passport.bilibili.com:444/h5-app/passport/login/scan?qrcode_key=${key}`,
    `https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=${'cd'.repeat(16)}`,
    `https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=${key}#fragment`,
  ]) {
    const client = createBiliClient({ fetchImpl: async () => jsonResponse({ code: 0, data: { url, qrcode_key: key } }) });
    await assert.rejects(client.generateQr(), { code: 'BILI_RESPONSE' });
  }
  const account = `https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=${key}`;
  const client = createBiliClient({ fetchImpl: async () => jsonResponse({ code: 0, data: { url: account, qrcode_key: key } }) });
  assert.equal((await client.generateQr()).url, account);
});

test('callback cookie fallback rejects userinfo, ports, fragments and injection attempts', async () => {
  const badUrls = [
    `https://user@passport.biligame.com/crossDomain?${SESS}=alpha`,
    `https://passport.biligame.com:444/crossDomain?${SESS}=alpha`,
    `https://passport.biligame.com/crossDomain?${SESS}=al%0d%0apha`,
    `https://passport.biligame.com/crossDomain?${SESS}=alpha%3Bbeta`,
    `https://passport.biligame.com/crossDomain?other=1`,
    `https://passport.biligame.com/crossDomain?${SESS}=${'x'.repeat(5000)}`,
  ];
  for (const url of badUrls) {
    const client = createBiliClient({ fetchImpl: async () => jsonResponse({ code: 0, data: { code: 0, url } }) });
    await assert.rejects(client.pollQr(QR_KEY), { code: 'BILI_COOKIE' });
  }
  const callback = `https://passport.biligame.com/crossDomain?DedeUserID=123&${SESS}=alpha&${JCT}=beta`;
  const good = createBiliClient({ fetchImpl: async () => jsonResponse({ code: 0, data: { code: 0, url: callback } }) });
  assert.equal((await good.pollQr(QR_KEY)).cookie, `${SESS}=alpha; ${JCT}=beta; DedeUserID=123`);
});
