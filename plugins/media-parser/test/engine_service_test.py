"""Run with the isolated Python interpreter; no external platform access."""

import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ENGINE = Path(__file__).resolve().parents[1] / "engine"
sys.path.insert(0, str(ENGINE))

from service.cache import CacheBoundaryError, CacheGuard
from service.config import QQSettings
from service.execution import execute
from service.server import create_app, JOBS
from aiohttp import web

TOKEN = "engine-service-test-token-" * 3
IDENTITY = {
    "serviceId": "roost-media-parser",
    "version": "0.1.0",
    "instanceId": "12345678-1234-1234-1234-123456789abc",
    "sourceHash": "a" * 64,
    "pid": os.getpid(),
}


def http(url, route, payload=None, token=TOKEN):
    request = Request(
        url + route,
        data=None if payload is None else json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urlopen(request, timeout=8) as response:
            return response.status, json.load(response)
    except HTTPError as error:
        return error.code, json.load(error)


class CacheTests(unittest.TestCase):
    def test_leases_protect_manual_cleanup_and_expiry_cleanup(self):
        with tempfile.TemporaryDirectory() as root:
            cache = CacheGuard(root, ttl_seconds=60, max_bytes=1)
            target = Path(root, "media.mp4")
            target.write_bytes(b"media")
            lease = cache.hold([str(target)])
            self.assertEqual(cache.clean(all_files=True)["files"], 0)
            self.assertTrue(target.exists())
            self.assertEqual(cache.clean()["files"], 0)
            cache.release(lease_id=lease["leaseId"])
            self.assertEqual(cache.clean()["files"], 1)
            self.assertFalse(target.exists())

    def test_every_cleanup_checks_paths_again(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as outside:
            cache = CacheGuard(root)
            target = Path(outside, "outside.mp4")
            target.write_bytes(b"leave")
            self.assertEqual(cache.remove_files([str(target)])["failed"], 1)
            self.assertTrue(target.exists())
            self.assertEqual(cache.remove_files(["../outside.mp4", r"\\host\share\movie"])["failed"], 2)
            with self.assertRaises(CacheBoundaryError):
                cache.checked(Path(outside).as_uri() + "/outside.mp4")

    def test_symlink_is_never_followed(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as outside:
            cache = CacheGuard(root)
            target = Path(outside, "outside.mp4")
            target.write_bytes(b"leave")
            link = Path(root, "escape")
            try:
                link.symlink_to(outside, target_is_directory=True)
            except OSError:
                self.skipTest("Windows symlink privilege unavailable")
            self.assertEqual(cache.remove_files([str(link / target.name)])["failed"], 1)
            self.assertTrue(target.exists())


class FakeOutcome:
    def __init__(self, path):
        self.path = path

    def to_dict(self):
        return {
            "ok": True,
            "plan": {"messages": [{"segments": [{"type": "video", "data": {"file": self.path}}]}]},
        }


class FakeEngine:
    def __init__(self, root):
        self.cache = CacheGuard(root)
        self.cfg = SimpleNamespace(
            download=SimpleNamespace(cache_dir_available=True),
            translation=SimpleNamespace(enabled=False),
            message=SimpleNamespace(text_metadata=SimpleNamespace(render_to_image=False)),
        )
        self.cancelled = asyncio.Event()
        self.started = asyncio.Event()
        self.process = None

    def platform_list(self):
        return [{"name": "bilibili"}]

    async def parse(self, text, **kwargs):
        if text == "slow" or text == "process":
            try:
                if text == "process":
                    self.process = await asyncio.create_subprocess_exec(
                        sys.executable, "-c", "import time;time.sleep(120)",
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    )
                self.started.set()
                await asyncio.sleep(120)
            except asyncio.CancelledError:
                self.cancelled.set()
                raise
        target = self.cache.root / "video.mp4"
        target.write_bytes(b"video")
        return FakeOutcome(str(target))

    async def clean_cache(self):
        return self.cache.clean(all_files=True)

    async def clean_files(self, files):
        return self.cache.remove_files(files)


class ServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.engine = FakeEngine(self.temporary.name)
        self.shutdown = asyncio.Event()
        self.settings = QQSettings(token=TOKEN, cache_dir=self.temporary.name)
        self.app = create_app(
            self.engine, self.settings, {"qq": {"cacheDir": self.temporary.name}},
            service_identity=IDENTITY, shutdown_event=self.shutdown,
        )
        self.runner = web.AppRunner(self.app, access_log=None, handler_cancellation=True)
        await self.runner.setup()
        self.site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await self.site.start()
        port = self.site._server.sockets[0].getsockname()[1]
        self.url = f"http://127.0.0.1:{port}"

    async def asyncTearDown(self):
        await self.runner.cleanup()
        self.temporary.cleanup()

    async def request(self, route, payload=None, token=TOKEN):
        return await asyncio.to_thread(http, self.url, route, payload, token)

    def parse_payload(self, text, deadline_ms=3000):
        import time
        import uuid
        return {
            "text": text, "taskId": uuid.uuid4().hex,
            "deadlineAt": time.time() * 1000 + deadline_ms,
        }

    async def test_health_and_shutdown_require_token_and_matching_identity(self):
        self.assertEqual((await self.request("/health", token="wrong"))[0], 401)
        status, info = await self.request("/health")
        self.assertEqual(status, 200)
        self.assertEqual(info["instanceId"], IDENTITY["instanceId"])
        self.assertEqual((await self.request("/shutdown", {"instanceId": "wrong"}))[0], 409)
        self.assertFalse(self.shutdown.is_set())
        self.assertEqual((await self.request("/shutdown", IDENTITY))[0], 200)
        await asyncio.wait_for(self.shutdown.wait(), 1)

    async def test_server_deadline_cancels_the_actual_parse(self):
        status, _ = await self.request("/parse", self.parse_payload("slow", 80))
        self.assertEqual(status, 408)
        self.assertTrue(self.engine.cancelled.is_set())
        self.assertEqual(len(self.app[JOBS]), 0)

    async def test_explicit_cancel_reaps_owned_subprocess(self):
        payload = self.parse_payload("process", 5000)
        parsing = asyncio.create_task(self.request("/parse", payload))
        await asyncio.wait_for(self.engine.started.wait(), 2)
        status, cancelled = await self.request("/cancel", {"taskId": payload["taskId"]})
        self.assertEqual(status, 200)
        self.assertTrue(cancelled["cancelled"])
        self.assertIsNotNone(self.engine.process.returncode)
        self.assertEqual((await parsing)[0], 409)

    async def test_shutdown_cancels_owned_subprocess_before_waiting_for_handlers(self):
        parsing = asyncio.create_task(
            self.request("/parse", self.parse_payload("process", 5000))
        )
        await asyncio.wait_for(self.engine.started.wait(), 2)
        self.assertEqual((await self.request("/shutdown", IDENTITY))[0], 200)
        await asyncio.wait_for(self.shutdown.wait(), 1)
        await asyncio.wait_for(self.app.shutdown(), 2)
        self.assertIsNotNone(self.engine.process.returncode)
        self.assertEqual((await parsing)[0], 409)

    async def test_response_lease_bridges_parse_and_sending(self):
        status, result = await self.request("/parse", self.parse_payload("video"))
        self.assertEqual(status, 200)
        self.assertTrue(result["leaseId"])
        target = result["leasedFiles"][0]
        self.assertEqual((await self.request("/clean", {}))[1]["stats"]["files"], 0)
        await self.request("/release-files", {"leaseId": result["leaseId"]})
        self.assertEqual((await self.request("/cleanup-files", {"files": [target]}))[1]["stats"]["files"], 1)

    async def test_response_does_not_return_configured_credential_values(self):
        from service.network_guard import configure_network_guard
        configure_network_guard({"qq": {"cacheDir": self.temporary.name}, "pixiv": {"cookie": "TEST_SECRET_COOKIE"}})
        original = self.engine.platform_list
        self.engine.platform_list = lambda: [{"name": "TEST_SECRET_COOKIE"}]
        _, result = await self.request("/platforms")
        self.assertNotIn("TEST_SECRET_COOKIE", json.dumps(result))
        self.engine.platform_list = original


if __name__ == "__main__":
    unittest.main()
