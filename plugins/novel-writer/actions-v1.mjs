import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { callTransport, resolveNovelPaths } from './lib/local-transport.mjs';

const extensionRoot = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('./plugin.json', import.meta.url), 'utf8'));
const version = String(manifest.version || '0');
const { createNovelService } = await import(`./lib/service.mjs?v=${version}`);

const services = new WeakMap();
const PANEL_TIMEOUT_MS = 180_000;

function serviceFor(novelRuntime, config, log) {
  if (!novelRuntime || novelRuntime.version !== 1) {
    throw new Error('宿主没有为 novel-writer 注入 1.4.0 小说运行能力，请确认宿主补丁已安装');
  }
  let service = services.get(novelRuntime);
  if (!service) {
    service = createNovelService({ runtime: novelRuntime, config, log });
    services.set(novelRuntime, service);
  }
  return service;
}

function pathsFor(env) {
  return resolveNovelPaths({ extensionRoot, env: env || process.env });
}

function workerAvailable(env) {
  const source = env || process.env;
  if (String(source.ROOST_API_URL || '').trim() && String(source.ROOST_API_TOKEN || '').trim()) {
    return true;
  }
  try { return existsSync(pathsFor(source).discoveryFile); } catch { return false; }
}

function wrap(fn) {
  return async (payload = {}, invocation = null) => {
    try {
      const value = await fn(payload && typeof payload === 'object' ? payload : {}, invocation);
      return { handled: true, ...(value && typeof value === 'object' ? value : { text: String(value ?? '') }) };
    } catch (error) {
      const text = `小说操作失败：${String(error?.message || error).slice(0, 500)}`;
      return { ok: false, handled: true, message: text, text };
    }
  };
}

export function createActions({
  config = {}, log = () => {}, novelRuntime = null, env = process.env,
} = {}) {
  const logger = typeof log === 'function' ? log : () => {};
  const service = () => serviceFor(novelRuntime, config, logger);
  const useWorker = () => workerAvailable(env);
  const transport = async (scope, action, payload, invocation) => await callTransport({
    dataDir: pathsFor(env).dataDir,
    scope,
    action,
    payload,
    ...(invocation === undefined ? {} : { invocation }),
    timeoutMs: PANEL_TIMEOUT_MS,
  });
  return {
    qq: wrap(async (payload, invocation) => {
      if (!invocation || invocation.source !== 'qq') {
        throw new Error('拒绝无可信消息身份的书库访问');
      }
      if (useWorker()) return await transport('qq', 'qq', payload, invocation);
      if (!novelRuntime) {
        throw new Error('新的 QQ 入口只接受原生消息桥接派生的可信身份，请通过 novel-chat 访问小说');
      }
      const owner = service().store.key(invocation);
      const op = String(payload.op || '').trim();
      if (op === 'watch') return await service().watch(owner, String(payload.taskId || ''), invocation);
      if (op === 'deliver') return await service().deliver(owner, payload);
      if (op === 'outbox') {
        const task = payload.taskId ? service().store.task(String(payload.taskId)) : null;
        const tasks = task ? [task] : service().store.tasksFor(owner);
        return await service().outboxFor(owner, tasks, invocation);
      }
      if (payload.direct === true) return await service().handleDirect(payload, invocation);
      return await service().handleQq(payload, invocation);
    }),
    panel: wrap(async (payload, invocation) => {
      if (!useWorker() && novelRuntime) {
        return await service().handlePanel(payload, invocation);
      }
      return await transport('panel', 'panel', payload);
    }),
  };
}
