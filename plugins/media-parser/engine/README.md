# media-parser（QQ 适配版）

上游：[drdon1234/astrbot_plugin_media_parser](https://github.com/drdon1234/astrbot_plugin_media_parser) v1.11.3（AGPL-3.0）

本目录**原样保留**上游 `core/`（约 3.99 万行，31 个平台解析器、下载器、限流、翻译），
只把「AstrBot 运行时」替换成三样东西：

```
engine/  Python 服务：链接 → 元数据 → 本地媒体 → 投递计划（HTTP JSON）
js/      共享 JS：引擎客户端、QQ 发送、自动解析钩子
vendor/  上游 core 原样拷贝 + AstrBot 垫片（只为让 core 能 import）
```

## 为什么这么拆

上游是 AstrBot 插件：`@register` 注册、`AstrMessageEvent` 传消息、`event.send` 发结果。
本机的 QQ agent 是 qq-bridge + DSH，没有 AstrBot 的事件模型，但**解析逻辑本身与框架无关**
（`core/parser`、`core/downloader` 不 import astrbot）。所以：

- 解析/下载/限流：一行不改，直接复用；
- 消息构建：复用上游 `node_builder`，用垫片组件承载结果，再翻译成 OneBot 消息段；
- 发送：改由 QQ 侧（桥接钩子 / MCP 工具）完成。

好处是上游发新版本时，`vendor/core` 整目录替换即可，不需要重新移植。

## 目录

| 路径 | 作用 |
|---|---|
| `run_engine.py` | 启动入口，`--check` 只自检 |
| `service/config.py` | 配置解析（`qq` 段 + 上游同名配置段） |
| `service/engine.py` | 解析主流程（对应上游 `main.py::auto_parse`） |
| `service/delivery.py` | 节点 → OneBot 消息段的投递计划 |
| `service/server.py` | 本地 HTTP 接口（`/parse` `/archive` `/clean` `/health`） |
| `js/hook.js` | 桥接侧自动解析判定（白名单、冷却、去重、卡片） |
| `js/qq-send.js` | OneBot 发送（含合并转发降级、大小检查、限速） |
| `tests/` | 管道测试（图片/音频）、钩子测试 |
| `vendor/core` | 上游代码，保持原样 |
| `vendor/astrbot_shim` | AstrBot 垫片 |

## 快速验证

```bat
安装环境.bat
启动引擎.bat
```

另开窗口：

```bash
curl --noproxy "*" http://127.0.0.1:3199/health
```

自测：

```bash
.venv/Scripts/python.exe tests/test_pipeline.py   # 真实下载一张图 + 一段音频
node tests/test_hook.mjs                          # 钩子判定（不发 QQ）
```

## 许可

上游为 AGPL-3.0，本目录派生自上游，整体按 AGPL-3.0 分发（见 `LICENSE`）。
`vendor/core` 未做修改；`vendor/astrbot_shim` 与 `service/`、`js/` 是本适配层新增代码。
