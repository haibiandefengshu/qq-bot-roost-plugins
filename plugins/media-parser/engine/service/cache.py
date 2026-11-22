"""Cache leases and deletion that checks the actual path for every file."""

from __future__ import annotations

import os
import stat
import time
import uuid
from pathlib import Path
from urllib.parse import unquote, urlsplit

_MARKERS = {".astrbot_media_parser", ".astrbot_media_parser.expire"}
_REPARSE_POINT = 0x400


class CacheBoundaryError(ValueError):
    pass


class CacheGuard:
    def __init__(self, root: str, *, ttl_seconds: int = 1800, max_bytes: int = 2147483648):
        self.root = Path(root).absolute()
        self.root.mkdir(parents=True, exist_ok=True)
        self.real_root = self.root.resolve(strict=True)
        self.ttl_seconds = max(60, int(ttl_seconds))
        self.max_bytes = max(1, int(max_bytes))
        self.leases: dict[str, tuple[float, set[str]]] = {}

    @staticmethod
    def key(file) -> str:
        return os.path.normcase(str(file))

    def checked(self, reference: str, *, require_file: bool = True) -> Path:
        raw = str(reference or "").strip()
        if raw.startswith("file:"):
            url = urlsplit(raw)
            if url.netloc:
                raise CacheBoundaryError("UNC cache paths are not allowed")
            raw = unquote(url.path)
            if os.name == "nt" and len(raw) > 3 and raw[0] == "/" and raw[2] == ":":
                raw = raw[1:]
        if not raw or raw.startswith(("\\\\", "//")) or "\0" in raw:
            raise CacheBoundaryError("Invalid cache path")
        candidate = Path(raw)
        if not candidate.is_absolute():
            if ".." in candidate.parts:
                raise CacheBoundaryError("Cache path traversal is not allowed")
            candidate = self.root / candidate
        candidate = Path(os.path.abspath(candidate))
        try:
            relative = candidate.relative_to(self.root)
        except ValueError as exc:
            raise CacheBoundaryError("File is outside the configured cache") from exc
        # A changed root, symlink, junction or other reparse point fails closed.
        if self.root.resolve(strict=True) != self.real_root:
            raise CacheBoundaryError("Cache root changed")
        current = self.root
        for part in (Path("."), *relative.parts):
            if part != Path("."):
                current = current / part
            info = current.lstat()
            if stat.S_ISLNK(info.st_mode) or (
                getattr(info, "st_file_attributes", 0) & _REPARSE_POINT
            ):
                raise CacheBoundaryError("Cache symlinks and junctions are not allowed")
        resolved = candidate.resolve(strict=True)
        try:
            resolved.relative_to(self.real_root)
        except ValueError as exc:
            raise CacheBoundaryError("Cache path escapes its root") from exc
        if require_file and not stat.S_ISREG(candidate.stat().st_mode):
            raise CacheBoundaryError("Cache path is not a regular file")
        return candidate

    def _expire_leases(self):
        now = time.time()
        for lease_id, (expires, _) in list(self.leases.items()):
            if expires <= now:
                self.leases.pop(lease_id, None)

    def hold(self, files, *, lease_id: str = "", seconds: int = 600) -> dict:
        self._expire_leases()
        references = {str(self.checked(item)) for item in files}
        checked = {self.key(item) for item in references}
        lease_id = str(lease_id or uuid.uuid4().hex)
        if len(lease_id) > 128:
            raise CacheBoundaryError("Invalid lease ID")
        old = self.leases.get(lease_id, (0, set()))[1]
        self.leases[lease_id] = (time.time() + max(30, min(3600, int(seconds))), old | checked)
        return {"leaseId": lease_id, "files": sorted(references)}

    def release(self, *, lease_id: str = "", files=None) -> int:
        self._expire_leases()
        if lease_id:
            old = self.leases.pop(str(lease_id), None)
            return len(old[1]) if old else 0
        # Resolve paths even for release: caller paths never become deletion targets.
        checked = set()
        for item in files or []:
            try:
                checked.add(self.key(self.checked(item)))
            except (OSError, ValueError):
                continue
        released = 0
        for key, (expires, pinned) in list(self.leases.items()):
            released += len(pinned & checked)
            remaining = pinned - checked
            if remaining:
                self.leases[key] = (expires, remaining)
            else:
                self.leases.pop(key, None)
        return released

    def pinned(self) -> set[str]:
        self._expire_leases()
        return set().union(*(entry[1] for entry in self.leases.values())) if self.leases else set()

    def remove_files(self, files) -> dict:
        pins = self.pinned()
        removed = skipped = failed = 0
        for reference in dict.fromkeys(files):
            try:
                candidate = self.checked(reference)
                if self.key(candidate) in pins:
                    skipped += 1
                    continue
                # Re-check immediately before unlink. No recursive deletion is used.
                self.checked(str(candidate)).unlink()
                removed += 1
            except FileNotFoundError:
                skipped += 1
            except (OSError, ValueError):
                failed += 1
        return {"files": removed, "pinned": skipped, "failed": failed}

    def _files(self):
        # Never follow directory links, and leave parser credentials/records alone.
        for parent, dirs, names in os.walk(self.root, followlinks=False):
            safe_dirs = []
            for name in dirs:
                try:
                    info = Path(parent, name).lstat()
                    if name != "runtime_manager" and not stat.S_ISLNK(info.st_mode) and not (
                        getattr(info, "st_file_attributes", 0) & _REPARSE_POINT
                    ):
                        safe_dirs.append(name)
                except OSError:
                    pass
            dirs[:] = safe_dirs
            for name in names:
                if name in _MARKERS:
                    continue
                try:
                    candidate = self.checked(str(Path(parent, name)))
                    info = candidate.stat()
                    yield candidate, info
                except (OSError, ValueError):
                    continue

    def clean(self, *, all_files: bool = False, busy: bool = False) -> dict:
        if busy:
            return {"files": 0, "pinned": 0, "failed": 0, "busy": True}
        files = sorted(self._files(), key=lambda entry: entry[1].st_mtime)
        total = sum(info.st_size for _, info in files)
        pins = self.pinned()
        cutoff = time.time() - self.ttl_seconds
        targets = []
        for candidate, info in files:
            if self.key(candidate) in pins:
                continue
            if all_files or info.st_mtime <= cutoff or total > self.max_bytes:
                targets.append(str(candidate))
                total -= info.st_size
        stats = self.remove_files(targets)
        self._prune_empty()
        stats["pinned"] += sum(self.key(candidate) in pins for candidate, _ in files)
        stats["bytes"] = total
        return stats

    def _prune_empty(self):
        directories = []
        for parent, dirs, _ in os.walk(self.root, followlinks=False):
            dirs[:] = [
                name for name in dirs
                if name != "runtime_manager" and self._safe_directory(Path(parent, name))
            ]
            directories.extend(Path(parent, name) for name in dirs)
        for directory in reversed(directories):
            try:
                self.checked(str(directory), require_file=False)
                names = os.listdir(directory)
                if set(names).issubset(_MARKERS):
                    for name in names:
                        self.checked(str(directory / name)).unlink()
                    self.checked(str(directory), require_file=False).rmdir()
            except (OSError, ValueError):
                pass

    def _safe_directory(self, directory: Path) -> bool:
        try:
            info = directory.lstat()
            return not stat.S_ISLNK(info.st_mode) and not (
                getattr(info, "st_file_attributes", 0) & _REPARSE_POINT
            )
        except OSError:
            return False

    def usage(self) -> dict:
        entries = list(self._files())
        return {
            "files": len(entries),
            "bytes": sum(info.st_size for _, info in entries),
            "pinned": len(self.pinned()),
        }


def plan_files(value) -> list[str]:
    """Collect local media references without treating message text as a path."""
    found = []
    if isinstance(value, dict):
        if value.get("type") in {"image", "video", "record", "file"}:
            data = value.get("data") or {}
            reference = data.get("file") or data.get("path")
            if isinstance(reference, str) and not reference.startswith(("http:", "https:")):
                found.append(reference)
        for key in ("messages", "segments", "nodes", "data", "content", "plan"):
            if key in value:
                found.extend(plan_files(value[key]))
    elif isinstance(value, list):
        for item in value:
            found.extend(plan_files(item))
    return list(dict.fromkeys(found))
