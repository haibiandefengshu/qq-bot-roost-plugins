import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMessage, sanitizeUrl, shortMessageId, shapeExceeds } from '../bili-dm-content.js';

function message(type, content, extra = {}) {
  return {
    sender_uid: '9007199254740993',
    receiver_type: 1,
    receiver_id: '425503913',
    msg_type: type,
    content: typeof content === 'string' ? content : JSON.stringify(content),
    msg_seqno: '1285290404823041',
    timestamp: 1712305278,
    msg_key: '7354295169819585966',
    msg_status: 0,
    ...extra,
  };
}

function normalize(raw, extra = {}) {
  return normalizeMessage({
    raw,
    robotKey: 'bot',
    accountUid: '425503913',
    sessionType: 1,
    talkerId: '844424930131966',
    ...extra,
  });
}

test('text keeps original newlines, blank paragraphs, leading spaces and emoticons', () => {
  const text = '  第一行[doge]\n\n第二行\n\n\n尾部  ';
  const record = normalize(message(1, { content: text }));
  assert.equal(record.text, text);
  assert.equal(record.senderUid, '9007199254740993');
  assert.equal(record.msgKey, '7354295169819585966');
  assert.equal(record.seqno, '1285290404823041');
  assert.equal(record.sentAt, 1712305278);
  assert.equal(record.fatal, false);
});

test('image and custom face keep only safe original links', () => {
  const image = normalize(message(2, {
    url: 'https://message.biliimg.com/bfs/im/x.jpg?token=deadbeef',
  }));
  assert.deepEqual(image.imageUrls, ['https://message.biliimg.com/bfs/im/x.jpg']);
  assert.match(image.text, /图片原链/);
  const unsafe = normalize(message(2, {
    url: 'https://user@message.biliimg.com/bfs/im/x.jpg',
  }));
  assert.deepEqual(unsafe.imageUrls, []);
  assert.match(unsafe.text, /不可安全展示/);
  const face = normalize(message(6, { url: 'https://i0.hdslb.com/bfs/emote/a.png' }));
  assert.deepEqual(face.imageUrls, ['https://i0.hdslb.com/bfs/emote/a.png']);
  assert.match(face.text, /表情原链/);
  assert.equal(sanitizeUrl('javascript:alert(1)'), '');
  assert.equal(sanitizeUrl(`https://example.com/${'a'.repeat(3000)}`), '');
});

test('shares for types 7, 11, 12, 13 and 14 expose title, description and original link', () => {
  const share = normalize(message(7, {
    author: '作者', title: '标题', headline: '主标题', source: 5, url: 'https://www.bilibili.com/video/BV1',
  }));
  assert.equal(share.type, 'share');
  assert.match(share.text, /标题：标题/);
  assert.deepEqual(share.shareUrls, ['https://www.bilibili.com/video/BV1']);

  const video = normalize(message(11, {
    title: '视频标题', desc: '视频说明', bvid: 'BV1xx411c7mD', rid: 1,
  }));
  assert.equal(video.type, 'video');
  assert.match(video.text, /视频标题/);
  assert.match(video.text, /视频说明/);
  assert.deepEqual(video.shareUrls, ['https://www.bilibili.com/video/BV1xx411c7mD']);

  const article = normalize(message(12, {
    title: '专栏标题', summary: '专栏概要', rid: 18275013, author: '作者',
  }));
  assert.equal(article.type, 'article');
  assert.deepEqual(article.shareUrls, ['https://www.bilibili.com/read/cv18275013']);

  const card = normalize(message(13, {
    pic_url: 'https://i0.hdslb.com/bfs/location/x.png',
    jump_url: 'https://www.bilibili.com/h5/mall/suit/detail?id=1',
    title: '图片卡片',
  }));
  assert.equal(card.type, 'image_card');
  assert.equal(card.imageUrls.length, 1);
  assert.match(card.text, /图片卡片/);

  const other = normalize(message(14, {
    author: 'UP', title: '直播', desc: '说明', url: 'https://live.bilibili.com/1',
  }));
  assert.equal(other.type, 'share');
  assert.match(other.text, /说明/);
  assert.deepEqual(other.shareUrls, ['https://live.bilibili.com/1']);
});

