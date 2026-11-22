# 源码来源与适配记录

插件：`media-parser`，版本 `0.1.0`，日期 2026-11-22。

## 原始来源

- 本次移植参考：本机已有的 QQA 版 `media-parser` 插件（版本 `1.0.1`）；本仓库不包含该安装路径与任何本机目录信息。
- 引擎上游标识：`drdon1234/astrbot_plugin_media_parser`，随原始包保留其源代码和 GNU Affero General Public License v3.0 许可证。
- Roost 本机接口参考：`demo-x`、`echo`、`src/plugin/context.js`、`src/message.js`、`src/outbound.js`、`src/onebot/voice.js`。没有复制或修改宿主实现。
- 本次没有取得或声称上游 Git commit。来源以这份本地归档及内容摘要为可复核基线，没有自动获取最新上游。

原始 `engine.tar.gz` 未修改，SHA-256：

```text
d75f10eba41d3c202696d3da7c5c5efce1135b39401fd4cf170075e37bba9c05
```

原包包含 119 个普通文件，其中 114 个 Python 源码文件。随包 `engine/vendor/core/` 和 `engine/vendor/astrbot_shim/` 保留原始内容，最终逐文件比对结果见测试报告。

## 新增 Roost 层

JS 入口、链接识别、队列、引擎托管、文件检查、有序发送、短语音兼容、管理页面及测试均位于插件目录。原 QQA `index.js`、`engine-host.js` 和 `plugin.json` 未作为 Roost 入口复用；本插件不实现 QQA 共用运行或配置迁移。

## Python service 适配

运行时从原始包安全解包，再覆盖本插件可审阅的 `engine/service/*.py` 和 `engine/run_engine.py`。服务源码摘要同时覆盖原始静态内容和覆盖层，用于就绪检测、身份核对和热重载复用。

主要适配内容：

- 强制回环监听和本地认证；增加服务、实例、插件版本与源码摘要。
- 共享截止时间、请求取消和子进程归属跟踪，Windows 子进程隐藏窗口。
- 将缓存、解析记录、字体和运行状态置于独立数据目录。
- 按真实路径检查的删除操作、缓存大小及保留期上限、解析和发送租约。
- 配置覆盖、200 MiB 有效上限、关闭自动引用和默认关闭翻译。
- 网络请求、DNS 连接地址与每次重定向检查；显式代理目标 IP 固定；凭据和日志脱敏。
- 在 service 层运行时适配 TikTok 抓页及视频封面中继；保留 `vendor/core` 的原文件。
- 在 service 层约束 ffmpeg 输入的路径、协议与格式，防止媒体伪装成联网清单。

`engine/config.example.json` 仅规范化换行符为 LF，不改变原始示例内容。托管有效配置由 JS 层生成，不会沿用原示例中的 300 MB 上限。

完整的原始／当前文件摘要、修改列表与测试报告随最终交付生成，见 `ENGINE-PROVENANCE.json`、`CHANGED-FILES.md` 和 `TEST-REPORT.md`。
