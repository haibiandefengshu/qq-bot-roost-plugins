"""Network boundary for the bundled upstream engine (no changes to vendor/core).

Every aiohttp request, including redirects and temporary parser sessions, passes
through this shim. Connector DNS results are checked at the point where aiohttp
uses them, so validation never causes a second DNS lookup before connecting.
Configured HTTP proxies use numeric destination addresses and the original Host
and TLS server name. Only the explicitly configured proxy may be private.
"""

from __future__ import annotations

import asyncio
import contextvars
import functools
import ipaddress
import logging
import os
import re
import socket
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import aiohttp
from multidict import CIMultiDict
from yarl import URL


MAX_BUFFERED_RESPONSE = 32 * 1024 * 1024
_installed = False
_parser_installed = False
_request_transport = None
_trusted_proxies: set[tuple[str, int, str]] = set()
_proxy_resolution = contextvars.ContextVar("media_parser_proxy", default=None)
_relay_urls = contextvars.ContextVar("media_parser_relays", default=frozenset())
_credential_hosts: dict[str, frozenset[str]] = {}
_secrets: tuple[str, ...] = ()
_cache_root: Path | None = None
_log_filter = None

# Cookies are intentionally limited to service domains, not media CDNs.
_PLATFORM_COOKIE_HOSTS = {
    "bilibili": ("bilibili.com",),
    "bilibili_enhanced": ("bilibili.com",),
    "douyin": ("douyin.com", "iesdouyin.com"),
    "kuaishou": ("kuaishou.com", "gifshow.com"),
    "netease": ("music.163.com",),
    "ximalaya": ("ximalaya.com",),
    "weibo": ("weibo.com", "weibo.cn"),
    "xiaohongshu": ("xiaohongshu.com",),
    "xianyu": ("goofish.com", "m.goofish.com", "h5api.m.goofish.com"),
    "xueqiu": ("xueqiu.com",),
    "wechat": ("yuanbao.tencent.com",),
    "zhihu": ("zhihu.com",),
    "tieba": ("tieba.baidu.com",),
    "nga": ("nga.cn", "ngabbs.com", "nga.178.com"),
    "hupu": ("hupu.com",),
    "douban": ("douban.com",),
    "tiktok": ("tiktok.com",),
    "youtube": ("youtube.com",),
    "twitter": ("x.com", "twitter.com", "api.x.com"),
    "pixiv": ("pixiv.net",),
    "github": ("github.com",),
    "gitlab": ("gitlab.com",),
    "gitee": ("gitee.com",),
}


class NetworkBoundaryError(aiohttp.ClientError):
    """A request crossed a boundary; messages never contain URLs or credentials."""


def _hostname(value: str) -> str:
    return str(value or "").lower().rstrip(".")


def require_public_ip(value: str) -> str:
    """Reject all special/private addresses, including mapped/tunneled IPv4."""
    try:
        address = ipaddress.ip_address(str(value))
    except ValueError as exc:
        raise NetworkBoundaryError("目标解析未返回有效 IP 地址") from exc
    if (
        not address.is_global
        or address.is_multicast
        or address.is_reserved
        or address.is_unspecified
        or str(address) == "168.63.129.16"  # Azure platform metadata endpoint.
    ):
        raise NetworkBoundaryError("拒绝访问内部或保留网络地址")
    if isinstance(address, ipaddress.IPv6Address):
        if address.ipv4_mapped is not None:
            require_public_ip(str(address.ipv4_mapped))
        if address.sixtofour is not None:
            require_public_ip(str(address.sixtofour))
        if address.teredo is not None:
            raise NetworkBoundaryError("拒绝通过隧道地址访问网络")
        if address in ipaddress.ip_network("64:ff9b::/96") or address in ipaddress.ip_network(
            "64:ff9b:1::/48"
        ):
            raise NetworkBoundaryError("拒绝通过转换地址访问网络")
    return str(address)


