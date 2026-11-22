"""Roost service adapter. Install network policy before importing upstream."""

from .network_guard import install_network_guard
from .execution import install_subprocess_guard

install_network_guard()
install_subprocess_guard()

from .config import QQSettings, build_engine_config, load_raw_config, parse_qq_settings
from .engine import MediaEngine, ParseError, ParseOutcome

__all__ = [
    "QQSettings",
    "build_engine_config",
    "load_raw_config",
    "parse_qq_settings",
    "MediaEngine",
    "ParseError",
    "ParseOutcome",
]
