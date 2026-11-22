"""Exercise all bundled Python parsers, without external requests."""

import json
from pathlib import Path
import sys
import tempfile
import unittest

ENGINE = Path(__file__).resolve().parents[1] / "engine"
sys.path.insert(0, str(ENGINE))

from service.config import build_engine_config, parse_qq_settings
from service.engine import MediaEngine


FIXTURES = {
    "bilibili": "https://www.bilibili.com/video/BV1xx411c7mD?p=2",
    "douyin": "https://www.douyin.com/note/7123456789012345678",
    "kuaishou": "https://v.kuaishou.com/AbCd/",
    "acfun": "https://www.acfun.cn/v/ac123",
    "hongguo": "https://hongguoduanju.com/player/123/456",
    "netease": "https://music.163.com/#/song?id=123",
    "ximalaya": "https://www.ximalaya.com/sound/123",
    "weibo": "https://weibo.com/123/Abcdefgh",
    "xiaohongshu": "https://xhslink.com/a/AbC",
    "xianyu": "https://www.goofish.com/item?id=123456789012",
    "toutiao": "https://www.toutiao.com/article/123",
    "xiaoheihe": "https://www.xiaoheihe.cn/app/bbs/link/123",
    "xueqiu": "https://xueqiu.com/123/456",
    "wechat": "https://mp.weixin.qq.com/s/abc",
    "zhihu": "https://www.zhihu.com/question/1/answer/2",
    "tieba": "https://tieba.baidu.com/p/123",
    "nga": "https://bbs.nga.cn/read.php?tid=123",
    "hupu": "https://bbs.hupu.com/123.html",
    "douban": "https://movie.douban.com/subject/123/",
    "v2ex": "https://www.v2ex.com/t/123",
    "juejin": "https://juejin.cn/post/123",
    "csdn": "https://blog.csdn.net/alice/article/details/123",
    "cnblogs": "https://www.cnblogs.com/alice/p/123.html",
    "gitee": "https://gitee.com/alice/repo",
    "tiktok": "https://www.tiktok.com/@alice/video/7123456789012345678",
    "youtube": "https://www.youtube.com/watch?v=AbCdEf12345",
    "steam": "https://store.steampowered.com/app/123/",
    "twitter": "https://x.com/alice/status/123",
    "pixiv": "https://www.pixiv.net/artworks/12345678",
    "github": "https://github.com/alice/repo",
    "gitlab": "https://gitlab.com/alice/repo",
}


class PlatformMappingTests(unittest.TestCase):
    def test_all_31_urls_select_the_actual_bundled_parser(self):
        raw = json.loads((ENGINE / "config.example.json").read_text(encoding="utf-8"))
        self.assertEqual(list(FIXTURES), list(raw["parsers"]))
        with tempfile.TemporaryDirectory(prefix="roost-platform-mapping-") as root:
            raw["qq"]["cacheDir"] = root
            settings = parse_qq_settings(raw["qq"], str(ENGINE))
            engine = MediaEngine(build_engine_config(raw, settings), settings)
            self.assertEqual(len(engine.platform_list()), 31)
            for platform, link in FIXTURES.items():
                with self.subTest(platform=platform):
                    matches = engine.parser_manager.extract_all_links(link)
                    self.assertTrue(matches, f"No engine match: {link}")
                    self.assertEqual({parser.name for _, parser in matches}, {platform})


if __name__ == "__main__":
    unittest.main()