def validate_url(value: Any, *, proxy: bool = False) -> URL:
    try:
        url = URL(value)
        host = _hostname(url.host or "")
        port = url.port
        if url.scheme not in {"http", "https"} or not host or not port:
            raise ValueError("scheme/host/port")
        if url.user is not None or url.password is not None:
            # Proxy credentials are read only from the explicit admin setting.
            if not proxy:
                raise ValueError("userinfo")
        if any(ord(char) < 33 for char in host) or "%" in host or "\\" in host:
            raise ValueError("host")
        if not proxy:
            if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
                raise NetworkBoundaryError("拒绝访问内部主机名")
            try:
                ipaddress.ip_address(host)
            except ValueError:
                pass
            else:
                require_public_ip(host)
        return url.with_fragment(None)
    except NetworkBoundaryError:
        raise
    except (ValueError, TypeError, UnicodeError) as exc:
        raise NetworkBoundaryError("仅允许有效的 HTTP(S) 公共地址") from exc


def _endpoint(url: URL) -> tuple[str, int, str]:
    return (_hostname(url.host or ""), int(url.port or 0), url.scheme)


def _matches_host(host: str, suffixes: Any) -> bool:
    return any(host == suffix or host.endswith("." + suffix) for suffix in suffixes)


def configure_network_guard(config: dict | None = None) -> None:
    """Use only effective administrator config, never request JSON, as authority."""
    global _trusted_proxies, _credential_hosts, _secrets, _cache_root, _log_filter
    config = config or {}
    proxy = (config.get("proxy") or {}).get("address", "")
    _trusted_proxies = {_endpoint(validate_url(proxy, proxy=True))} if proxy else set()
    credentials: dict[str, frozenset[str]] = {}
    for section, suffixes in _PLATFORM_COOKIE_HOSTS.items():
        values = config.get(section) or {}
        if isinstance(values, dict):
            for name, value in values.items():
                if "cookie" in name.lower() and isinstance(value, str) and value.strip():
                    # Match each individual cookie value as well as the full string,
                    # since the upstream may reformat or select only some cookies.
                    credentials[value.strip()] = frozenset(suffixes)
                    for pair in value.split(";"):
                        if "=" in pair:
                            cookie_value = pair.split("=", 1)[1].strip()
                            if cookie_value:
                                credentials[cookie_value] = frozenset(suffixes)
    _credential_hosts = credentials
    raw_cache = (config.get("qq") or {}).get("cacheDir", "")
    _cache_root = Path(raw_cache).absolute() if raw_cache else None
    secrets = set(credentials)

    def collect(value, key=""):
        if isinstance(value, dict):
            for name, child in value.items():
                collect(child, str(name).lower())
        elif isinstance(value, list):
            for child in value:
                collect(child, key)
        elif isinstance(value, str) and any(
            token in key for token in ("cookie", "api_key", "apikey", "token", "secret", "password")
        ):
            if len(value.strip()) >= 4:
                secrets.add(value.strip())
    collect(config)
    _secrets = tuple(sorted((value for value in secrets if len(value) >= 4), key=len, reverse=True))
    if _log_filter is None:
        class SecretFilter(logging.Filter):
            def filter(self, record):
                record.msg = redact_secrets(record.getMessage())
                record.args = ()
                return True
        _log_filter = SecretFilter()
        logging.getLogger("astrbot_plugin_media_parser").addFilter(_log_filter)
        for handler in logging.getLogger().handlers:
            handler.addFilter(_log_filter)


def redact_secrets(value: Any) -> Any:
    """Remove configured secret values from errors, logs and preview payloads."""
    if isinstance(value, str):
        for secret in _secrets:
            value = value.replace(secret, "***")
        return re.sub(
            r"(?i)([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|"
            r"auth(?:orization)?|password|cookie|secret)=)[^&#\s]*",
            r"\1***",
            value,
        )
    if isinstance(value, dict):
        return {
            name: ("***" if item else "")
            if any(word in str(name).lower() for word in (
                "cookie", "api_key", "apikey", "token", "secret", "password", "authorization"
            ))
            else redact_secrets(item)
            for name, item in value.items()
        }
    if isinstance(value, list):
        return [redact_secrets(item) for item in value]
    if isinstance(value, tuple):
        return tuple(redact_secrets(item) for item in value)
    return value