test('revoked, system-cancelled and type 5/8 bodies are never echoed', () => {
  const secret = 'PRIVATE-REVOKED-BODY';
  for (const raw of [
    message(1, { content: secret }, { msg_status: 1 }),
    message(1, { content: secret }, { msg_status: 2 }),
    message(1, { content: secret }, { sys_cancel: true }),
    message(5, { content: secret }),
    message(8, { content: secret }),
    message(2, { url: 'https://x.test/' + secret }, { msg_status: 50 }),
  ]) {
    const record = normalize(raw);
    assert.equal(record.sourceStatus, 'state_only');
    assert.equal(record.text.includes(secret), false);
    assert.match(record.text, /仅显示状态/);
  }
});

test('unknown and malformed messages become placeholders without being fatal', () => {
  const unsupported = normalize(message(999, { content: '{}' }));
  assert.equal(unsupported.type, 'unsupported');
  assert.match(unsupported.text, /999/);
  assert.equal(unsupported.text.includes('PRIVATE'), false);

  const malformed = normalize(message(1, '{"content":"unterminated'));
  assert.equal(malformed.fatal, false);
  assert.equal(malformed.parseFailure, true);
  assert.match(malformed.text, /无法解析/);

  const missingSeq = normalize(message(1, { content: 'x' }, { msg_seqno: undefined, msg_key: '' }));
  assert.equal(missingSeq.fatal, true);
  assert.equal(missingSeq.sourceStatus, 'message_id_invalid');
});

test('oversized and depth-invalid contents are visible fatal failures', () => {
  const oversized = normalize(message(1, { content: 'x'.repeat(200) }), { maxContentChars: 50 });
  assert.equal(oversized.fatal, true);
  assert.equal(oversized.sourceStatus, 'content_too_large');

  let deep = '0';
  for (let index = 0; index < 30; index += 1) deep = `[${deep}]`;
  const tooDeep = normalize(message(1, deep), { maxDepth: 5 });
  assert.equal(tooDeep.fatal, true);
  assert.equal(tooDeep.sourceStatus, 'content_invalid');
  assert.equal(shapeExceeds(deep, 5, 100), true);
});

test('short IDs are stable printable identifiers derived from the full key', () => {
  const key = 'bot|425503913|1|844424930131966|7354295169819585966';
  assert.equal(shortMessageId(key), shortMessageId(key));
  assert.match(shortMessageId(key), /^[0-9A-F]{12}$/);
  assert.ok(shortMessageId(key).length >= 12);
  assert.notEqual(shortMessageId(key), shortMessageId(`${key}x`));
});

test('type 7 source and id build only documented original links', () => {
  const video = normalize(message(7, { source: 5, id: '17', title: 'video' }));
  assert.ok(video.shareUrls.some((url) => /video\/av17(?:$|[?#])/.test(url)));
  const dynamic = normalize(message(7, { source: 11, id: '90071992547409939', title: 'dynamic' }));
  assert.ok(dynamic.shareUrls.some((url) => url.includes('90071992547409939')));
  const article = normalize(message(7, { source: 6, id: '18275013', title: 'article' }));
  assert.ok(article.shareUrls.some((url) => url.includes('/read/cv18275013')));
  const unknown = normalize(message(7, { source: 999, id: '17', title: 'unknown' }));
  assert.deepEqual(unknown.shareUrls, []);
});

test('unknown, missing and string withdrawal statuses suppress residual bodies', () => {
  const body = 'PRIVATE-RESIDUAL-BODY';
  for (const msg_status of ['1', 'unrecognized', 1, 2, 50, undefined]) {
    const record = normalize(message(1, { content: body }, { msg_status }));
    assert.equal(record.text.includes(body), false, String(msg_status));
    assert.equal(record.sourceStatus, 'state_only');
  }
  const normal = normalize(message(1, { content: 'visible' }, { msg_status: '0' }));
  assert.equal(normal.text, 'visible');
  assert.equal(normal.sourceStatus, 'ok');
});
