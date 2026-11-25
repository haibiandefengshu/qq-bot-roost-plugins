"""配置加载：把 QQ 侧配置与上游解析配置合并成 ConfigManager 可消费的字典。

配置沿用上游 AstrBot 插件的键名（`parsers` / `trigger` / `message` / `download` ...），
这样熟悉原插件的人可以直接照搬；本适配层只额外增加一个 `qq` 段描述 QQ 侧行为。
"""

from __future__ import annotations

import copy
import json
import os
import ipaddress
import shutil
from dataclasses import dataclass, field
from typing import Any, Dict, List

from . import paths

paths.install()

from core.constants import Config as UpstreamConfig  # noqa: E402
from core.config_manager import ConfigManager  # noqa: E402
from core.downloader.utils import check_cache_dir_available  # noqa: E402


DEFAULT_QQ: Dict[str, Any] = {
    "host": "127.0.0.1",
    "port": 3199,
    "token": "",
    "cacheDir": "",
    "autoParse": True,
    "privateChat": True,
    "groups": [],
    "requireAt": False,
    "maxLinksPerMessage": 3,
    "replyOnParse": True,
    "cacheTtlSeconds": 1800,
    "send": {
        "maxPerMinute": 20,
        "delayMs": 600,
        "maxFileSizeMb": 200,
    },
    "archive": {
        "command": "解析归档",
        "maxTotalSizeMb": 512,
    },
}


@dataclass
class QQSettings:
    """QQ 侧运行参数（与解析能力无关的传输层配置）。"""

    host: str = "127.0.0.1"
    port: int = 3199
    token: str = ""
    cache_dir: str = ""
    auto_parse: bool = True
    private_chat: bool = True
    groups: List[str] = field(default_factory=list)
    require_at: bool = False
    max_links_per_message: int = 3
    reply_on_parse: bool = True
    max_sends_per_minute: int = 20
    send_delay_ms: int = 600
    max_file_size_mb: float = 200.0
    cache_ttl_seconds: int = 1800
    ffmpeg_path: str = ""
    archive_command: str = "解析归档"
    archive_max_total_mb: float = 512.0
    cache_max_bytes: int = 2 * 1024 * 1024 * 1024
    max_request_seconds: int = 300
    max_active_requests: int = 2

    def allows(self, kind: str, target_id: Any) -> bool:
        """判断该会话是否允许自动解析。"""
        if kind == "private":
            return self.private_chat
        return str(target_id) in {str(item) for item in self.groups}


def _deep_merge(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    """递归合并字典，override 优先。"""
    result = copy.deepcopy(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def _as_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _as_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "on", "是", "开"}:
        return True
    if text in {"0", "false", "no", "off", "否", "关"}:
        return False
    return default


def _env_port(default: int) -> int:
    """允许宿主用环境变量指定端口。

    插件拿到的引擎地址（engineUrl）和引擎实际 bind 的端口必须是同一个，
    否则会出现「插件以为在 3199、引擎却起在别处」的错位。
    """
    raw = os.environ.get("MEDIA_PARSER_PORT", "").strip()
    if raw.isdigit() and 0 < int(raw) < 65536:
        return int(raw)
    return default


def parse_qq_settings(raw: Dict[str, Any], base_dir: str) -> QQSettings:
    """把 `qq` 段解析为 QQSettings。"""
    section = raw if isinstance(raw, dict) else {}
    send = section.get("send") if isinstance(section.get("send"), dict) else {}
    archive = section.get("archive") if isinstance(section.get("archive"), dict) else {}

    cache_dir = str(section.get("cacheDir") or "").strip()
    if not cache_dir:
        cache_dir = os.path.join(base_dir, UpstreamConfig.CACHE_DIR_NAME)
    cache_dir = os.path.realpath(os.path.abspath(cache_dir))

    groups: List[str] = []
    for item in section.get("groups") or []:
        text = str(item).strip()
        if text:
            groups.append(text)

    host = str(section.get("host") or "127.0.0.1").strip()
    try:
        if not ipaddress.ip_address(host).is_loopback:
            raise ValueError("Engine host must be a loopback address")
    except ValueError as exc:
        raise ValueError("Engine host must be a loopback IP address") from exc
    token = str(
        os.environ.get("MEDIA_PARSER_TOKEN") or section.get("token") or ""
    ).strip()
    return QQSettings(
        host=host,
        port=_env_port(_as_int(section.get("port"), 3199)),
        token=token,
        cache_dir=cache_dir,
        auto_parse=_as_bool(section.get("autoParse"), True),
        private_chat=_as_bool(section.get("privateChat"), True),
        groups=groups,
        require_at=_as_bool(section.get("requireAt"), False),
        max_links_per_message=max(1, _as_int(section.get("maxLinksPerMessage"), 3)),
        reply_on_parse=_as_bool(section.get("replyOnParse"), True),
        max_sends_per_minute=max(0, _as_int(send.get("maxPerMinute"), 20)),
        send_delay_ms=max(0, _as_int(send.get("delayMs"), 600)),
        max_file_size_mb=max(0.0, _as_float(send.get("maxFileSizeMb"), 200.0)),
        cache_ttl_seconds=max(60, _as_int(section.get("cacheTtlSeconds"), 1800)),
        ffmpeg_path=str(section.get("ffmpegPath") or "").strip(),
        archive_command=str(archive.get("command") or "解析归档").strip(),
        archive_max_total_mb=max(1.0, _as_float(archive.get("maxTotalSizeMb"), 512.0)),
        cache_max_bytes=max(1048576, _as_int(section.get("cacheMaxBytes"), 2147483648)),
        max_request_seconds=max(1, min(900, _as_int(section.get("maxRequestSeconds"), 300))),
        max_active_requests=max(1, min(8, _as_int(section.get("maxActiveRequests"), 2))),
    )


def load_raw_config(path: str) -> Dict[str, Any]:
    """读取配置文件；文件不存在时返回空字典（全部走上游默认值）。"""
    if not path or not os.path.isfile(path):
        return {}
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"配置文件必须是 JSON 对象: {path}")
    return data


