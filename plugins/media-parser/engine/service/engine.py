"""解析引擎：链接 → 元数据 → 本地媒体 → 投递计划。

对应上游 `main.py` 的 `auto_parse` 主流程，去掉 AstrBot 事件与会话概念，
把「发送」替换为可序列化的投递计划。解析、下载、限流、翻译全部复用上游实现。
"""

from __future__ import annotations

import asyncio
import copy
import os
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from . import paths

paths.install()

import aiohttp  # noqa: E402

from core.config_manager import ConfigManager  # noqa: E402
from core.constants import Config  # noqa: E402
from core.downloader import DownloadManager  # noqa: E402
from core.logger import logger  # noqa: E402
from core.message_adapter.archive_builder import (  # noqa: E402
    ArchiveSizeLimitError,
    build_zip_archive,
    cleanup_expired_zip_workspaces,
)
from core.message_adapter.node_builder import (  # noqa: E402
    build_all_nodes,
    build_translation_nodes_for_all,
    collect_text_metadata,
    strip_text_metadata_nodes,
)
from core.message_adapter.text_renderer import (  # noqa: E402
    ensure_render_fonts,
    render_text_metadata_images,
)
from core.metadata_state import refresh_media_state  # noqa: E402
from core.parser import ParserManager  # noqa: E402
from core.storage import (  # noqa: E402
    ParseRecordManager,
    cleanup_expired_marked_in,
    cleanup_files,
    cleanup_marked_in,
    mark_files_expire_after,
)
from core.translation import MetadataTranslator  # noqa: E402

from .config import QQSettings  # noqa: E402
from .cache import CacheGuard  # noqa: E402
from .delivery import (  # noqa: E402
    DeliveryPlan,
    OutgoingMessage,
    build_plan,
    prepend_opening,
)


class ParseError(RuntimeError):
    """可展示给用户的解析失败。"""


@dataclass
class ParseOutcome:
    """一次解析请求的结果。"""

    plan: DeliveryPlan = field(default_factory=DeliveryPlan)
    metadata: List[Dict[str, Any]] = field(default_factory=list)
    links: List[str] = field(default_factory=list)
    blocked: List[Dict[str, Any]] = field(default_factory=list)
    skipped: List[Dict[str, Any]] = field(default_factory=list)
    elapsed_ms: int = 0

    @property
    def has_content(self) -> bool:
        return bool(self.plan.messages)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "ok": True,
            "elapsedMs": self.elapsed_ms,
            "links": self.links,
            "blocked": self.blocked,
            "skipped": self.skipped,
            "plan": self.plan.to_dict(),
            "items": [self._summarize(item) for item in self.metadata],
        }

    @staticmethod
    def _summarize(metadata: Dict[str, Any]) -> Dict[str, Any]:
        """给调用方（和模型）看的精简结果。"""
        return {
            "url": metadata.get("url"),
            "platform": metadata.get("platform"),
            "title": metadata.get("title"),
            "author": metadata.get("author"),
            "timestamp": metadata.get("timestamp"),
            "desc": (metadata.get("desc") or "")[:200],
            "error": metadata.get("error"),
            "videoCount": metadata.get("video_count", 0),
            "imageCount": metadata.get("image_count", 0),
            "audioCount": metadata.get("audio_count", 0),
            "hotCommentCount": len(metadata.get("hot_comments") or []),
            "videoModes": metadata.get("video_modes") or [],
            "imageModes": metadata.get("image_modes") or [],
            "audioModes": metadata.get("audio_modes") or [],
            "videoSkipReasons": [r for r in (metadata.get("video_skip_reasons") or []) if r],
            "imageSkipReasons": [r for r in (metadata.get("image_skip_reasons") or []) if r],
            "audioSkipReasons": [r for r in (metadata.get("audio_skip_reasons") or []) if r],
            "hasValidMedia": metadata.get("has_valid_media", False),
            "translated": bool(metadata.get("_translated_fields")),
        }


