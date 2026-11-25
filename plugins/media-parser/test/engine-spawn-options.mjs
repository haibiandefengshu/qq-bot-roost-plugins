import test from 'node:test';
import assert from 'node:assert/strict';
import { managedPythonSpawnOptions } from '../engine-host.js';

const CHINESE_PATH = 'E:\\插件 目录\\媒体 引擎 数据';
const ENV = {
  MEDIA_PARSER_DATA_DIR: CHINESE_PATH,
  TEMP: `${CHINESE_PATH}\\tmp`,
  PATH: 'C:\\Program Files\\Python 3.12',
};

test('Windows managed engine options hide the console and never detach', () => {
  const options = managedPythonSpawnOptions({ cwd: CHINESE_PATH, logFd: 17, env: ENV, platform: 'win32' });
  assert.deepEqual(options, {
    cwd: CHINESE_PATH,
    windowsHide: true,
    detached: false,
    shell: false,
    stdio: ['ignore', 17, 17],
    env: ENV,
  });
  assert.equal(options.env, ENV);
});

test('POSIX managed engine options stay detached while still hidden and shell-free', () => {
  for (const platform of ['linux', 'darwin', 'freebsd']) {
    const options = managedPythonSpawnOptions({ cwd: CHINESE_PATH, logFd: 9, env: ENV, platform });
    assert.equal(options.windowsHide, true);
    assert.equal(options.detached, true);
    assert.equal(options.shell, false);
    assert.deepEqual(options.stdio, ['ignore', 9, 9]);
  }
});

test('Chinese and spaces in the working directory and runtime env are preserved exactly', () => {
  const cwd = `${CHINESE_PATH}\\带 空格 的子目录`;
  const env = { ...ENV, MEDIA_PARSER_FFMPEG: `${CHINESE_PATH}\\ffmpeg 程序\\ffmpeg.exe` };
  const options = managedPythonSpawnOptions({ cwd, logFd: 3, env, platform: 'win32' });
  assert.equal(options.cwd, cwd);
  assert.equal(options.env.MEDIA_PARSER_DATA_DIR, CHINESE_PATH);
  assert.equal(options.env.MEDIA_PARSER_FFMPEG, env.MEDIA_PARSER_FFMPEG);
  assert.equal(options.env, env);
});

test('the builder only returns spawn options and leaves argv to the caller', () => {
  const options = managedPythonSpawnOptions({ cwd: CHINESE_PATH, logFd: 4, env: ENV, platform: 'win32' });
  assert.deepEqual(Object.keys(options).sort(), ['cwd', 'detached', 'env', 'shell', 'stdio', 'windowsHide']);
  assert.equal('args' in options, false);
  assert.equal('argv' in options, false);
});

test('the default platform matches the running process', () => {
  const options = managedPythonSpawnOptions({ cwd: '.', logFd: 1, env: ENV });
  assert.equal(options.detached, process.platform !== 'win32');
  assert.equal(options.windowsHide, true);
  assert.equal(options.shell, false);
});