def ensure_ffmpeg(settings: QQSettings, base_dir: str) -> str:
    """确保 ffmpeg 可被上游以裸命令调用，返回最终使用的路径（找不到时为空）。

    上游在 DASH 合并、音频转码、图片格式转换里直接调用 `ffmpeg`，因此这里把它所在
    目录补进 PATH；不做全局安装、不写注册表。
    """
    candidates = []
    if settings.ffmpeg_path:
        candidates.append(settings.ffmpeg_path)
    env_path = os.environ.get("MEDIA_PARSER_FFMPEG", "").strip()
    if env_path:
        candidates.append(env_path)
    found = shutil.which("ffmpeg")
    if found:
        candidates.append(found)

    for candidate in candidates:
        path = os.path.abspath(candidate)
        if path and os.path.isfile(path):
            folder = os.path.dirname(path)
            current = os.environ.get("PATH", "")
            entries = current.split(os.pathsep)
            if folder not in entries:
                os.environ["PATH"] = folder + os.pathsep + current
            settings.ffmpeg_path = path
            return path
    return ""


def build_engine_config(raw: Dict[str, Any], settings: QQSettings) -> ConfigManager:
    """构造 ConfigManager，并把缓存目录切到 QQ 侧指定路径。

    上游在非 Docker 环境会强制使用 AstrBot 插件数据目录，这里在构造后覆盖，
    同时重建依赖缓存目录的解析频率记录文件路径。
    """
    upstream_part = {key: value for key, value in (raw or {}).items() if key != "qq"}
    manager = ConfigManager(upstream_part)

    cache_dir = settings.cache_dir
    os.makedirs(cache_dir, exist_ok=True)
    manager.download.cache_dir = cache_dir
    manager.download.cache_dir_available = check_cache_dir_available(cache_dir)
    manager.parse_rate_limit.record_file = os.path.join(
        UpstreamConfig.build_runtime_dir(cache_dir, "parse_records"),
        "records.json",
    )
    if manager.bilibili.cookie_runtime_file:
        manager.bilibili.cookie_runtime_file = os.path.join(
            UpstreamConfig.build_runtime_dir(cache_dir, "bilibili"), "cookie.json"
        )
    # Roost owns the shared Bilibili login in the Node layer. The upstream
    # runtime cookie file (and its admin-assist writer) would otherwise take
    # priority over the configured shared Cookie. Ignore that legacy file and
    # keep configured-cookie validation and use_cookie behavior intact.
    manager.bilibili.cookie_runtime_file = ""
    manager.bilibili.enable_admin_assist = False
    return manager