class MediaEngine:
    """无框架依赖的解析引擎。"""

    def __init__(self, cfg: ConfigManager, settings: QQSettings):
        self.cfg = cfg
        self.settings = settings
        self.parser_manager = ParserManager(cfg.create_parsers())
        self.download_manager = DownloadManager(
            max_video_size_mb=cfg.download.max_video_size_mb,
            max_audio_size_mb=cfg.download.max_audio_size_mb,
            large_video_threshold_mb=cfg.download.large_video_threshold_mb,
            cache_dir=cfg.download.cache_dir,
            cache_dir_available=cfg.download.cache_dir_available,
            max_concurrent_downloads=cfg.download.max_concurrent_downloads,
            video_cover_only=cfg.message.media_display.video_cover_only,
            readme_paginate=cfg.message.text_metadata.render_paginate,
        )
        self.translator = MetadataTranslator(cfg.translation, None)
        self.record_manager = ParseRecordManager(
            record_file=cfg.parse_rate_limit.record_file,
            same_link_max_count=cfg.parse_rate_limit.same_link.max_count,
            same_link_window_seconds=cfg.parse_rate_limit.same_link.window_seconds,
            same_user_max_count=cfg.parse_rate_limit.same_user.max_count,
            same_user_window_seconds=cfg.parse_rate_limit.same_user.window_seconds,
        )
        self._session: Optional[aiohttp.ClientSession] = None
        self._parse_semaphore = asyncio.Semaphore(Config.PARSER_MAX_CONCURRENT)
        self._avatar_lock = asyncio.Lock()
        self._cleanup_task: Optional[asyncio.Task] = None
        self._fonts_ready = False
        self._active_flows = 0
        self.cache = CacheGuard(
            settings.cache_dir,
            ttl_seconds=settings.cache_ttl_seconds,
            max_bytes=settings.cache_max_bytes,
        )

    # ── 生命周期 ────────────────────────────────────────

    async def start(self) -> None:
        """准备 HTTP 会话、字体与后台清理任务。"""
        if self._session is None or self._session.closed:
            timeout = aiohttp.ClientTimeout(total=Config.DEFAULT_TIMEOUT)
            self._session = aiohttp.ClientSession(timeout=timeout)
        if self.cfg.message.text_metadata.render_to_image and not self._fonts_ready:
            try:
                await ensure_render_fonts(
                    self.cfg.message.text_metadata.render_font_family,
                    self.cfg.proxy.font_proxy_url(),
                )
                self._fonts_ready = True
            except (RuntimeError, OSError) as exc:
                logger.warning(f"字体补全失败，文本图片渲染将回退原文本: {exc}")
        if self._cleanup_task is None or self._cleanup_task.done():
            self._cleanup_task = asyncio.create_task(self._cleanup_loop())

    async def close(self) -> None:
        """释放资源。"""
        if self._cleanup_task and not self._cleanup_task.done():
            self._cleanup_task.cancel()
            await asyncio.gather(self._cleanup_task, return_exceptions=True)
        self._cleanup_task = None
        await self.download_manager.shutdown()
        if self._session and not self._session.closed:
            await self._session.close()

    @property
    def session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            timeout = aiohttp.ClientTimeout(total=Config.DEFAULT_TIMEOUT)
            self._session = aiohttp.ClientSession(timeout=timeout)
        return self._session

    async def _cleanup_loop(self) -> None:
        """按过期标记回收媒体缓存，避免 QQ 侧发完后长期占盘。"""
        ttl = max(60, int(self.settings.cache_ttl_seconds))
        interval = max(60, min(ttl, 600))
        try:
            while True:
                await asyncio.sleep(interval)
                if self._active_flows:
                    continue
                cache_dir = self.cfg.download.cache_dir
                try:
                    if cache_dir:
                        self.cache.clean(busy=bool(self._active_flows))
                except OSError as exc:
                    logger.warning(f"清理过期媒体缓存失败: {exc}")
        except asyncio.CancelledError:
            raise

    # ── 平台信息 ────────────────────────────────────────

    def platform_list(self) -> List[Dict[str, Any]]:
        """返回已启用平台及其输出模式。"""
        items: List[Dict[str, Any]] = []
        for parser in self.parser_manager.parsers:
            text_enabled, rich_enabled = self.cfg.parser_output.output_for_controller(
                parser.name
            )
            items.append(
                {
                    "name": parser.name,
                    "text": text_enabled,
                    "richMedia": rich_enabled,
                    "hotComments": getattr(parser, "hot_comment_count", 0),
                }
            )
        return items

    # ── 主流程 ──────────────────────────────────────────

    async def parse(self, text: str, **kwargs) -> ParseOutcome:
        """Protect downloads from manual and scheduled cache maintenance."""
        self._active_flows += 1
        try:
            return await self._parse(text, **kwargs)
        finally:
            self._active_flows = max(0, self._active_flows - 1)

    async def _parse(
        self,
        text: str,
        *,
        user_key: str = "",
        sender_name: str = "解析结果",
        sender_id: Any = "0",
        quote_id: str = "",
        quote_first_text: bool = False,
        limit: Optional[int] = None,
    ) -> ParseOutcome:
        """解析一段文本中的所有受支持链接并生成投递计划。"""
        started = time.monotonic()
        outcome = ParseOutcome()
        cfg = self.cfg

        if not cfg.parser_output.has_any_output():
            raise ParseError("所有平台的文本与富媒体输出均已关闭")

        links_with_parser = self.parser_manager.extract_all_links(text or "")
        if not links_with_parser:
            raise ParseError("没有识别到受支持的链接")

        enabled_links: List[Tuple[str, Any]] = []
        for link, parser in links_with_parser:
            if cfg.parser_output.controller_has_any_output(getattr(parser, "name", "")):
                enabled_links.append((link, parser))
            else:
                outcome.skipped.append({"url": link, "reason": "该平台输出已关闭"})
        links_with_parser = enabled_links
        if not links_with_parser:
            raise ParseError("链接所属平台的输出均已关闭")

        max_links = limit or self.settings.max_links_per_message
        if len(links_with_parser) > max_links:
            for link, _ in links_with_parser[max_links:]:
                outcome.skipped.append({"url": link, "reason": "超过单条消息解析上限"})
            links_with_parser = links_with_parser[:max_links]

        if self.record_manager.enabled:
            links_with_parser, blocked = await asyncio.to_thread(
                self.record_manager.filter_links,
                links_with_parser,
                user_key=user_key,
            )
            outcome.blocked = [
                {"url": item.link, "reason": item.reason, "parser": item.parser_name}
                for item in blocked
            ]
            if not links_with_parser:
                raise ParseError("链接触发了解析频率限制，请稍后再试")

        outcome.links = [link for link, _ in links_with_parser]
        logger.debug(f"开始解析 {len(links_with_parser)} 条链接")

        async with self._parse_semaphore:
            metadata_list = await self.parser_manager.parse_text(
                text, self.session, links_with_parser=links_with_parser
            )
        if self.record_manager.same_link.enabled:
            await asyncio.to_thread(self.record_manager.record_metadata_links, metadata_list)

        if not metadata_list:
            raise ParseError("链接没有解析出任何内容")

        self._apply_output_flags(metadata_list)
        if not any(self._has_output_candidate(item) for item in metadata_list):
            raise ParseError("解析结果在当前输出策略下没有可发送内容")

        self._active_flows += 1
        try:
            translation_task, translation_metadata = self._start_translation(metadata_list)
            try:
                processed = await self._download_all(metadata_list)
                build_result = build_all_nodes(
                    processed,
                    cfg.download.large_video_threshold_mb,
                    cfg.download.max_video_size_mb,
                    True,
                    True,
                    audio_send_mode=cfg.message.media_display.audio_send_mode,
                    interleave_images=cfg.message.media_display.interleave_images,
                )
                translation_nodes = await self._finish_translation(
                    translation_task, translation_metadata
                )
                if not build_result.all_link_nodes and not any(translation_nodes):
                    raise ParseError("解析完成，但没有可发送的内容（可能下载失败或媒体不可访问）")

                text_images, pre_messages = await self._render_text_metadata(
                    build_result, translation_nodes
                )
                outcome.plan = build_plan(
                    build_result,
                    translation_nodes,
                    cfg,
                    sender_name=sender_name,
                    sender_id=sender_id,
                    quote_id=quote_id,
                    quote_first_text=quote_first_text,
                    text_metadata_images=text_images,
                    pre_messages=pre_messages,
                )
                opening = cfg.message.opening
                if opening.enabled:
                    prepend_opening(outcome.plan, opening.content)
                outcome.metadata = processed
                self._mark_for_cleanup(processed, build_result)
            finally:
                await self._cancel_translation(translation_task)
        finally:
            self._active_flows = max(0, self._active_flows - 1)

        outcome.elapsed_ms = int((time.monotonic() - started) * 1000)
        return outcome

    # ── 输出策略 ────────────────────────────────────────

    def _apply_output_flags(self, metadata_list: List[Dict[str, Any]]) -> None:
        for metadata in metadata_list:
            text_enabled, rich_enabled = self.cfg.parser_output.output_for_metadata(
                metadata
            )
            metadata["_enable_text_metadata"] = text_enabled
            metadata["_enable_rich_media"] = rich_enabled
            metadata["_text_metadata_fields"] = (
                self.cfg.message.text_metadata.visibility()
            )

    @staticmethod
    def _has_text_metadata(metadata: Dict[str, Any]) -> bool:
        fields = metadata.get("_text_metadata_fields")
        if not isinstance(fields, dict):
            fields = {}
        candidates = (
            ("title", "title"),
            ("author", "author"),
            ("description", "desc"),
            ("timestamp", "timestamp"),
            ("original_link", "url"),
        )
        return any(
            bool(fields.get(field_name, True))
            and bool(str(metadata.get(metadata_key) or "").strip())
            for field_name, metadata_key in candidates
        )

    def _has_output_candidate(self, metadata: Dict[str, Any]) -> bool:
        if metadata.get("error"):
            return True
        text_enabled = bool(metadata.get("_enable_text_metadata", True))
        rich_enabled = bool(metadata.get("_enable_rich_media", True))
        has_media = any(
            metadata.get(key)
            for key in ("video_urls", "image_urls", "audio_urls", "readme_url")
        )
        has_text = (
            self._has_text_metadata(metadata)
            or bool(metadata.get("access_message"))
            or bool(metadata.get("hot_comments"))
        )
        return bool((rich_enabled and has_media) or (text_enabled and has_text))

    # ── 下载 ────────────────────────────────────────────

    async def _download_all(self, metadata_list: List[Dict[str, Any]]):
        any_rich = any(
            bool(metadata.get("_enable_rich_media", True)) for metadata in metadata_list
        )
        if not any_rich:
            return list(metadata_list)

        async def process_one(metadata: Dict[str, Any]) -> Dict[str, Any]:
            if metadata.get("error") or not metadata.get("_enable_rich_media", True):
                return metadata
            try:
                return await self.download_manager.process_metadata(
                    self.session,
                    metadata,
                    proxy_addr=self.cfg.proxy.address,
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - 单链接失败不影响其它链接
                logger.exception(f"处理元数据失败: {metadata.get('url', '')}: {exc}")
                metadata["error"] = str(exc)
                refresh_media_state(metadata)
                return metadata

        return list(
            await asyncio.gather(*(process_one(item) for item in metadata_list))
        )

    # ── 翻译 ────────────────────────────────────────────

    def _start_translation(self, metadata_list: List[Dict[str, Any]]):
        if not self.cfg.translation.enabled:
            return None, []
        copied = copy.deepcopy(metadata_list)
        task = asyncio.create_task(self.translator.translate_metadata_list(copied))
        return task, copied

    async def _finish_translation(self, task, translation_metadata):
        if task is None:
            return []
        try:
            await task
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - 翻译失败不影响主体
            logger.warning(f"翻译失败，跳过翻译节点: {exc}")
            return []
        return build_translation_nodes_for_all(translation_metadata)

    @staticmethod
    async def _cancel_translation(task) -> None:
        if task is None or task.done():
            return
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    # ── 文本图片 ────────────────────────────────────────

    async def _render_text_metadata(self, build_result, translation_nodes):
        """把非原文顺序的文本渲染成图片；失败时保留原文本节点。"""
        cfg = self.cfg
        if not getattr(cfg.message.text_metadata, "render_to_image", False):
            return [], []

        rendered = [meta for meta in build_result.link_metadata if not meta.get("preserve_order")]
        nodes = [meta["link_nodes"] for meta in rendered]
        text = collect_text_metadata(nodes, translation_nodes)
        if not text:
            return [], []

        cache_root = str(cfg.download.cache_dir or "").strip() or os.getcwd()
        image_dir = os.path.join(cache_root, "rendered_text")
        os.makedirs(image_dir, exist_ok=True)
        image_path = os.path.join(image_dir, f"metadata_{uuid.uuid4().hex}.png")
        try:
            pages = await render_text_metadata_images(
                text,
                image_path,
                style=cfg.message.text_metadata.render_style,
                font_family=cfg.message.text_metadata.render_font_family,
                font_size=cfg.message.text_metadata.render_font_size,
                line_spacing=cfg.message.text_metadata.render_line_spacing,
                paragraph_spacing=cfg.message.text_metadata.render_paragraph_spacing,
                paginate=cfg.message.text_metadata.render_paginate,
                font_proxy_url=cfg.proxy.font_proxy_url(),
            )
        except (ImportError, OSError, RuntimeError, ValueError, asyncio.TimeoutError) as exc:
            logger.warning(f"文本元数据图片渲染失败，保留原文本节点: {exc}")
            return [], []

        strip_text_metadata_nodes(nodes, translation_nodes)
        for meta in rendered:
            meta["metadata_text_node"] = None
        return pages, []

    # ── 清理 ────────────────────────────────────────────

    def _mark_for_cleanup(self, metadata_list: List[Dict[str, Any]], build_result) -> None:
        """给本次产生的新文件打过期标记，交给后台任务回收。"""
        files: List[str] = []
        seen = set()
        for metadata in metadata_list:
            for path in metadata.get("file_paths") or []:
                text = str(path or "").strip()
                if text and text not in seen:
                    seen.add(text)
                    files.append(text)
        for path in (*build_result.temp_files, *build_result.video_files):
            text = str(path or "").strip()
            if text and text not in seen:
                seen.add(text)
                files.append(text)
        if files:
            try:
                safe_files = [str(self.cache.checked(item)) for item in files]
                mark_files_expire_after(safe_files, self.settings.cache_ttl_seconds)
            except (OSError, ValueError) as exc:
                logger.warning(f"写入媒体过期标记失败: {exc}")

    # ── 归档 ────────────────────────────────────────────

    async def build_archive(self, text: str, *, user_key: str = "") -> Tuple[str, Dict[str, Any]]:
        """按引用消息构建 ZIP 归档，返回文件路径与摘要。"""
        outcome = await self.parse(text, user_key=user_key, limit=20)
        if not outcome.metadata:
            raise ParseError("没有可归档的解析结果")
        translated = None
        if self.cfg.translation.enabled:
            translated = copy.deepcopy(outcome.metadata)
            try:
                await self.translator.translate_metadata_list(translated)
            except Exception as exc:  # noqa: BLE001
                logger.warning(f"归档翻译失败，忽略翻译内容: {exc}")
                translated = None
        try:
            path = await asyncio.to_thread(
                build_zip_archive,
                outcome.metadata,
                translated_metadata_list=translated,
                output_dir=self.cfg.download.cache_dir,
                max_total_bytes=int(self.settings.archive_max_total_mb * 1024 * 1024),
            )
        except ArchiveSizeLimitError as exc:
            raise ParseError(f"归档超出大小限制: {exc}") from exc
        return path, {
            "items": [ParseOutcome._summarize(item) for item in outcome.metadata],
            "messages": len(outcome.plan.messages),
            "opening": (
                self.cfg.message.opening.archive_content
                if self.cfg.message.opening.enabled
                else ""
            ),
        }

    # ── 维护 ────────────────────────────────────────────

    async def clean_cache(self) -> Dict[str, int]:
        """Never remove pinned files or files used by an active parse."""
        return self.cache.clean(all_files=True, busy=bool(self._active_flows))

    async def clean_files(self, files: List[str]) -> Dict[str, int]:
        if self._active_flows:
            return {"files": 0, "pinned": len(files), "failed": 0, "busy": True}
        return self.cache.remove_files(files)
