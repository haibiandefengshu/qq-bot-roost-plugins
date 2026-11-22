import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { extractLinks, platformOf, structuredLinks, REPLY_JUDGE_BYPASS } from '../links.js';
import { PLATFORM_IDS } from '../settings.js';

const fixtures = {
  bilibili: 'https://www.bilibili.com/video/BV1xx411c7mD?p=2',
  douyin: 'https://v.douyin.com/AbCdE/',
  kuaishou: 'https://v.kuaishou.com/AbCd/',
  acfun: 'https://www.acfun.cn/v/ac123',
  hongguo: 'https://www.hongguoduanju.com/video/123',
  netease: 'https://music.163.com/#/song?id=123',
  ximalaya: 'https://www.ximalaya.com/sound/123',
  weibo: 'https://weibo.com/123/Abcdefgh',
  xiaohongshu: 'https://xhslink.com/a/AbC',
  xianyu: 'https://www.goofish.com/item?id=123',
  toutiao: 'https://www.toutiao.com/article/123',
  xiaoheihe: 'https://www.xiaoheihe.cn/app/bbs/link/123',
  xueqiu: 'https://xueqiu.com/123/456',
  wechat: 'https://mp.weixin.qq.com/s/abc',
  zhihu: 'https://www.zhihu.com/question/1/answer/2',
  tieba: 'https://tieba.baidu.com/p/123',
  nga: 'https://bbs.nga.cn/read.php?tid=123',
  hupu: 'https://bbs.hupu.com/123.html',
  douban: 'https://movie.douban.com/subject/123/',
  v2ex: 'https://www.v2ex.com/t/123',
  juejin: 'https://juejin.cn/post/123',
  csdn: 'https://blog.csdn.net/alice/article/details/123',
  cnblogs: 'https://www.cnblogs.com/alice/p/123.html',
  gitee: 'https://gitee.com/alice/repo',
  tiktok: 'https://www.tiktok.com/@alice/video/123',
  youtube: 'https://www.youtube.com/watch?v=AbCdEf12345',
  steam: 'https://store.steampowered.com/app/123/',
  twitter: 'https://x.com/alice/status/123',
  pixiv: 'https://www.pixiv.net/artworks/123',
  github: 'https://github.com/alice/repo',
  gitlab: 'https://gitlab.com/alice/repo',
};

test('31 platform fixtures match the bundled engine parser keys', async () => {
  const engine = JSON.parse(await fs.readFile(new URL('../engine/config.example.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(fixtures), PLATFORM_IDS);
  assert.deepEqual(Object.keys(engine.parsers), PLATFORM_IDS);
  for (const [id, link] of Object.entries(fixtures)) {
    assert.equal(platformOf(link), id, id);
    assert.equal(extractLinks(link)[0]?.platform, id, id);
    assert.equal(new RegExp(REPLY_JUDGE_BYPASS, 'i').test(link), true, `bypass ${id}`);
  }
});

test('ordered dedupe keeps complete query and music hash, then limits to three', () => {
  const [a, b, c] = [fixtures.bilibili, fixtures.netease, fixtures.douyin];
  const result = extractLinks(`分享 ${a}，${a}。 ${b} ${c} ${fixtures.github}`);
  assert.deepEqual(result.map((x) => x.url), [a, b, c]);
  assert.equal(result[0].url.endsWith('?p=2'), true);
  const pages = extractLinks(`${a} ${a.replace('p=2', 'p=3')}`);
  assert.equal(pages.length, 2);
});

test('complete host boundary, credentials, internal hosts and nested URL attacks are rejected', () => {
  for (const url of [
    'https://bilibili.com.evil.example/video/BV1xx411c7mD',
    'https://evilbilibili.com/video/BV1xx411c7mD',
    'https://bilibili.com@evil.example/video/BV1xx411c7mD',
    'https://alice:secret@bilibili.com/video/BV1xx411c7mD',
    'https://bilibili.com:8080/video/BV1xx411c7mD',
    'http://127.0.0.1/video/BV1xx411c7mD',
    'http://169.254.169.254/metadata',
    'file:///C:/secret.mp4',
    'https://evil.test/?url=https://bilibili.com/video/BV1xx411c7mD',
    'https://live.bilibili.com/123',
  ]) assert.deepEqual(extractLinks(url), [], url);
  assert.equal(platformOf('https://www.bilibili.com/video/BV1xx411c7mD'), 'bilibili');
});

test('bare Bilibili IDs preserve parameters and do not consume attached words or IDs inside rejected URLs', () => {
  assert.deepEqual(extractLinks('看 BV1xx411c7mD?p=2 和 av123?foo=bar').map((x) => x.url), [
    'https://www.bilibili.com/video/BV1xx411c7mD?p=2',
    'https://www.bilibili.com/video/av123?foo=bar',
  ]);
  assert.deepEqual(extractLinks('xBV1xx411c7mD BV1xx411c7mDtail'), []);
});

test('bangumi, multi-page, album and short links keep the original target', () => {
  for (const link of [
    'https://www.bilibili.com/bangumi/play/ep123?from_spmid=1',
    'https://b23.tv/AbCde?p=2',
    'https://www.douyin.com/note/123?modal_id=456',
    'https://novelquickapp.com/hongguo/ug/pages/video-detail-share?book_id=123',
    'https://api.xiaoheihe.cn/v3/bbs/app/api/web/share?link_id=123',
  ]) assert.equal(extractLinks(link)[0]?.url, link);
  // These aliases are absent from this bundled parser's supported share hosts.
  assert.equal(platformOf('https://changdunovel.com/a/123'), null);
  assert.equal(platformOf('https://heybox.com/a/123'), null);
});

test('explicit structured card URL is used while placeholders and local file attachments are ignored', () => {
  const msg = {
    content: '[卡片消息]',
    raw: { ark: JSON.stringify({ meta: { detail_1: { qqdocurl: fixtures.bilibili } } }) },
    attachments: [{ url: 'file:///C:/private.mp4' }],
  };
  assert.deepEqual(structuredLinks(msg), [fixtures.bilibili]);
  assert.equal(extractLinks(msg)[0].from, 'card');
  assert.deepEqual(extractLinks({ content: '[卡片消息]', raw: {} }), []);
  assert.deepEqual(extractLinks(fixtures.bilibili, { platformModes: { bilibili: '关闭' } }), []);
});
