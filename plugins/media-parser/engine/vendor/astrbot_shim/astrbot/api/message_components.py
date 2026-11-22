"""消息组件垫片：以「数据容器」形式承载待发送内容。

每个组件只保留 OneBot v11 需要的字段，并提供 `to_segment()` 直接产出消息段。
上游 `node_builder.py` 的节点顺序、文本拼接、跳过原因等逻辑因此可以原样复用。
"""

from typing import Any, Dict, List, Optional


class _Component:
    """组件基类，记录来源与展示字段。"""

    kind = "unknown"

    def __init__(self, **kwargs: Any) -> None:
        self.data: Dict[str, Any] = dict(kwargs)
        for key, value in kwargs.items():
            setattr(self, key, value)

    def to_segment(self) -> Optional[Dict[str, Any]]:
        """转换为 OneBot v11 消息段；无法转换时返回 None。"""
        return None

    def __repr__(self) -> str:  # pragma: no cover - 仅调试用
        return f"<{type(self).__name__} {self.data}>"


class Plain(_Component):
    """纯文本组件。"""

    kind = "text"

    def __init__(self, text: str = "", **kwargs: Any) -> None:
        super().__init__(text=text, **kwargs)
        self.text = text

    def to_segment(self) -> Optional[Dict[str, Any]]:
        text = str(self.text or "")
        if not text.strip():
            return None
        return {"type": "text", "data": {"text": text}}


class _FileComponent(_Component):
    """带本地路径或 URL 的媒体组件基类。"""

    def __init__(
        self,
        file: str = "",
        url: str = "",
        *,
        from_url: bool = False,
        **kwargs: Any,
    ) -> None:
        super().__init__(file=file, url=url, from_url=from_url, **kwargs)
        self.file = file
        self.url = url
        self.from_url = from_url

    @classmethod
    def fromFileSystem(cls, path: str, **kwargs: Any):
        """使用本地文件构建组件（对齐 AstrBot 接口）。"""
        return cls(file=str(path), from_url=False, **kwargs)

    @classmethod
    def fromURL(cls, url: str, **kwargs: Any):
        """使用远端 URL 构建组件（对齐 AstrBot 接口）。"""
        return cls(file="", url=str(url), from_url=True, **kwargs)

    def resolve_reference(self) -> str:
        """返回可直接交给协议端的引用（URL 或本地绝对路径）。"""
        return self.url if self.from_url else self.file

    def to_segment(self) -> Optional[Dict[str, Any]]:
        reference = str(self.resolve_reference() or "").strip()
        if not reference:
            return None
        return {"type": self.kind, "data": {"file": reference}}


class Image(_FileComponent):
    """图片组件。"""

    kind = "image"


class Video(_FileComponent):
    """视频组件。"""

    kind = "video"


class Record(_FileComponent):
    """语音组件。"""

    kind = "record"


class File(_FileComponent):
    """文件组件（音频以原始文件发送时使用）。"""

    kind = "file"

    def to_segment(self) -> Optional[Dict[str, Any]]:
        reference = str(self.resolve_reference() or "").strip()
        if not reference:
            return None
        name = str(getattr(self, "name", "") or "").strip()
        data: Dict[str, Any] = {"file": reference}
        if name:
            data["name"] = name
        return {"type": "file", "data": data}


class Node(_Component):
    """合并转发内的单个节点。"""

    kind = "node"

    def __init__(
        self,
        name: str = "",
        uin: Any = "",
        content: Optional[List[Any]] = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(name=name, uin=uin, content=list(content or []), **kwargs)
        self.name = name
        self.uin = uin
        self.content = list(content or [])

    def to_node_payload(self) -> Dict[str, Any]:
        segments = [
            segment
            for segment in (node.to_segment() for node in self.content)
            if segment
        ]
        return {
            "type": "node",
            "data": {
                "name": str(self.name or "解析结果"),
                "uin": str(self.uin or "0"),
                "content": segments,
            },
        }


class Nodes(_Component):
    """合并转发容器。"""

    kind = "nodes"

    def __init__(self, nodes: Optional[List[Node]] = None, **kwargs: Any) -> None:
        super().__init__(nodes=list(nodes or []), **kwargs)
        self.nodes = list(nodes or [])


class Reply(_Component):
    """引用回复组件。"""

    kind = "reply"

    def __init__(self, id: str = "", **kwargs: Any) -> None:
        super().__init__(id=id, **kwargs)
        self.id = id

    def to_segment(self) -> Optional[Dict[str, Any]]:
        if not str(self.id or "").strip():
            return None
        return {"type": "reply", "data": {"id": str(self.id)}}


__all__ = [
    "Plain",
    "Image",
    "Video",
    "Record",
    "File",
    "Node",
    "Nodes",
    "Reply",
]
