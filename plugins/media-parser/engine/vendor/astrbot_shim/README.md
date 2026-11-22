"""AstrBot 运行时垫片（非官方实现）。

上游 `core/` 里有四个模块在导入期依赖 AstrBot（`message_adapter/node_builder.py`、
`message_adapter/sender.py`、`interaction/*`）。本目录只提供这些模块**导入期**需要的
最小符号，让上游 `core/` 可以原样拷贝、不改成一行代码地跑在普通 Python 进程里。

设计约束：
- 不模拟 AstrBot 的收发行为，只做「数据容器」：组件记住自己的来源（本地路径或 URL），
  由 `to_segment()` 一次性翻译成 OneBot v11 消息段。
- 只有 QQ 适配层会读这些容器，解析器、下载器完全不知道它们的存在。
"""
