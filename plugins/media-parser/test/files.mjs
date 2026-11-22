import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import {
  HARD_FILE_BYTES, validateLocalFile, downloadRemoteMedia, isPublicAddress,
  effectiveMaxBytes, resolveMediaFile, removeOwnedFile,
} from '../files.js';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'media-files-'));
  const cacheRoot = path.join(directory, 'cache');
  await fs.mkdir(cacheRoot);
  const filename = path.join(cacheRoot, '空 格.png');
  await fs.writeFile(filename, 'file-bytes');
  t.after(async () => { await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, cacheRoot, filename };
}

function requests(responses, observed = []) {
  return (url, options, callback) => {
    const request = new EventEmitter();
    request.end = () => {
      options.lookup(url.hostname, { all: true }, (error, addresses) => {
        if (error) return request.emit('error', error);
        observed.push({ url: url.href, options, addresses });
        const description = responses.shift();
        const response = Readable.from(description.chunks ?? [Buffer.from('remote-file')]);
        response.statusCode = description.status ?? 200;
        response.headers = description.headers ?? {};
        queueMicrotask(() => callback(response));
      });
    };
    return request;
  };
}

test('缓存边界接受普通文件、编码 file URL 与根内相对路径', async (t) => {
  const f = await fixture(t);
  for (const reference of [f.filename, pathToFileURL(f.filename).href, path.basename(f.filename)]) {
    const result = await validateLocalFile(reference, { cacheRoot: f.cacheRoot });
    assert.equal(result.path, await fs.realpath(f.filename));
    assert.equal(result.size, 10);
  }
});

test('拒绝任意盘符、UNC、file 网络共享、目录和同前缀越界路径', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.directory, 'secret.txt');
  const samePrefix = `${f.cacheRoot}-other`;
  await fs.mkdir(samePrefix);
  await fs.writeFile(path.join(samePrefix, 'secret.txt'), 'outside');
  await fs.writeFile(outside, 'private');
  for (const reference of [
    outside, '../secret.txt', path.join(samePrefix, 'secret.txt'), f.cacheRoot,
    'Z:\\private.txt', '\\\\server\\share\\secret.txt', '//server/share/secret.txt',
    'file://server/share/secret.txt', 'base64://YQ==', 'file:///C:/a%2fb',
  ]) {
    await assert.rejects(validateLocalFile(reference, { cacheRoot: f.cacheRoot }),
      (error) => ['unsafe-path', 'not-file', 'unreadable'].includes(error.code));
  }
});

test('真实路径检查阻止 junction/symlink 逃逸和 final symlink', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.directory, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
  const junction = path.join(f.cacheRoot, 'escape');
  await fs.symlink(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(validateLocalFile(path.join(junction, 'secret.txt'), { cacheRoot: f.cacheRoot }),
    (error) => error.code === 'unsafe-path');
});

test('200 MiB 是硬上限，插件可进一步缩小；空文件拒绝发送', async (t) => {
  const f = await fixture(t);
  assert.equal(effectiveMaxBytes({ maxFileMiB: 300 }), HARD_FILE_BYTES);
  assert.equal(effectiveMaxBytes({ maxFileMiB: 2 }), 2 * 1048576);
  await fs.truncate(f.filename, HARD_FILE_BYTES + 1);
  await assert.rejects(validateLocalFile(f.filename, { cacheRoot: f.cacheRoot, maxBytes: Number.MAX_SAFE_INTEGER }),
    (error) => error.code === 'too-large');
  await fs.truncate(f.filename, 0);
  await assert.rejects(validateLocalFile(f.filename, { cacheRoot: f.cacheRoot }),
    (error) => error.code === 'empty-file');
});

