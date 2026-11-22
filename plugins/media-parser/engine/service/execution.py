"""Track subprocesses per request and hide Windows subprocess consoles."""

from __future__ import annotations

import asyncio
import contextvars
import os
import subprocess
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Execution:
    processes: set[Any] = field(default_factory=set)


_execution: contextvars.ContextVar[Execution | None] = contextvars.ContextVar(
    "roost_media_execution", default=None
)
_installed = False


async def _finish(task):
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            continue
    return task.result()


def install_subprocess_guard() -> None:
    """Install before upstream imports; no changes to vendor files are required."""
    global _installed
    if _installed:
        return
    _installed = True
    original = asyncio.create_subprocess_exec

    async def create_subprocess_exec(*args, **kwargs):
        from .network_guard import guard_subprocess_args

        args = guard_subprocess_args(args)
        if os.name == "nt":
            kwargs["creationflags"] = (
                kwargs.get("creationflags", 0) | subprocess.CREATE_NO_WINDOW
            )
        operation = asyncio.create_task(original(*args, **kwargs))
        execution = _execution.get()
        try:
            process = await asyncio.shield(operation)
        except asyncio.CancelledError:
            # A cancellation between CreateProcess and its return must not orphan it.
            process = await _finish(operation)
            if execution is not None:
                execution.processes.add(process)
            if process.returncode is None:
                process.kill()
            await process.wait()
            raise
        if execution is not None:
            execution.processes.add(process)
        return process

    asyncio.create_subprocess_exec = create_subprocess_exec


async def execute(awaitable):
    """Keep request ownership through inherited parser/downloader tasks."""
    execution = Execution()
    token = _execution.set(execution)
    try:
        return await awaitable
    finally:
        _execution.reset(token)
        # Upstream normally reaps ffmpeg; this also covers unexpected exceptions.
        for process in execution.processes:
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
        if execution.processes:
            await asyncio.gather(
                *(process.wait() for process in execution.processes),
                return_exceptions=True,
            )
