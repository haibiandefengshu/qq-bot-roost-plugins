"""Identity shared by the Roost host and the authenticated local service."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

SERVICE_ID = "roost-media-parser"
VERSION = "0.1.0"
ORIGINAL_ARCHIVE_SHA256 = "d75f10eba41d3c202696d3da7c5c5efce1135b39401fd4cf170075e37bba9c05"
_STATIC_NAMES = {"requirements.txt", "config.example.json", "LICENSE", "README.md"}


def source_hash(base_dir: str) -> str:
    """Hash shipped source, independent of bytecode and generated runtime files."""
    root = Path(base_dir)
    digest = hashlib.sha256()
    files = [
        item
        for item in root.rglob("*")
        if item.is_file()
        and "__pycache__" not in item.parts
        and (item.suffix == ".py" or item.name in _STATIC_NAMES)
    ]
    for item in sorted(files, key=lambda value: value.relative_to(root).as_posix()):
        digest.update(item.relative_to(root).as_posix().encode("utf-8") + b"\0")
        digest.update(item.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def identity(base_dir: str) -> dict:
    instance_id = os.environ.get("MEDIA_PARSER_INSTANCE_ID", "").strip()
    if not instance_id:
        raise RuntimeError("MEDIA_PARSER_INSTANCE_ID is required")
    actual_hash = source_hash(base_dir)
    expected_hash = os.environ.get("MEDIA_PARSER_SOURCE_HASH", "").strip()
    if expected_hash and expected_hash != actual_hash:
        raise RuntimeError("Engine source hash does not match the prepared bundle")
    return {
        "serviceId": SERVICE_ID,
        "version": VERSION,
        "instanceId": instance_id,
        "sourceHash": actual_hash,
        "pid": os.getpid(),
    }