def _local_media_input(value: str) -> str:
    if _cache_root is None or not value or value.startswith(("\\\\", "//", "file:")):
        raise NetworkBoundaryError("媒体处理输入必须位于配置的缓存目录")
    try:
        candidate = Path(value)
        if not candidate.is_absolute():
            raise ValueError()
        relative = candidate.absolute().relative_to(_cache_root)
        current = _cache_root
        for part in (None, *relative.parts):
            if part is not None:
                current = current / part
            info = current.lstat()
            if current.is_symlink() or getattr(info, "st_file_attributes", 0) & 0x400:
                raise ValueError()
        candidate.resolve(strict=True).relative_to(_cache_root.resolve(strict=True))
        if not candidate.is_file():
            raise ValueError()
        return str(candidate)
    except (OSError, ValueError) as exc:
        raise NetworkBoundaryError("拒绝处理缓存目录外的媒体文件") from exc


def guard_subprocess_args(arguments) -> tuple:
    """Constrain ffmpeg inputs before the execution shim spawns the process."""
    args = tuple(os.fspath(value) for value in arguments)
    if not args:
        return args
    program = Path(args[0]).name.lower()
    if program in {"curl", "curl.exe", "wget", "wget.exe"}:
        raise NetworkBoundaryError("网络抓取必须经过引擎受限下载流程")
    if program not in {"ffmpeg", "ffmpeg.exe", "ffprobe", "ffprobe.exe"}:
        return args
    # Prevent a downloaded playlist or concat file from opening another network
    # endpoint (or another local file) inside ffmpeg.
    safe_formats = (
        "mov,matroska,webm,mpegts,mpeg,flv,avi,mp3,wav,ogg,flac,aac,amr,asf,"
        "gif,apng,image2pipe,png_pipe,jpeg_pipe,webp_pipe,tiff_pipe,bmp_pipe,avif,heif,heic"
    )
    result = [args[0]]
    index = 1
    while index < len(args):
        arg = args[index]
        if arg in {"-protocol_whitelist", "-format_whitelist"}:
            index += 2
            continue
        if arg == "-i":
            if index + 1 >= len(args):
                raise NetworkBoundaryError("媒体处理输入参数无效")
            value = args[index + 1]
            if value in _relay_urls.get():
                protocols = "http,tcp"
            else:
                _local_media_input(value)
                protocols = "file,pipe"
            result.extend((
                "-protocol_whitelist", protocols, "-format_whitelist", safe_formats, "-i", value
            ))
            index += 2
            continue
        result.append(arg)
        index += 1
    # The bundled engine currently uses ffmpeg only. Handle ffprobe's final
    # positional input as well if a future shim uses it.
    if program.startswith("ffprobe") and "-i" not in args:
        _local_media_input(args[-1])
        result[1:1] = ["-protocol_whitelist", "file,pipe", "-format_whitelist", safe_formats]
    return tuple(result)


def _cookie_allowed(header: str, host: str) -> bool:
    for secret, suffixes in _credential_hosts.items():
        if secret in header and not _matches_host(host, suffixes):
            return False
    return True


async def _public_addresses(host: str, port: int) -> list[str]:
    """Used only for proxy destinations, which must be pinned before CONNECT."""
    try:
        return [require_public_ip(host)]
    except NetworkBoundaryError:
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            raise
    results = await asyncio.wait_for(
        asyncio.get_running_loop().getaddrinfo(
            host, port, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP
        ),
        timeout=10,
    )
    addresses = list(dict.fromkeys(require_public_ip(result[4][0]) for result in results))
    if not addresses:
        raise NetworkBoundaryError("目标未解析到公共地址")
    return addresses


