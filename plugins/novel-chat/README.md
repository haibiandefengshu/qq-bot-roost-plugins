# 小说对话（novel-chat）

原生 Roost 插件，只注册一个顶层命令 `/小说`。

它负责：

1. 把用户命令或明确发送给机器人的填写消息交给 `novel-writer`；
2. 从真实 `msg` 与经过校验的 `ctx.dataDir` 机器人编号派生签名 QQ 身份，
   通过本机回环签名传输调用已选举的小说 worker；
3. 在后台轮询任务，先校验该身份下的认证输出路径，再把扩展登记的成果以
   `replyFile` 发送；
4. 发送时禁用未授权主动降级，失败则转为 `/小说 领取`。

它不保存书库、不解析私人编号、不接受任意用户文件路径，也不信任消息正文
中的身份字段。管理员可在插件配置 `bridgeDir` 显式指定小说扩展数据目录；
留空时按 `<DSH data>/roost/data/bots/<bot>/plugins/novel-chat` 布局自动推导
到 `<DSH data>/extension-data/novel-writer`。

任务监听 ID 在启动轮询前会去重。所有监听定时器登记在 `ctx.onTeardown`
中，拆除后迟到轮询既不会回复也不会继续调度。
