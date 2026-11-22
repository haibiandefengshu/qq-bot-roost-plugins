"""投递计划：把上游构建好的消息节点翻译成 QQ 消息段计划。

上游的发送器（`core/message_adapter/sender.py`）依赖 AstrBot 的 `event.send`，
这里换成「先产出计划、再由 QQ 侧发送」，但聚合/分隔/引用/大媒体单独发送的
判定顺序与上游保持一致，便于逐项对照。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from . import paths

paths.install()

from core.message_adapter.node_builder import (  # noqa: E402
    is_pure_image_gallery,
    summarize_node_counts,
)

SEPARATOR = "-------------------------------------"

# 语音与文件不进入合并转发：部分客户端对转发内的音频支持不一致，
# 上游同样把这两类节点单独发送。
_STANDALONE_TYPES = {"record", "file"}


@dataclass
class OutgoingMessage:
    """一条待发送的 QQ 消息。"""

    kind: str = "segments"
    segments: List[Dict[str, Any]] = field(default_factory=list)
    nodes: List[Dict[str, Any]] = field(default_factory=list)
    quote_id: str = ""

    def to_dict(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"kind": self.kind}
        if self.kind == "forward":
            payload["nodes"] = self.nodes
        else:
            payload["segments"] = self.segments
        if self.quote_id:
            payload["quoteId"] = self.quote_id
        return payload


@dataclass
class DeliveryPlan:
    """一次解析请求的完整投递计划。"""

    messages: List[OutgoingMessage] = field(default_factory=list)
    aggregated: bool = False
    node_counts: Dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "messages": [message.to_dict() for message in self.messages],
            "aggregated": self.aggregated,
            "nodeCounts": self.node_counts,
        }


def node_to_segment(node: Any) -> Optional[Dict[str, Any]]:
    """把垫片组件翻译成 OneBot v11 消息段。"""
    converter = getattr(node, "to_segment", None)
    if not callable(converter):
        return None
    try:
        return converter()
    except (TypeError, ValueError):
        return None


def _split_media(nodes: List[Any]) -> tuple[List[Any], List[Any]]:
    """拆出可聚合节点与必须单独发送的音频/文件节点。"""
    aggregatable: List[Any] = []
    standalone: List[Any] = []
    for node in nodes:
        segment = node_to_segment(node)
        if segment and segment.get("type") in _STANDALONE_TYPES:
            standalone.append(node)
        else:
            aggregatable.append(node)
    return aggregatable, standalone


def _gallery_messages(nodes: List[Any], sender_name: str, sender_id: Any) -> List[OutgoingMessage]:
    """纯图集折叠：文字逐条发送，图片合并为一条。"""
    texts = [node for node in nodes if getattr(node, "kind", "") == "text"]
    images = [node for node in nodes if getattr(node, "kind", "") == "image"]
    messages: List[OutgoingMessage] = []
    for node in texts:
        segment = node_to_segment(node)
        if segment:
            messages.append(OutgoingMessage(segments=[segment]))
    if images:
        segments = [segment for segment in (node_to_segment(node) for node in images) if segment]
        if segments:
            messages.append(OutgoingMessage(segments=segments))
    return messages


def _is_standalone(node: Any) -> bool:
    segment = node_to_segment(node)
    return bool(segment and segment.get("type") in _STANDALONE_TYPES)


def _forward_nodes(
    link_metadata: List[dict],
    sender_name: str,
    sender_id: Any,
) -> List[Dict[str, Any]]:
    """按上游聚合顺序生成合并转发节点（音频/文件不进转发）。"""
    normal = [meta for meta in link_metadata if meta.get("is_normal", True)]
    normal = [meta for meta in normal if meta.get("link_nodes")]
    ordered_ids = {
        id(meta["link_nodes"]) for meta in normal if meta.get("preserve_order")
    }

    flat: List[Dict[str, Any]] = []
    for link_idx, meta in enumerate(normal):
        nodes = meta["link_nodes"]
        preserve_order = id(nodes) in ordered_ids
        if not preserve_order and is_pure_image_gallery(nodes):
            texts = [node for node in nodes if getattr(node, "kind", "") == "text"]
            images = [node for node in nodes if getattr(node, "kind", "") == "image"]
            for node in texts:
                segment = node_to_segment(node)
                if segment:
                    flat.append(_node_payload(sender_name, sender_id, [segment]))
            segments = [segment for segment in (node_to_segment(n) for n in images) if segment]
            if segments:
                flat.append(_node_payload(sender_name, sender_id, segments))
        else:
            for node in nodes:
                if _is_standalone(node):
                    continue
                segment = node_to_segment(node)
                if segment:
                    flat.append(_node_payload(sender_name, sender_id, [segment]))
        if link_idx < len(normal) - 1:
            flat.append(
                _node_payload(
                    sender_name,
                    sender_id,
                    [{"type": "text", "data": {"text": SEPARATOR}}],
                )
            )
    return flat


def _node_payload(
    sender_name: str, sender_id: Any, segments: List[Dict[str, Any]]
) -> Dict[str, Any]:
    return {
        "type": "node",
        "data": {
            "name": str(sender_name or "解析结果"),
            "uin": str(sender_id or "0"),
            "content": segments,
        },
    }


def build_plan(
    build_result,
    translation_nodes: List[List[Any]],
    cfg,
    *,
    sender_name: str = "解析结果",
    sender_id: Any = "0",
    quote_id: str = "",
    quote_first_text: bool = False,
    text_metadata_images: Optional[List[str]] = None,
    pre_messages: Optional[List[OutgoingMessage]] = None,
    opening_text: str = "",
) -> DeliveryPlan:
    """按上游发送语义生成投递计划。"""
    plan = DeliveryPlan()
    plan.messages.extend(pre_messages or [])

    for reference in text_metadata_images or []:
        plan.messages.append(
            OutgoingMessage(segments=[{"type": "image", "data": {"file": reference}}])
        )

    link_metadata = list(build_result.link_metadata)
    aggregatable_nodes = [
        meta["link_nodes"] for meta in link_metadata if meta.get("is_normal", True)
    ]
    aggregatable_nodes.extend(translation_nodes or [])
    counts = summarize_node_counts(aggregatable_nodes)
    plan.node_counts = counts
    should_aggregate = cfg.message.aggregation.should_aggregate_nodes(**counts)
    plan.aggregated = bool(should_aggregate)

    large_threshold = cfg.download.large_video_threshold_mb
    large_links = [meta for meta in link_metadata if meta.get("is_large_media", False)]
    normal_links = [meta for meta in link_metadata if not meta.get("is_large_media", False)]

    if should_aggregate:
        forward = _forward_nodes(normal_links, sender_name, sender_id)
        standalone: List[Any] = []
        for meta in normal_links:
            _, alone = _split_media(meta["link_nodes"])
            standalone.extend(alone)
        if forward:
            plan.messages.append(OutgoingMessage(kind="forward", nodes=forward))
        for node in standalone:
            segment = node_to_segment(node)
            if segment:
                plan.messages.append(OutgoingMessage(segments=[segment]))
    else:
        quoted = False
        for link_idx, meta in enumerate(normal_links):
            nodes = meta["link_nodes"]
            if not nodes:
                continue
            text_node = meta.get("metadata_text_node")
            if not meta.get("preserve_order") and is_pure_image_gallery(nodes):
                for message in _gallery_messages(nodes, sender_name, sender_id):
                    if (
                        quote_first_text
                        and quote_id
                        and not quoted
                        and any(seg.get("type") == "text" for seg in message.segments)
                    ):
                        message.quote_id = quote_id
                        quoted = True
                    plan.messages.append(message)
            else:
                for node in nodes:
                    segment = node_to_segment(node)
                    if not segment:
                        continue
                    message = OutgoingMessage(segments=[segment])
                    if quote_first_text and quote_id and not quoted and node is text_node:
                        message.quote_id = quote_id
                        quoted = True
                    plan.messages.append(message)
            if link_idx < len(normal_links) - 1:
                plan.messages.append(
                    OutgoingMessage(
                        segments=[{"type": "text", "data": {"text": SEPARATOR}}]
                    )
                )

    if large_links:
        threshold_mb = int(large_threshold) if large_threshold > 0 else 50
        plan.messages.append(
            OutgoingMessage(
                segments=[
                    {
                        "type": "text",
                        "data": {
                            "text": f"⚠️ 链接中包含超过{threshold_mb}MB的视频时将单独发送所有媒体"
                        },
                    }
                ]
            )
        )
        for link_idx, meta in enumerate(large_links):
            for node in meta["link_nodes"]:
                segment = node_to_segment(node)
                if segment:
                    plan.messages.append(OutgoingMessage(segments=[segment]))
            if link_idx < len(large_links) - 1:
                plan.messages.append(
                    OutgoingMessage(
                        segments=[{"type": "text", "data": {"text": SEPARATOR}}]
                    )
                )

    translation_items = [
        [node for node in nodes if node is not None] for nodes in (translation_nodes or [])
    ]
    translation_items = [nodes for nodes in translation_items if nodes]
    if translation_items:
        if should_aggregate:
            nodes_payload: List[Dict[str, Any]] = []
            for nodes in translation_items:
                for node in nodes:
                    segment = node_to_segment(node)
                    if segment:
                        nodes_payload.append(_node_payload(sender_name, sender_id, [segment]))
            if nodes_payload:
                plan.messages.append(OutgoingMessage(kind="forward", nodes=nodes_payload))
        else:
            for item_idx, nodes in enumerate(translation_items):
                for node in nodes:
                    segment = node_to_segment(node)
                    if segment:
                        plan.messages.append(OutgoingMessage(segments=[segment]))
                if item_idx < len(translation_items) - 1:
                    plan.messages.append(
                        OutgoingMessage(
                            segments=[{"type": "text", "data": {"text": SEPARATOR}}]
                        )
                    )

    return plan


def prepend_opening(plan: DeliveryPlan, opening_text: str) -> DeliveryPlan:
    """在有内容可发时补一条开场语（对应上游 on_sendable_media 的时机）。"""
    text = str(opening_text or "").strip()
    if not text or not plan.messages:
        return plan
    plan.messages.insert(0, OutgoingMessage(segments=[{"type": "text", "data": {"text": text}}]))
    return plan