def install_network_guard() -> None:
    """Install once, before creating any engine sessions. Covers aiohttp 3.x."""
    global _installed, _request_transport
    if _installed:
        return
    original_resolve = aiohttp.TCPConnector._resolve_host
    original_request = aiohttp.ClientSession._request
    _request_transport = original_request
    original_read = aiohttp.ClientResponse.read

    @functools.wraps(original_resolve)
    async def resolve(connector, host, port, *args, **kwargs):
        addresses = await original_resolve(connector, host, port, *args, **kwargs)
        approved_proxy = _proxy_resolution.get()
        if approved_proxy and (_hostname(host), port) == approved_proxy:
            return addresses
        # Inspect exactly the numeric addresses passed on to aiohttp's socket
        # connector, including cached values and IP literal fast paths.
        if not addresses:
            raise NetworkBoundaryError("目标未解析到公共地址")
        for address in addresses:
            require_public_ip(address["host"])
        return addresses

    @functools.wraps(original_request)
    async def request(session, method, str_or_url, **kwargs):
        if getattr(session, "_trust_env", False):
            raise NetworkBoundaryError("请在插件高级配置中显式设置代理")
        logical = validate_url(session._build_url(str_or_url))
        method = str(method).upper()
        options = dict(kwargs)
        follow = options.pop("allow_redirects", True)
        max_redirects = min(10, max(1, int(options.pop("max_redirects", 10) or 10)))
        headers = CIMultiDict(getattr(session, "_default_headers", {}))
        headers.update(options.pop("headers", None) or {})
        # A platform may supply its own user agent/referer, never a separate Host.
        headers.popall("Host", None)
        options["headers"] = headers
        options["allow_redirects"] = False
        # Defer raise_for_status until redirect handling completes.
        raise_policy = options.pop("raise_for_status", getattr(session, "_raise_for_status", False))
        options["raise_for_status"] = False
        original_origin = logical.origin()
        explicit_cookies = options.pop("cookies", None)
        proxy_value = options.get("proxy") or getattr(session, "_default_proxy", None)
        proxy_url = validate_url(proxy_value, proxy=True) if proxy_value else None
        if proxy_url is not None and _endpoint(proxy_url) not in _trusted_proxies:
            raise NetworkBoundaryError("代理地址未由插件管理员配置")
        started = time.monotonic()
        history = []
        timeout = options.get("timeout", session.timeout)
        total = getattr(timeout, "total", None)
        for redirect in range(max_redirects + 1):
            logical = validate_url(logical)
            hop = dict(options)
            hop_headers = CIMultiDict(headers)
            same_origin = logical.origin() == original_origin
            if not same_origin:
                for name in ("Cookie", "Authorization", "Proxy-Authorization", "X-Api-Key", "Api-Key"):
                    hop_headers[name] = ""
                hop["auth"] = None
                # Bodies may contain API keys or signed platform parameters.
                if method not in {"GET", "HEAD"} and (hop.get("data") or hop.get("json")):
                    raise NetworkBoundaryError("拒绝跨来源重定向带凭据的请求正文")
            cookie_header = hop_headers.get("Cookie", "")
            if cookie_header and not _cookie_allowed(cookie_header, _hostname(logical.host)):
                hop_headers["Cookie"] = ""
            if same_origin and explicit_cookies:
                hop["cookies"] = explicit_cookies
            hop["headers"] = hop_headers
            if total is not None:
                remaining = float(total) - (time.monotonic() - started)
                if remaining <= 0:
                    raise asyncio.TimeoutError()
                hop["timeout"] = aiohttp.ClientTimeout(
                    total=remaining,
                    connect=getattr(timeout, "connect", None),
                    sock_read=getattr(timeout, "sock_read", None),
                    sock_connect=getattr(timeout, "sock_connect", None),
                )
            destination = logical
            if proxy_url is not None:
                # A proxy must not resolve the user-controlled hostname again.
                addresses = await _public_addresses(_hostname(logical.host), logical.port)
                destination = logical.with_host(addresses[0])
                hop_headers["Host"] = logical.raw_authority
                if logical.scheme == "https":
                    hop["server_hostname"] = logical.host
                jar_cookies = session.cookie_jar.filter_cookies(logical)
                if jar_cookies:
                    jar_cookies.update(hop.get("cookies") or {})
                    hop["cookies"] = jar_cookies
            token = _proxy_resolution.set(
                (_hostname(proxy_url.host), proxy_url.port) if proxy_url is not None else None
            )
            try:
                response = await _request_transport(session, method, destination, **hop)
            finally:
                _proxy_resolution.reset(token)
            if proxy_url is not None:
                # Preserve upstream relative-URL semantics and domain cookie scope.
                response._url = logical
                response._real_url = logical
                response._cache.pop("url", None)
                response._cache.pop("real_url", None)
                session.cookie_jar.update_cookies(response.cookies, response_url=logical)
            location = response.headers.get("Location") or response.headers.get("URI")
            if not follow or response.status not in {301, 302, 303, 307, 308} or not location:
                response._history = tuple(history)
                if callable(raise_policy):
                    await raise_policy(response)
                elif raise_policy:
                    response.raise_for_status()
                return response
            history.append(response)
            response.release()
            if redirect == max_redirects:
                raise NetworkBoundaryError("重定向次数超过安全上限")
            logical = validate_url(logical.join(URL(location)))
            options.pop("params", None)
            if (response.status == 303 and method != "HEAD") or (
                response.status in {301, 302} and method == "POST"
            ):
                method = "GET"
                options.pop("data", None)
                options.pop("json", None)
                headers.popall("Content-Length", None)
                headers.popall("Content-Type", None)
        raise NetworkBoundaryError("无效重定向")

    @functools.wraps(original_read)
    async def read(response):
        if response._body is None:
            try:
                if (response.content_length or 0) > MAX_BUFFERED_RESPONSE:
                    raise NetworkBoundaryError("上游响应正文超过缓冲上限")
                chunks = []
                length = 0
                async for chunk in response.content.iter_chunked(64 * 1024):
                    length += len(chunk)
                    if length > MAX_BUFFERED_RESPONSE:
                        raise NetworkBoundaryError("上游响应正文超过缓冲上限")
                    chunks.append(chunk)
                response._body = b"".join(chunks)
            except BaseException:
                response.close()
                raise
        return await original_read(response)

    aiohttp.TCPConnector._resolve_host = resolve
    aiohttp.ClientSession._request = request
    aiohttp.ClientResponse.read = read
    _installed = True