test('公共 IP 校验覆盖私网、IPv4 映射、链路本地、保留 IPv6 和云元数据', () => {
  const forbidden = [
    '127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.1.1', '192.168.1.1',
    '169.254.169.254', '168.63.129.16', '100.100.100.200', '198.18.0.1', '224.0.0.1',
    '192.0.2.1', '198.51.100.2', '203.0.113.3', '::1', '::',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a00:1',
    'fe80::1', 'fc00::1', '2001:db8::1', '2001:0000::1', '2001:2::1', '2002:a00:1::1',
  ];
  for (const address of forbidden) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888', '2606:4700:4700::1111']) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test('下载绑定经过校验的 DNS 地址，保留原主机，并且从不发送 Cookie/Authorization', async (t) => {
  const f = await fixture(t);
  const observed = [];
  let lookups = 0;
  const record = await downloadRemoteMedia('https://cdn.example/media.mp4', {
    dataDir: f.directory,
    lookup: async () => { lookups += 1; return [{ address: '8.8.8.8', family: 4 }]; },
    requestFn: requests([{ headers: { 'content-length': '11' } }], observed),
    headers: { Cookie: 'DO_NOT_FORWARD=secret', Authorization: 'Bearer secret' },
  });
  assert.equal(lookups, 1);
  assert.equal(record.owned, true);
  assert.equal(await fs.readFile(record.path, 'utf8'), 'remote-file');
  assert.equal(observed[0].url, 'https://cdn.example/media.mp4');
  assert.deepEqual(observed[0].addresses, [{ address: '8.8.8.8', family: 4 }]);
  assert.ok(!Object.keys(observed[0].options.headers).some((key) => /cookie|authorization/i.test(key)));
  await removeOwnedFile(record, f.directory);
  await assert.rejects(fs.stat(record.path));
});

test('DNS 混合返回或跳转到内网必须拒绝；每次跳转重新解析并绑定地址', async (t) => {
  const f = await fixture(t);
  let opened = 0;
  await assert.rejects(downloadRemoteMedia('https://cdn.example/x', {
    dataDir: f.directory,
    lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }],
    requestFn: () => { opened += 1; throw new Error('不得建连'); },
  }), (error) => error.code === 'private-address');
  assert.equal(opened, 0);
  const observed = [];
  await assert.rejects(downloadRemoteMedia('https://cdn.example/x', {
    dataDir: f.directory,
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    requestFn: requests([{ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }], observed),
  }), (error) => error.code === 'private-address');
  assert.equal(observed.length, 1);
  const hosts = [];
  await downloadRemoteMedia('https://first.example/x', {
    dataDir: f.directory,
    lookup: async (hostname) => { hosts.push(hostname); return [{ address: '8.8.8.8', family: 4 }]; },
    requestFn: requests([{ status: 302, headers: { location: 'https://second.example/a.mp4' } }, {}]),
  });
  assert.deepEqual(hosts, ['first.example', 'second.example']);
});

test('远端大小限制既检查 Content-Length 也检查实际流，部分文件会被清除', async (t) => {
  const f = await fixture(t);
  for (const description of [
    { headers: { 'content-length': '100' } },
    { chunks: [Buffer.alloc(4), Buffer.alloc(4), Buffer.alloc(4)] },
  ]) {
    await assert.rejects(downloadRemoteMedia('https://cdn.example/media.mp4', {
      dataDir: f.directory, maxBytes: 10,
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      requestFn: requests([description]),
    }), (error) => error.code === 'too-large');
  }
  assert.deepEqual(await fs.readdir(path.join(f.directory, 'delivery-cache')), []);
});

test('总超时包括 DNS；取消、任务过期和不安全 URL 均不会下载或留下文件', async (t) => {
  const f = await fixture(t);
  let opened = false;
  await assert.rejects(downloadRemoteMedia('https://cdn.example/x', {
    dataDir: f.directory, timeoutMs: 15,
    lookup: async () => new Promise(() => {}),
    requestFn: () => { opened = true; },
  }), (error) => error.code === 'timeout');
  assert.equal(opened, false);
  for (const reference of ['http://localhost/a', 'http://user:password@example.com/a', 'file:///etc/passwd']) {
    await assert.rejects(downloadRemoteMedia(reference, { dataDir: f.directory }), (error) => error.code === 'unsafe-url');
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(resolveMediaFile(f.filename, {
    ctx: { dataDir: f.directory }, engine: { cacheRoot: f.cacheRoot }, signal: controller.signal,
  }), (error) => error.code === 'cancelled');
});
