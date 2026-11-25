# 小说/人设卡创作（novel-writer）

这是 Roost/DSH 的进程内业务扩展。原生插件 `novel-chat` 只负责接收
`/小说`、传递真实消息身份、轮询任务并把已登记成果作为普通文件发送。

1.2.0 起 MCP 进程会自动选举一个本机 worker（`lib/worker-runtime.mjs`），
只有领导者创建 `lib/public-runtime.mjs` 和 `NovelService`，并通过仅限回环
地址的签名 HTTP 传输服务 QQ 与管理页。无需先打开页面；MCP 进程退出时
会释放锁，另一个共享同一数据目录的 MCP 进程可接管且保留私人书库。

1.1.0 增加了完整人设卡和书库管理面板：

- 人设卡支持姓名、别名、身份、外貌、性格、关系、目标、冲突、秘密、
  人物弧光、语言风格和补充备注；
- 续写、重写和大纲生成会读取完整人设卡，旧版简化人物会自动补齐字段；
- 可以使用当前默认模型依据书稿生成人设卡候选，检查后才会落库；
- 本地已认证面板可以编辑书籍设定、大纲、人设卡和章节正文；
- 章节编辑保存为不可变新版本，并拒绝基于过期版本的覆盖；
- 面板可以管理官方语音或语音回复扩展方案、语速和自动朗读；
- 面板可以查看任务、恢复队列和安装共享 FFmpeg。

不同 QQ 群聊、私聊和用户仍使用独立书库。本机已认证管理页会显示这些隔离
书库的本地名称，并要求先选择要管理的书库；普通 MCP 工具仍没有入口。

## 入口边界

- `ui.actions` 只声明 `qq` 与 `panel`。
- 新路径的 `qq` 由原生 `novel-chat` 直接调用签名传输；宿主页面动作不会再
  接受浏览器提供的 QQ 身份，旧宿主仅在注入 1.4.0 `novelRuntime` 且宿主给出
  真实 QQ invocation 时保留兼容路径。
- 新路径的 `panel` 由页面动作代理到已选举 worker；传输层忽略请求体中的
  owner/source 声明，只构造已认证的面板身份。
- MCP 工具只暴露帮助与能力检查，不提供书籍读取、修改、导入或导出。
- 公共 API 使用 `agent:write`、`say:write`、`state:read`；预留的管理页共享
  依赖操作使用 `host:maintenance`。

## 数据

运行数据位于 `<DSH_DATA>/extension-data/novel-writer`，不写入代码目录：

- `owners/<owner-key>/library.json`：当前用户的书籍索引、设定和人设卡；
- `owners/<owner-key>/books/<book>/chapters/<chapter>/vNNNN.json`：不可变版本；
- `owners/<owner-key>/draft.json`：持久化填写草稿；
- `tasks/<task>.json`：输入快照、阶段、成果和投递状态；
- `outputs/`：TXT、JSON 备份与 MP3 文件；
- `work/`：可复用音频分段。

## 测试

```powershell
node --test test/*.mjs
```

以上命令覆盖本插件的完整测试套件（传输、worker、服务、面板、朗读与集成）。
`worker-integration.test.mjs` 会直接加载同仓库的兄弟插件目录 `plugins/novel-chat`，
因此运行完整套件时需要保留完整的市场布局；只单独拷贝本插件时相关跨组件断言不具备
运行条件。测试不需要私有宿主源码 checkout，也不需要安装额外依赖。

`server.mjs` 是由宿主启动的 MCP/stdio 入口，没有 `--help` 参数；直接运行会挂起等待 stdin。
手动排查请用 `node --test test/*.mjs`，或看宿主面板的扩展诊断信息。

模型测试属于模拟接口测试；真实模型、两种真实 TTS 后端和 QQ 客户端播放
必须在对应真机环境中另记验证结果。