def install_parser_guards() -> None:
    """Route the sole upstream curl path through the same checked HTTP stack."""
    global _parser_installed
    if _parser_installed:
        return
    from core.parser.platform.tiktok import TikTokParser, TIKTOK_USER_AGENT
    from core.downloader.handler import video_cover

    original_relay = video_cover._media_relay

    @asynccontextmanager
    async def media_relay(*args, **kwargs):
        async with original_relay(*args, **kwargs) as relay_url:
            token = _relay_urls.set(_relay_urls.get() | {relay_url})
            try:
                yield relay_url
            finally:
                _relay_urls.reset(token)

    async def fetch_tiktok_page(parser, page_url):
        try:
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=30),
                headers={
                    "User-Agent": TIKTOK_USER_AGENT,
                    "Referer": "https://www.tiktok.com/",
                    "Accept-Language": "en-US,en;q=0.9",
                },
                trust_env=False,
            ) as session:
                async with session.get(
                    page_url, proxy=parser._get_proxy(), allow_redirects=True
                ) as response:
                    if response.status >= 400:
                        return None
                    return {"url": str(response.url), "html": await response.text(errors="replace")}
        except asyncio.CancelledError:
            raise
        except (aiohttp.ClientError, asyncio.TimeoutError):
            return None

    TikTokParser.fetch_tiktok_page = fetch_tiktok_page
    video_cover._media_relay = media_relay
    _parser_installed = True
