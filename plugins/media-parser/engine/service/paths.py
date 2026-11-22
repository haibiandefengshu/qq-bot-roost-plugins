"""引擎路径引导：把 AstrBot 垫片与上游 core 放到导入路径最前面。

上游 `core/` 是通过原样拷贝进来的（见 `vendor/core`），因此这里不改动它一行代码，
只负责让它可以在普通 Python 进程里被导入。
"""

import os
import sys
import types

_BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SHIM_DIR = os.path.join(_BASE_DIR, "vendor", "astrbot_shim")
_VENDOR_DIR = os.path.join(_BASE_DIR, "vendor")


def install(base_dir: str = "") -> None:
    """安装导入路径，可重复调用。

    Args:
        base_dir: 引擎根目录，缺省使用本文件所在目录的上一级。
    """
    root = os.path.abspath(base_dir or _BASE_DIR)
    shim = os.path.join(root, "vendor", "astrbot_shim")
    vendor = os.path.join(root, "vendor")

    # 顺序很关键：垫片必须在真正的 astrbot 之前（本机没有装 AstrBot，
    # 但将来若同机存在 AstrBot，也不能让上游 core 误绑到它的运行时上）。
    for path in (vendor, shim):
        while path in sys.path:
            sys.path.remove(path)
    sys.path.insert(0, vendor)
    sys.path.insert(0, shim)
    # Upstream data/font helpers consult this AstrBot API before falling back to
    # their code directory. Supply only its filesystem helper, rooted in dataDir.
    data_dir = os.environ.get("MEDIA_PARSER_DATA_DIR", "").strip()
    if data_dir:
        for name in ("astrbot.core", "astrbot.core.utils"):
            if name not in sys.modules:
                module = types.ModuleType(name)
                module.__path__ = []
                sys.modules[name] = module
        name = "astrbot.core.utils.astrbot_path"
        if name not in sys.modules:
            module = types.ModuleType(name)
            module.get_astrbot_data_path = lambda: os.path.abspath(data_dir)
            sys.modules[name] = module


install()

BASE_DIR = _BASE_DIR
