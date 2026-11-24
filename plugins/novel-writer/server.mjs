#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const extensionRoot = dirname(fileURLToPath(import.meta.url));

const version = JSON.parse(
  readFileSync(new URL('./plugin.json', import.meta.url), 'utf8'),
).version;
const TOOLS = Object.freeze([
  {
    name: 'novel_help',
    description: '查看 QQ 小说插件的用法摘要。不会读取任何私人书籍或用户数据。',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['总览', '书库', '设定', '创作', '文件', '朗读', '任务'],
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'novel_capabilities',
    description: '检查小说扩展入口、配置和共享 FFmpeg 依赖状态。不会接收或返回用户 ID、书号、路径或正文。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]);

const HELP = {
  总览: '在 QQ / 私聊发送 /小说。新建 → 填写资料 → 续写 → 收 TXT → 按需朗读。填写中可用 完成/跳过/上一步/暂停/取消。',
  书库: '/小说 新建 [书名]、书架、打开 <编号>、删除 <编号>。书库按机器人＋会话＋用户隔离。',
  设定: '/小说 设定、人设、大纲；人设卡支持身份、外貌、性格、关系、目标、冲突、秘密、弧光和语言风格。',
  创作: '/小说 续写 [剧情要求]；支持 1–3 章和 1000–5000 字。另有目录、重写、修改、查找。',
  文件: '/小说 发送 [最新/章号/范围/全本]、版本、恢复、导入、备份。',
  朗读: '/小说 朗读 [最新/章号/范围]；手动最多 3 章，支持官方语音和语音回复扩展。',
  任务: '/小说 任务、停止、重试、领取。',
};

function readConfig() {
  try {
    const raw = JSON.parse(String(process.env.ROOST_EXT_CONFIG || '{}'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}

function dependenciesDir() {
  const explicit = String(process.env.ROOST_DEPS_DIR || '').trim();
  if (explicit) return resolve(explicit);
  let dshRoot = '';
  if (basename(extensionRoot) === 'novel-writer'
      && basename(dirname(extensionRoot)) === 'extensions') {
    dshRoot = dirname(dirname(extensionRoot));
  }
  if (!dshRoot) {
    const dataDir = String(process.env.NOVEL_WRITER_DATA_DIR || '').trim();
    if (dataDir) {
      const parent = dirname(resolve(dataDir));
      dshRoot = basename(parent) === 'extension-data' ? dirname(parent) : parent;
    }
  }
  return dshRoot ? join(dshRoot, 'deps') : '';
}

function platformDependencyDir() {
  if (process.platform === 'win32') return `win32-${process.arch}`;
  if (process.platform === 'darwin') return `darwin-${process.arch}`;
  if (process.platform === 'linux') return `linux-${process.arch}`;
  return '';
}

function managedFfmpegPresent() {
  const deps = dependenciesDir();
  if (!deps) return false;
  const base = join(deps, 'node_modules', '@ffmpeg-installer');
  const names = process.platform === 'win32'
    ? ['ffmpeg.exe', 'ffmpeg.cmd', 'ffmpeg.bat']
    : ['ffmpeg'];
  const exact = platformDependencyDir();
  if (exact) {
    const candidate = join(base, exact, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    if (existsSync(candidate)) return true;
    if (existsSync(join(base, exact, 'ffmpeg.exe'))) return true;
  }
  try {
    return readdirSync(base).some((name) => names.some((binary) => existsSync(join(base, name, binary))));
  } catch { return false; }
}

function systemFfmpegPresent() {
  const names = process.platform === 'win32'
    ? ['ffmpeg.exe', 'ffmpeg.cmd', 'ffmpeg.bat']
    : ['ffmpeg'];
  return String(process.env.PATH || process.env.Path || '')
    .split(delimiter)
    .map((dir) => dir.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
    .some((dir) => names.some((name) => existsSync(join(dir, name))));
}

function ffmpegPresent() {
  return managedFfmpegPresent() || systemFfmpegPresent();
}

const resultOf = (value, error = false) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
  isError: error,
});

export function createHandler() {
  return async (message) => {
    if (!message || message.id === undefined) return null;
    const { id, method, params = {} } = message;
    const result = (value) => ({ jsonrpc: '2.0', id, result: value });
    if (method === 'initialize') {
      return result({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'novel-writer', version },
      });
    }
    if (method === 'ping') return result({});
    if (method === 'tools/list') return result({ tools: TOOLS });
    if (method !== 'tools/call') return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
    if (params.name === 'novel_help') {
      const category = String(params.arguments?.category || '总览');
      return result(resultOf(HELP[category] || HELP.总览));
    }
    if (params.name === 'novel_capabilities') {
      if (params.arguments && Object.keys(params.arguments).length) return result(resultOf('能力检查不接受参数', true));
      const config = readConfig();
      return result(resultOf({
        extension: { installed: true, version, qqEntry: true, panelEntry: true, privateTools: false },
        config: {
          maxContextChars: Number(config.maxContextChars) || 18000,
          defaultChapterChars: Number(config.defaultChapterChars) || 3000,
          audioPartLimitMiB: Number(config.audioPartLimitMiB) || 16,
        },
        shared: { ffmpeg: ffmpegPresent() },
        note: '模型服务和两种语音来源的实际状态请在小说管理页或 /小说 朗读 状态查看。',
      }));
    }
    return result(resultOf('未知小说工具', true));
  };
}

function logWorker(message) {
  try { process.stderr.write(`[novel-writer] ${String(message).slice(0, 500)}\n`); } catch {}
}

function startWorkerLifecycle() {
  let worker = null;
  let retryTimer = null;
  let closing = false;

  const startWorker = async () => {
    if (closing) return;
    try {
      const { createWorkerRuntime } = await import('./lib/worker-runtime.mjs');
      if (closing) return;
      if (!worker) {
        worker = createWorkerRuntime({
          extensionRoot,
          env: process.env,
          get config() { return readConfig(); },
          log: logWorker,
        });
      }
      await worker.start();
    } catch (error) {
      logWorker(`小说 worker 初始化失败：${error?.message || error}`);
      if (!closing && !retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void startWorker();
        }, 1000);
        retryTimer.unref?.();
      }
    }
  };

  void startWorker();

  return {
    async close() {
      if (closing) return;
      closing = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      if (worker) await worker.close().catch((error) => logWorker(`关闭小说 worker 失败：${error?.message || error}`));
      worker = null;
    },
  };
}

function start() {
  const handle = createHandler();
  const lifecycle = startWorkerLifecycle();
  let buffer = '';
  let shuttingDown = false;
  const send = (value) => { if (value) process.stdout.write(`${JSON.stringify(value)}\n`); };
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await lifecycle.close();
  };
  const shutdownAndExit = () => {
    void shutdown().finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdownAndExit);
  process.once('SIGINT', shutdownAndExit);
  process.stdin.once('end', shutdownAndExit);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
      handle(message).then(send).catch(() => send({
        jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32603, message: 'Internal error' },
      }));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) start();
