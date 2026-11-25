"""Verify Roost uses the configured shared Cookie and ignores the old runtime file."""

import os
from pathlib import Path
import sys
import tempfile
import unittest

ENGINE = Path(__file__).resolve().parents[1] / "engine"
sys.path.insert(0, str(ENGINE))

from service import paths  # noqa: E402

paths.install(str(ENGINE))

from service.config import QQSettings, build_engine_config  # noqa: E402
from core.constants import Config as UpstreamConfig  # noqa: E402
from core.parser.runtime_manager.bilibili.auth import BilibiliAuthRuntime  # noqa: E402


class BilibiliCookieSourceTests(unittest.TestCase):
    def test_old_runtime_cookie_is_ignored_and_configured_cookie_stays_active(self):
        with tempfile.TemporaryDirectory(dir=str(Path(__file__).resolve().parent)) as root:
            old_dir = Path(UpstreamConfig.build_runtime_dir(root, "bilibili"))
            old_dir.mkdir(parents=True, exist_ok=True)
            old_file = old_dir / "cookie.json"
            old_file.write_text(
                '{"SESSDATA": "OLD-RUNTIME-VALUE", "cookie_header": "SESSDATA=OLD-RUNTIME-VALUE"}',
                encoding="utf-8",
            )
            before = old_file.read_text(encoding="utf-8")

            raw = {
                "bilibili_enhanced": {
                    "use_cookie": True,
                    "cookie": "SESSDATA=CONFIGURED-VALUE",
                    "max_quality": "720P",
                },
                "download": {"cache_dir": root},
            }
            settings = QQSettings(cache_dir=root)
            manager = build_engine_config(raw, settings)

            self.assertTrue(manager.bilibili.use_cookie)
            self.assertTrue(manager.bilibili.cookie_runtime_enabled)
            self.assertEqual(manager.bilibili.cookie, "SESSDATA=CONFIGURED-VALUE")
            self.assertEqual(manager.bilibili.cookie_runtime_file, "")
            self.assertFalse(manager.bilibili.enable_admin_assist)
            self.assertEqual(old_file.read_text(encoding="utf-8"), before)

            auth = BilibiliAuthRuntime(
                enabled=manager.bilibili.cookie_runtime_enabled,
                configured_cookie=manager.bilibili.cookie,
                credential_path=manager.bilibili.cookie_runtime_file,
            )
            source, cookie = auth._active_cookie()
            self.assertEqual(source, "configured")
            self.assertEqual(cookie, "SESSDATA=CONFIGURED-VALUE")
            self.assertEqual(auth._runtime_cookie_header, "")

    def test_disabled_cookie_feature_stays_disabled(self):
        with tempfile.TemporaryDirectory(dir=str(Path(__file__).resolve().parent)) as root:
            manager = build_engine_config(
                {"bilibili_enhanced": {"use_cookie": False, "cookie": "SESSDATA=IGNORED-VALUE"}},
                QQSettings(cache_dir=root),
            )
            self.assertFalse(manager.bilibili.use_cookie)
            self.assertFalse(manager.bilibili.cookie_runtime_enabled)
            self.assertEqual(manager.bilibili.cookie_runtime_file, "")
            self.assertFalse(manager.bilibili.enable_admin_assist)


if __name__ == "__main__":
    unittest.main()
