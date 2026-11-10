"""Terminal Shell — a multi-tab web shell for AstrBot.

The plugin exposes a restricted iframe view (``views/terminal``) and a small
encrypted Web API. Every API call except the initial ECDH handshake is wrapped
in an AES-256-GCM envelope; the same applies to every SSE frame.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
from pathlib import Path
from typing import Any

from astrbot.api import AstrBotConfig, logger
from astrbot.api.star import Context, Star
from astrbot.api.web import (
    error_response,
    json_response,
    request,
    stream_response,
)
from astrbot.core.utils.astrbot_path import get_astrbot_plugin_data_path

from .core.crypto import CryptoError, SessionCipher
from .core.storage import BackgroundError, BackgroundStore
from .core.terminal import TerminalError, TerminalManager

PLUGIN_NAME = "astrbot_plugin_terminal_shell"
VIEW_NAME = "terminal"
PLUGIN_DIR_NAME = Path(__file__).resolve().parent.name
ROUTE_PREFIXES = tuple(
    dict.fromkeys(
        prefix
        for prefix in (PLUGIN_NAME, PLUGIN_DIR_NAME)
        if prefix and "/" not in prefix and "\\" not in prefix
    )
)


class TerminalShellPlugin(Star):
    """AstrBot entry point."""

    def __init__(self, context: Context, config: AstrBotConfig | None = None):
        super().__init__(context)
        self.config: Any = config or {}

        self.cipher = SessionCipher(
            ttl=self._config_int("session_ttl", 3600),
            max_sessions=512,
        )
        self.manager = TerminalManager(
            shell=self._config_str("shell", ""),
            cwd=self._config_str("cwd", ""),
            max_sessions=self._config_int("max_sessions", 8),
            idle_timeout=self._config_int("idle_timeout", 1800),
            max_total=max(16, self._config_int("max_sessions", 8) * 6),
        )

        try:
            data_root = Path(get_astrbot_plugin_data_path()) / PLUGIN_NAME
        except Exception:
            data_root = Path(__file__).resolve().parent / "data"
        self.background = BackgroundStore(
            data_root / "backgrounds",
            max_bytes=self._config_int("max_upload_mb", 8) * 1024 * 1024,
        )

        self._register_web_apis()

    # ------------------------------------------------------------------
    # Config helpers
    # ------------------------------------------------------------------
    def _config_bool(self, key: str, default: bool) -> bool:
        value = self.config.get(key, default) if self.config else default
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "on"}
        return bool(value)

    def _config_int(self, key: str, default: int) -> int:
        value = self.config.get(key, default) if self.config else default
        try:
            return int(value)
        except (TypeError, ValueError):
            return default

    def _config_str(self, key: str, default: str) -> str:
        value = self.config.get(key, default) if self.config else default
        return value.strip() if isinstance(value, str) else default

    def _config_list(self, key: str) -> list[str]:
        value = self.config.get(key, []) if self.config else []
        if not isinstance(value, list):
            return []
        return [str(item).strip() for item in value if str(item).strip()]

    def _limits(self) -> dict[str, Any]:
        return {
            "max_sessions": self.manager.max_sessions,
            "idle_timeout": self.manager.idle_timeout,
            "allow_background": self._config_bool(
                "allow_background_upload", True
            ),
            "max_upload_bytes": self._config_int("max_upload_mb", 8)
            * 1024
            * 1024,
            "shell": Path(self.manager.shell).name
            if self.manager.shell
            else "",
        }

    # ------------------------------------------------------------------
    # Access control
    # ------------------------------------------------------------------
    def _guard(self):
        if not self._config_bool("enabled", True):
            return error_response("终端插件已被管理员禁用", status_code=403)
        allowed = self._config_list("allowed_users")
        username = request.username
        if allowed and (not username or username not in allowed):
            return error_response("当前用户没有使用终端的权限", status_code=403)
        return None

    async def _open(self, action: str):
        """Check access, parse and decrypt one JSON envelope."""
        denied = self._guard()
        if denied is not None:
            return None, None, denied
        envelope = await request.json(default=None)
        try:
            payload, session = self.cipher.decrypt(
                envelope, action, request.username
            )
        except CryptoError as exc:
            return None, None, error_response(str(exc), status_code=400)
        return payload, session, None

    # ------------------------------------------------------------------
    # Web API registration
    # ------------------------------------------------------------------
    def _register_web_apis(self) -> None:
        routes = [
            ("handshake", self.api_handshake, ["POST"], "ECDH handshake"),
            ("session", self.api_session, ["POST"], "Create terminal"),
            ("list", self.api_list, ["POST"], "List terminals"),
            ("input", self.api_input, ["POST"], "Write terminal input"),
            ("resize", self.api_resize, ["POST"], "Resize terminal"),
            ("close", self.api_close, ["POST"], "Close terminal"),
            ("poll", self.api_poll, ["POST"], "Poll output events"),
            ("stream", self.api_stream, ["GET"], "Encrypted output stream"),
            (
                "background/get",
                self.api_background_get,
                ["POST"],
                "Load background",
            ),
            (
                "background/upload",
                self.api_background_upload,
                ["POST"],
                "Upload background",
            ),
            (
                "background/reset",
                self.api_background_reset,
                ["POST"],
                "Reset background",
            ),
        ]
        for route, handler, methods, desc in routes:
            for prefix in ROUTE_PREFIXES:
                self.context.register_web_api(
                    f"/{prefix}/{route}",
                    handler,
                    methods,
                    desc,
                )

    # ------------------------------------------------------------------
    # Handshake
    # ------------------------------------------------------------------
    async def api_handshake(self):
        denied = self._guard()
        if denied is not None:
            return denied
        payload = await request.json(default={})
        if not isinstance(payload, dict):
            return error_response("请求体格式不正确", status_code=400)
        try:
            result = self.cipher.handshake(
                payload.get("pub"),
                request.username,
                label=str(payload.get("label") or "")[:64],
            )
        except CryptoError as exc:
            return error_response(str(exc), status_code=400)
        except Exception:
            logger.exception("Terminal Shell handshake failed")
            return error_response("建立加密通道失败", status_code=500)
        result["limits"] = self._limits()
        return json_response(result)

    # ------------------------------------------------------------------
    # Terminal lifecycle
    # ------------------------------------------------------------------
    async def api_session(self):
        payload, session, error = await self._open("session")
        if error is not None:
            return error
        assert payload is not None and session is not None
        try:
            owner = str(payload.get("owner") or "default")[:64]
            cols = int(payload.get("cols") or 100)
            rows = int(payload.get("rows") or 30)
            info = self.manager.create(request.username, owner, cols, rows)
        except (TypeError, ValueError):
            return error_response("终端尺寸参数不正确", status_code=400)
        except TerminalError as exc:
            return error_response(str(exc), status_code=400)
        except Exception:
            logger.exception("Terminal Shell failed to create a session")
            return error_response("创建终端失败，请查看 AstrBot 日志", status_code=500)
        info["limits"] = self._limits()
        return json_response(self.cipher.encrypt(session.sid, "session", info))

    async def api_list(self):
        payload, session, error = await self._open("list")
        if error is not None:
            return error
        assert payload is not None and session is not None
        owner = str(payload.get("owner") or "")[:64]
        try:
            data = self.manager.list_sessions(request.username, owner or None)
        except Exception:
            logger.exception("Terminal Shell failed to list sessions")
            return error_response("读取终端列表失败", status_code=500)
        data["limits"] = self._limits()
        self.cipher.cleanup()
        return json_response(self.cipher.encrypt(session.sid, "list", data))

    async def api_input(self):
        payload, session, error = await self._open("input")
        if error is not None:
            return error
        assert payload is not None and session is not None
        sid = payload.get("sid")
        data = payload.get("data")
        if not isinstance(sid, str) or not isinstance(data, str):
            return error_response("输入参数不正确", status_code=400)
        try:
            raw = base64.b64decode(data.encode("ascii"), validate=True)
        except (binascii.Error, UnicodeEncodeError, ValueError):
            return error_response("输入数据不是合法 Base64", status_code=400)
        try:
            self.manager.write(sid, request.username, raw)
        except TerminalError as exc:
            return error_response(str(exc), status_code=400)
        return json_response(self.cipher.encrypt(session.sid, "input", {"ok": True}))

    async def api_resize(self):
        payload, session, error = await self._open("resize")
        if error is not None:
            return error
        assert payload is not None and session is not None
        sid = payload.get("sid")
        if not isinstance(sid, str):
            return error_response("终端 ID 不正确", status_code=400)
        try:
            cols = int(payload.get("cols") or 100)
            rows = int(payload.get("rows") or 30)
        except (TypeError, ValueError):
            return error_response("终端尺寸参数不正确", status_code=400)
        try:
            self.manager.resize(sid, request.username, cols, rows)
        except TerminalError as exc:
            return error_response(str(exc), status_code=400)
        return json_response(
            self.cipher.encrypt(session.sid, "resize", {"ok": True})
        )

    async def api_close(self):
        payload, session, error = await self._open("close")
        if error is not None:
            return error
        assert payload is not None and session is not None
        sid = payload.get("sid")
        if not isinstance(sid, str):
            return error_response("终端 ID 不正确", status_code=400)
        try:
            await self.manager.close(sid, request.username)
        except TerminalError as exc:
            return error_response(str(exc), status_code=400)
        return json_response(
            self.cipher.encrypt(session.sid, "close", {"ok": True})
        )

    # ------------------------------------------------------------------
    # Output stream / polling fallback
    # ------------------------------------------------------------------
    async def api_poll(self):
        payload, session, error = await self._open("poll")
        if error is not None:
            return error
        assert payload is not None and session is not None
        try:
            since = max(0, int(payload.get("since") or 0))
        except (TypeError, ValueError):
            since = 0
        hub = self.manager.hub_for(request.username)
        events = hub.snapshot(since, 1000)
        last_seq = events[-1]["q"] if events else hub.seq
        return json_response(
            self.cipher.encrypt(
                session.sid,
                "poll",
                {"events": events, "seq": last_seq},
            )
        )

    async def api_stream(self):
        denied = self._guard()
        if denied is not None:
            return denied
        sid = request.query.get("sid", "")
        try:
            since = int(request.query.get("since", 0, type=int) or 0)
        except (TypeError, ValueError):
            since = 0
        try:
            secure_session = self.cipher.touch(sid, request.username)
        except CryptoError as exc:
            return error_response(str(exc), status_code=401)

        username = request.username
        hub = self.manager.hub_for(username)
        queue = hub.subscribe(max(0, since))

        async def event_stream():
            try:
                yield ": terminal-shell connected\n\n"
                while True:
                    try:
                        event = await asyncio.wait_for(queue.get(), timeout=15)
                    except asyncio.TimeoutError:
                        yield ": keepalive\n\n"
                        continue
                    if event is None:
                        break
                    envelope = self.cipher.encrypt(
                        secure_session.sid,
                        "stream",
                        event,
                        session=secure_session,
                    )
                    yield (
                        "data: "
                        + json.dumps(envelope, separators=(",", ":"))
                        + "\n\n"
                    )
            except asyncio.CancelledError:
                raise
            finally:
                hub.unsubscribe(queue)

        return stream_response(
            event_stream(),
            headers={
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
                "Connection": "keep-alive",
            },
        )

    # ------------------------------------------------------------------
    # Background image
    # ------------------------------------------------------------------
    async def api_background_get(self):
        payload, session, error = await self._open("background/get")
        if error is not None:
            return error
        assert session is not None
        stored = self.background.load(request.username)
        if stored is None:
            data = {"exists": False}
        else:
            data = {
                "exists": True,
                "mime": stored["mime"],
                "bytes": stored["bytes"],
                "updated_at": stored["updated_at"],
                "data": base64.b64encode(stored["data"]).decode("ascii"),
            }
        return json_response(
            self.cipher.encrypt(session.sid, "background/get", data)
        )

    async def api_background_upload(self):
        if not self._config_bool("allow_background_upload", True):
            return error_response("管理员已关闭自定义背景上传", status_code=403)
        payload, session, error = await self._open("background/upload")
        if error is not None:
            return error
        assert payload is not None and session is not None
        mime = payload.get("mime")
        encoded = payload.get("data")
        if not isinstance(mime, str) or not isinstance(encoded, str):
            return error_response("背景图片参数不正确", status_code=400)
        try:
            raw = base64.b64decode(encoded.encode("ascii"), validate=True)
        except (binascii.Error, UnicodeEncodeError, ValueError):
            return error_response("背景图片不是合法 Base64", status_code=400)
        try:
            result = self.background.save(request.username, mime, raw)
        except BackgroundError as exc:
            return error_response(str(exc), status_code=400)
        except Exception:
            logger.exception("Terminal Shell failed to save background")
            return error_response("保存背景图片失败", status_code=500)
        return json_response(
            self.cipher.encrypt(
                session.sid,
                "background/upload",
                {"ok": True, **result},
            )
        )

    async def api_background_reset(self):
        payload, session, error = await self._open("background/reset")
        if error is not None:
            return error
        assert session is not None
        try:
            removed = self.background.delete(request.username)
        except BackgroundError as exc:
            return error_response(str(exc), status_code=400)
        return json_response(
            self.cipher.encrypt(
                session.sid,
                "background/reset",
                {"ok": True, "removed": removed},
            )
        )

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    async def initialize(self):
        self.manager.start_reaper()
        logger.info(
            "Terminal Shell 已启动：视图 views/%s，加密会话 TTL %s 秒",
            VIEW_NAME,
            self.cipher.ttl,
        )

    async def terminate(self):
        await self.manager.shutdown()
        self.cipher.clear()
        logger.info("Terminal Shell 已停止，所有终端已关闭")
