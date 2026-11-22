"""Network tests use fake DNS/HTTP; they never call a private HTTP listener."""

import asyncio
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine"))

import aiohttp
from aiohttp.abc import AbstractResolver
from multidict import CIMultiDict
from yarl import URL
from service import network_guard as guard


class Addresses(AbstractResolver):
    def __init__(self, addresses):
        self.addresses = addresses

    async def resolve(self, host, port=0, family=0):
        return [
            {"hostname": host, "host": ip, "port": port, "family": 2, "proto": 0, "flags": 0}
            for ip in self.addresses
        ]

    async def close(self):
        pass


class Response:
    def __init__(self, status=200, location=None):
        self.status = status
        self.headers = CIMultiDict({"Location": location} if location else {})
        self.cookies = {}
        self._cache = {}
        self.released = False

    def release(self):
        self.released = True


class NetworkTests(unittest.IsolatedAsyncioTestCase):
    def test_private_and_obfuscated_addresses(self):
        for address in (
            "127.0.0.1", "0.0.0.0", "10.0.0.1", "172.16.1.2", "192.168.1.1",
            "169.254.169.254", "100.100.100.200", "168.63.129.16", "::1", "fc00::1",
            "fe80::1", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "224.1.1.1",
        ):
            with self.subTest(address=address), self.assertRaises(guard.NetworkBoundaryError):
                guard.require_public_ip(address)
        self.assertEqual(guard.require_public_ip("8.8.8.8"), "8.8.8.8")

    def test_url_schemes_and_userinfo(self):
        for url in (
            "file:///E:/secret", "ftp://public.example/a", "http://localhost/a",
            "http://box.internal/a", "http://[::1]/", "https://user:pass@github.com/a",
            "http://[fe80::1%25eth0]/", "http://127.0.0.1/",
        ):
            with self.subTest(url=url), self.assertRaises(guard.NetworkBoundaryError):
                guard.validate_url(url)

    async def test_actual_connector_results_and_cache_cannot_rebind(self):
        guard.install_network_guard()
        resolver = Addresses(["8.8.8.8"])
        async with aiohttp.TCPConnector(resolver=resolver, use_dns_cache=False) as connector:
            first = await connector._resolve_host("example.org", 443)
            self.assertEqual(first[0]["host"], "8.8.8.8")
            resolver.addresses = ["127.0.0.1"]
            with self.assertRaises(guard.NetworkBoundaryError):
                await connector._resolve_host("example.org", 443)
        async with aiohttp.TCPConnector(resolver=Addresses(["8.8.8.8", "10.0.0.1"])) as connector:
            with self.assertRaises(guard.NetworkBoundaryError):
                await connector._resolve_host("example.org", 443)
        async with aiohttp.TCPConnector() as connector:
            for literal in ("127.0.0.1", "2130706433", "127.1", "0177.0.0.1"):
                with self.subTest(literal=literal), self.assertRaises((aiohttp.ClientError, OSError)):
                    await connector._resolve_host(literal, 443)

    def test_configured_cookie_never_flows_to_other_platform_or_cdn(self):
        guard.configure_network_guard({"bilibili_enhanced": {"cookie": "SESSDATA=secret-value; a=b"}})
        self.assertTrue(guard._cookie_allowed("SESSDATA=secret-value", "api.bilibili.com"))
        for host in ("github.com", "bilibili.com.evil.org", "v.bilivideo.com"):
            self.assertFalse(guard._cookie_allowed("SESSDATA=secret-value", host))
        guard.configure_network_guard({})

    async def test_unconfigured_proxy_and_private_request_rejected_before_socket(self):
        guard.install_network_guard()
        guard.configure_network_guard({})
        async with aiohttp.ClientSession() as session:
            with self.assertRaises(guard.NetworkBoundaryError):
                await session.get("http://github.com/", proxy="http://127.0.0.1:9")
            with self.assertRaises(guard.NetworkBoundaryError):
                await session.get("http://127.0.0.1:9/")

    async def test_proxy_resolution_pins_destination_and_rejects_mixed_dns(self):
        getaddrinfo = AsyncMock(return_value=[
            (2, 1, 6, "", ("8.8.8.8", 443)),
            (2, 1, 6, "", ("192.168.0.1", 443)),
        ])
        with patch.object(asyncio.get_running_loop(), "getaddrinfo", getaddrinfo):
            with self.assertRaises(guard.NetworkBoundaryError):
                await guard._public_addresses("public.example", 443)

    async def test_redirect_to_private_never_reaches_second_request(self):
        guard.install_network_guard()
        first = Response(302, "http://169.254.169.254/latest/meta-data/")
        transport = AsyncMock(return_value=first)
        async with aiohttp.ClientSession() as session:
            with patch.object(guard, "_request_transport", transport):
                with self.assertRaises(guard.NetworkBoundaryError):
                    await session.get("https://www.bilibili.com/video/test")
        self.assertEqual(transport.await_count, 1)
        self.assertTrue(first.released)

    async def test_cross_host_redirect_strips_credentials_including_defaults(self):
        guard.install_network_guard()
        transport = AsyncMock(side_effect=[
            Response(302, "https://www.github.com/repo"), Response()
        ])
        async with aiohttp.ClientSession(headers={"Cookie": "session=secret", "X-Api-Key": "key"}) as session:
            with patch.object(guard, "_request_transport", transport):
                await session.get("https://www.bilibili.com/video/test", cookies={"a": "b"})
        options = transport.await_args_list[1].kwargs
        self.assertEqual(options["headers"]["Cookie"], "")
        self.assertEqual(options["headers"]["X-Api-Key"], "")
        self.assertNotIn("cookies", options)

    async def test_proxy_sees_numeric_destination_and_original_tls_name(self):
        guard.install_network_guard()
        guard.configure_network_guard({"proxy": {"address": "http://127.0.0.1:7890"}})
        transport = AsyncMock(return_value=Response())
        async with aiohttp.ClientSession() as session:
            with patch.object(guard, "_request_transport", transport), patch.object(
                guard, "_public_addresses", AsyncMock(return_value=["8.8.8.8"])
            ):
                response = await session.get(
                    "https://www.bilibili.com/video/test?p=2", proxy="http://127.0.0.1:7890"
                )
        call = transport.await_args
        self.assertEqual(str(call.args[2]), "https://8.8.8.8/video/test?p=2")
        self.assertEqual(call.kwargs["headers"]["Host"], "www.bilibili.com")
        self.assertEqual(call.kwargs["server_hostname"], "www.bilibili.com")
        self.assertEqual(str(response._url), "https://www.bilibili.com/video/test?p=2")
        guard.configure_network_guard({})

    def test_subprocess_cannot_read_remote_or_outside_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            media = cache / "audio.wav"
            media.write_bytes(b"RIFF")
            guard.configure_network_guard({"qq": {"cacheDir": str(cache)}})
            args = guard.guard_subprocess_args(("ffmpeg", "-i", str(media), "-f", "null", "-"))
            self.assertIn("file,pipe", args)
            self.assertIn("-format_whitelist", args)
            for value in ("http://127.0.0.1/private", "https://www.bilibili.com/video", "file:///etc/passwd"):
                with self.subTest(value=value), self.assertRaises(guard.NetworkBoundaryError):
                    guard.guard_subprocess_args(("ffmpeg", "-i", value, "output.mp4"))
            with self.assertRaises(guard.NetworkBoundaryError):
                guard.guard_subprocess_args(("curl", "-L", "https://tiktok.com/video/1"))
        guard.configure_network_guard({})

    def test_relay_capability_is_exact_and_scoped(self):
        relay = "http://127.0.0.1:54321/random-secret/media"
        token = guard._relay_urls.set(frozenset({relay}))
        try:
            args = guard.guard_subprocess_args(("ffmpeg", "-i", relay, "output.jpg"))
            self.assertIn("http,tcp", args)
            with self.assertRaises(guard.NetworkBoundaryError):
                guard.guard_subprocess_args(("ffmpeg", "-i", relay.replace("random-secret", "wrong"), "output.jpg"))
        finally:
            guard._relay_urls.reset(token)
        with self.assertRaises(guard.NetworkBoundaryError):
            guard.guard_subprocess_args(("ffmpeg", "-i", relay, "output.jpg"))

    def test_secrets_are_removed_inside_error_strings_and_nested_results(self):
        guard.configure_network_guard({
            "bilibili_enhanced": {"cookie": "SESSDATA=very-private-cookie"},
            "translation": {"llm": {"custom_provider": {"api_key": "very-private-key"}}},
        })
        result = guard.redact_secrets({
            "error": "SESSDATA=very-private-cookie key=very-private-key",
            "url": "https://example.org/path?access_token=another-secret&item=1",
        })
        self.assertNotIn("very-private", str(result))
        self.assertNotIn("another-secret", str(result))
        self.assertIn("item=1", result["url"])
        guard.configure_network_guard({})


if __name__ == "__main__":
    unittest.main()
