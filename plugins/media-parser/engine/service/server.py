"""Authenticated loopback service with request deadlines and cache leases."""

from __future__ import annotations

from .network_guard import install_network_guard

install_network_guard()

import asyncio
import hmac
import json
import math
import re
import time
from typing import Any, Dict

from . import paths

paths.install()

from aiohttp import web  # noqa: E402
from core.logger import logger  # noqa: E402
from .cache import CacheBoundaryError, plan_files  # noqa: E402
from .config import (  # noqa: E402
    QQSettings,
    build_engine_config,
    ensure_ffmpeg,
    load_raw_config,
    parse_qq_settings,
)
from .engine import MediaEngine, ParseError  # noqa: E402
from .execution import execute  # noqa: E402
from .identity import VERSION, identity  # noqa: E402

MAX_RESPONSE_BYTES = 4 * 1024 * 1024
JOBS = web.AppKey("jobs", dict)
SHUTDOWN_EVENT = web.AppKey("shutdown_event", asyncio.Event)


def _redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: ("***" if item else "")
            if any(word in str(key).lower() for word in (
                "cookie", "api_key", "apikey", "token", "secret", "password", "authorization"
            ))
            else _redact(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_redact(item) for item in value]
    return value


def create_app(
    engine: MediaEngine,
    settings: QQSettings,
    raw_config: Dict[str, Any],
    *,
    service_identity: dict | None = None,
    shutdown_event: asyncio.Event | None = None,
) -> web.Application:
    from .network_guard import configure_network_guard

    raw_config.setdefault("qq", {})["cacheDir"] = settings.cache_dir
    configure_network_guard(raw_config)
    if len(settings.token) < 24:
        raise ValueError("A local engine token of at least 24 characters is required")
    service_identity = service_identity or identity(paths.BASE_DIR)
    shutdown_event = shutdown_event or asyncio.Event()
    app = web.Application(client_max_size=512 * 1024)
    started_at = time.time()
    jobs: dict[str, asyncio.Task] = {}
    semaphore = asyncio.Semaphore(settings.max_active_requests)
    app[JOBS] = jobs
    app[SHUTDOWN_EVENT] = shutdown_event

    @web.middleware
    async def guard(request: web.Request, handler):
        header = request.headers.get("Authorization", "")
        token = header[7:] if header.lower().startswith("bearer ") else ""
        if not hmac.compare_digest(token.encode(), settings.token.encode()):
            return web.json_response({"ok": False, "error": "Unauthorized"}, status=401)
        try:
            return await handler(request)
        except web.HTTPException:
            raise
        except (ParseError, CacheBoundaryError) as exc:
            from .network_guard import redact_secrets

            return web.json_response(
                redact_secrets({"ok": False, "error": str(exc)}), status=400
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            # Parser exceptions may contain authenticated URLs; keep them out of logs.
            logger.warning("Engine request failed: %s", request.path)
            return web.json_response(
                {"ok": False, "error": "Engine request failed"}, status=500
            )

    app.middlewares.append(guard)

    async def read_json(request):
        try:
            payload = await request.json()
        except (json.JSONDecodeError, ValueError):
            raise web.HTTPBadRequest(
                text='{"ok":false,"error":"Expected a JSON object"}',
                content_type="application/json",
            )
        if not isinstance(payload, dict):
            raise ParseError("Expected a JSON object")
        return payload

    def response(payload):
        from .network_guard import redact_secrets

        payload = redact_secrets(payload)
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        if len(encoded) > MAX_RESPONSE_BYTES:
            raise ParseError("Engine result exceeds the response limit")
        return web.Response(body=encoded, content_type="application/json")

    async def health(request):
        return response({
            "ok": True,
            **service_identity,
            "uptimeSeconds": int(time.time() - started_at),
            "platforms": len(engine.platform_list()),
            "activeRequests": len(jobs),
            "cacheDir": settings.cache_dir,
            "cache": engine.cache.usage(),
            "cacheAvailable": bool(engine.cfg.download.cache_dir_available),
            "translation": bool(engine.cfg.translation.enabled),
            "renderTextToImage": bool(engine.cfg.message.text_metadata.render_to_image),
            "ffmpeg": bool(settings.ffmpeg_path),
        })

    async def platforms(request):
        return response({"ok": True, "platforms": engine.platform_list()})

    async def config_view(request):
        return response({"ok": True, "config": _redact(raw_config)})

    async def monitor_disconnect(request, operation):
        while not operation.done():
            await asyncio.sleep(0.2)
            transport = request.transport
            if transport is None or transport.is_closing():
                operation.cancel()
                return

    async def parse(request):
        payload = await read_json(request)
        text = str(payload.get("text") or "").strip()
        if not text or len(text) > 65536:
            raise ParseError("text must contain 1–65536 characters")
        task_id = str(payload.get("taskId") or "")
        if not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", task_id):
            raise ParseError("A valid taskId is required")
        if task_id in jobs:
            return web.json_response({"ok": False, "error": "Duplicate taskId"}, status=409)
        if len(jobs) >= settings.max_active_requests + 10:
            return web.json_response({"ok": False, "error": "Engine queue is full"}, status=429)
        try:
            requested = float(payload.get("deadlineAt"))
        except (TypeError, ValueError):
            raise ParseError("deadlineAt is required")
        if not math.isfinite(requested):
            raise ParseError("Invalid deadlineAt")
        remaining = min(settings.max_request_seconds, requested / 1000 - time.time())
        if remaining <= 0:
            return web.json_response({"ok": False, "error": "Parse deadline exceeded"}, status=408)

        async def work():
            async with semaphore:
                return await execute(engine.parse(
                    text,
                    user_key=str(payload.get("userKey") or "")[:512],
                    sender_name=str(payload.get("senderName") or "解析结果")[:128],
                    sender_id=str(payload.get("senderId") or "0")[:128],
                    quote_id=str(payload.get("quoteId") or "")[:128],
                    quote_first_text=bool(payload.get("quoteFirstText", False)),
                    limit=min(3, settings.max_links_per_message),
                ))

        operation = asyncio.create_task(work(), name=f"parse:{task_id}")
        jobs[task_id] = operation
        monitor = asyncio.create_task(monitor_disconnect(request, operation))
        try:
            outcome = await asyncio.wait_for(operation, timeout=remaining)
            result = outcome.to_dict()
            # Cap before acquiring a lease so a rejected response cannot pin files.
            response(result)
            local_files = plan_files(result)
            if local_files:
                lease = engine.cache.hold(local_files, seconds=600)
                result["leaseId"] = lease["leaseId"]
                result["leasedFiles"] = lease["files"]
            return response(result)
        except asyncio.TimeoutError:
            return web.json_response({"ok": False, "error": "Parse deadline exceeded"}, status=408)
        except asyncio.CancelledError:
            operation.cancel()
            await asyncio.gather(operation, return_exceptions=True)
            return web.json_response({"ok": False, "error": "Parse cancelled"}, status=409)
        finally:
            monitor.cancel()
            await asyncio.gather(monitor, return_exceptions=True)
            jobs.pop(task_id, None)

    async def cancel(request):
        payload = await read_json(request)
        operation = jobs.get(str(payload.get("taskId") or ""))
        if operation is not None:
            operation.cancel()
            await asyncio.gather(operation, return_exceptions=True)
        return response({"ok": True, "cancelled": operation is not None})

    def files(payload):
        values = payload.get("files") or []
        if not isinstance(values, list) or len(values) > 2048 or any(
            not isinstance(item, str) or len(item) > 4096 for item in values
        ):
            raise ParseError("Invalid files list")
        return values

    async def clean(request):
        return response({"ok": True, "stats": await engine.clean_cache()})

    async def cleanup_files(request):
        payload = await read_json(request)
        return response({"ok": True, "stats": await engine.clean_files(files(payload))})

    async def hold_files(request):
        payload = await read_json(request)
        lease = engine.cache.hold(
            files(payload),
            lease_id=str(payload.get("leaseId") or ""),
            seconds=payload.get("seconds", 600),
        )
        return response({"ok": True, **lease})

    async def release_files(request):
        payload = await read_json(request)
        count = engine.cache.release(
            lease_id=str(payload.get("leaseId") or ""),
            files=files(payload),
        )
        return response({"ok": True, "released": count})

    async def shutdown(request):
        payload = await read_json(request)
        if (
            payload.get("instanceId") != service_identity["instanceId"]
            or payload.get("sourceHash") != service_identity["sourceHash"]
        ):
            return web.json_response({"ok": False, "error": "Instance mismatch"}, status=409)
        asyncio.get_running_loop().call_later(0.05, shutdown_event.set)
        return response({"ok": True, "stopping": True})

    async def on_cleanup(application):
        for operation in list(jobs.values()):
            operation.cancel()
        await asyncio.gather(*list(jobs.values()), return_exceptions=True)

    # Cancel before aiohttp waits for request handlers during graceful shutdown.
    app.on_shutdown.append(on_cleanup)
    app.on_cleanup.append(on_cleanup)
    app.router.add_get("/", health)
    app.router.add_get("/health", health)
    app.router.add_get("/platforms", platforms)
    app.router.add_get("/config", config_view)
    app.router.add_post("/parse", parse)
    app.router.add_post("/cancel", cancel)
    app.router.add_post("/clean", clean)
    app.router.add_post("/cleanup-files", cleanup_files)
    app.router.add_post("/hold-files", hold_files)
    app.router.add_post("/release-files", release_files)
    app.router.add_post("/shutdown", shutdown)
    return app


async def run(config_path: str, base_dir: str) -> None:
    from .network_guard import configure_network_guard, install_parser_guards

    install_parser_guards()
    raw = load_raw_config(config_path)
    settings = parse_qq_settings(raw.get("qq") or {}, base_dir)
    raw.setdefault("qq", {})["cacheDir"] = settings.cache_dir
    configure_network_guard(raw)
    ensure_ffmpeg(settings, base_dir)
    cfg = build_engine_config(raw, settings)
    engine = MediaEngine(cfg, settings)
    shutdown_event = asyncio.Event()
    app = create_app(
        engine, settings, raw,
        service_identity=identity(base_dir),
        shutdown_event=shutdown_event,
    )
    runner = web.AppRunner(app, access_log=None, handler_cancellation=True)
    try:
        await engine.start()
        await runner.setup()
        await web.TCPSite(runner, settings.host, settings.port).start()
        logger.info("Roost media engine ready on loopback port %s", settings.port)
        await shutdown_event.wait()
    finally:
        await runner.cleanup()
        await engine.close()
