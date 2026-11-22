"""引擎入口：启动本地 HTTP 服务。

用法：
    python run_engine.py                 # 读取同目录 config.json
    python run_engine.py --config x.json
    python run_engine.py --check         # 只做自检，不启动服务
"""

import argparse
import asyncio
import json
import logging
import os
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

# 被插件以后台方式拉起时，stdout/stderr 直接写进日志文件。
# 不配 logging 的话 info 级日志会被 stdlib 丢掉，日志文件永远是空的（踩过）。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    stream=sys.stdout,
)

from service import paths  # noqa: E402

paths.install(BASE_DIR)

from service.config import (  # noqa: E402
    build_engine_config,
    ensure_ffmpeg,
    load_raw_config,
    parse_qq_settings,
)
from service.engine import MediaEngine  # noqa: E402


def _self_check(config_path: str) -> int:
    """打印环境与配置摘要，便于排查。"""
    from service.network_guard import configure_network_guard, install_parser_guards
    from service.identity import source_hash, SERVICE_ID, VERSION

    install_parser_guards()
    raw = load_raw_config(config_path)
    settings = parse_qq_settings(raw.get("qq") or {}, BASE_DIR)
    raw.setdefault("qq", {})["cacheDir"] = settings.cache_dir
    configure_network_guard(raw)
    ffmpeg = ensure_ffmpeg(settings, BASE_DIR)
    cfg = build_engine_config(raw, settings)
    engine = MediaEngine(cfg, settings)
    platforms = engine.platform_list()
    report = {
        "config": os.path.abspath(config_path),
        "exists": os.path.isfile(config_path),
        "cacheDir": settings.cache_dir,
        "cacheAvailable": bool(cfg.download.cache_dir_available),
        "ffmpeg": ffmpeg or "缺失",
        "platforms": len(platforms),
        "enabled": [item["name"] for item in platforms],
        "maxVideoSizeMb": cfg.download.max_video_size_mb,
        "translation": cfg.translation.enabled,
        "renderTextToImage": cfg.message.text_metadata.render_to_image,
        "python": sys.version.split()[0],
        "serviceId": SERVICE_ID,
        "version": VERSION,
        "sourceHash": source_hash(BASE_DIR),
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if not platforms:
        print("⚠️ 没有任何平台被启用，请检查 parsers 配置", file=sys.stderr)
        return 2
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="媒体解析引擎")
    parser.add_argument(
        "--config",
        default=os.path.join(BASE_DIR, "config.json"),
        help="配置文件路径",
    )
    parser.add_argument("--check", action="store_true", help="仅自检")
    args = parser.parse_args()

    if args.check:
        return _self_check(args.config)

    from service.server import run

    print(f"[引擎] 启动中… 配置={os.path.abspath(args.config)}", flush=True)
    try:
        asyncio.run(run(args.config, BASE_DIR))
    except KeyboardInterrupt:
        print("已停止")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
