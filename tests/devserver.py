"""Local preview server for Terminal Shell.

This is a development-only harness. It serves the real plugin view and uses
the real crypto / terminal core, with a tiny mock of AstrBot's plugin bridge.
Run it to verify the frontend end-to-end without installing AstrBot:

    python tests/devserver.py --port 8765
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import mimetypes
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core.crypto import CryptoError, SessionCipher  # noqa: E402
from core.storage import BackgroundError, BackgroundStore  # noqa: E402
from core.terminal import TerminalError, TerminalManager  # noqa: E402

VIEW_ROOT = ROOT / "views" / "terminal"
USERNAME = "preview"
MAX_UPLOAD = 8 * 1024 * 1024


class PreviewBackend:
    def __init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(
            target=self._run_loop, name="preview-asyncio", daemon=True
        )
        self.thread.start()
        self.cipher = SessionCipher(ttl=3600)
        self.manager = TerminalManager(max_sessions=8, idle_timeout=1800)
        self.background = BackgroundStore(
            ROOT / "tests" / ".devdata" / "backgrounds", MAX_UPLOAD
        )
        self._schedule(self.manager.start_reaper)

    def _run_loop(self) -> None:
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()

    def _schedule(self, fn):
        future = asyncio.run_coroutine_threadsafe(_wrap(fn), self.loop)
        return future.result(10)

    def call_async(self, fn):
        return self._schedule(fn)

    def limits(self) -> dict:
        return {
            "max_sessions": self.manager.max_sessions,
            "idle_timeout": self.manager.idle_timeout,
            "allow_background": True,
            "max_upload_bytes": MAX_UPLOAD,
            "shell": Path(self.manager.shell).name if self.manager.shell else "",
        }

    def get(self, payload, session) -> dict:
        stored = self.background.load(USERNAME)
        if stored is None:
            return {"exists": False}
        return {
            "exists": True,
            "mime": stored["mime"],
            "bytes": stored["bytes"],
            "updated_at": stored["updated_at"],
            "data": base64.b64encode(stored["data"]).decode("ascii"),
        }

    def close(self) -> None:
        try:
            self._schedule(self.manager.shutdown)
        except Exception:
            pass
        self.loop.call_soon_threadsafe(self.loop.stop)


async def _wrap(fn):
    result = fn()
    if asyncio.iscoroutine(result):
        return await result
    return result


BACKEND: PreviewBackend | None = None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "TerminalShellPreview"

    def log_message(self, fmt, *args):  # noqa: N802
        sys.stderr.write("[preview] " + fmt % args + "\n")

    # ------------------------------------------------------------------
    # HTTP
    # ------------------------------------------------------------------
    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/stream":
            self._handle_stream(parsed)
            return
        if parsed.path == "/mock-bridge.js":
            self._send_bytes(
                MOCK_BRIDGE.encode("utf-8"),
                "text/javascript; charset=utf-8",
            )
            return
        if parsed.path == "/":
            html = (VIEW_ROOT / "index.html").read_text(encoding="utf-8")
            html = html.replace(
                "</head>",
                '    <script src="./mock-bridge.js"></script>\n  </head>',
            )
            self._send_bytes(html.encode("utf-8"), "text/html; charset=utf-8")
            return
        self._serve_static(parsed.path)

    def do_POST(self):  # noqa: N802
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            self.send_error(404)
            return
        action = unquote(parsed.path[len("/api/") :])
        try:
            length = int(self.headers.get("content-length", "0"))
            raw = self.rfile.read(length) if length else b"{}"
            body = json.loads(raw.decode("utf-8") or "{}")
            result = self._dispatch(action, body)
            self._send_json(result)
        except CryptoError as exc:
            self._send_json({"status": "error", "message": str(exc)}, 400)
        except (TerminalError, BackgroundError) as exc:
            self._send_json({"status": "error", "message": str(exc)}, 400)
        except Exception as exc:  # pragma: no cover - preview diagnostics
            import traceback

            traceback.print_exc()
            self._send_json({"status": "error", "message": str(exc)}, 500)

    def _dispatch(self, action: str, body: dict):
        assert BACKEND is not None
        if action == "handshake":
            result = BACKEND.cipher.handshake(
                body.get("pub"), USERNAME, label="preview"
            )
            result["limits"] = BACKEND.limits()
            return result

        payload, session = BACKEND.cipher.decrypt(body, action, USERNAME)

        if action == "session":
            info = BACKEND.call_async(
                lambda: BACKEND.manager.create(
                    USERNAME,
                    str(payload.get("owner") or "preview")[:64],
                    int(payload.get("cols") or 100),
                    int(payload.get("rows") or 30),
                )
            )
            info["limits"] = BACKEND.limits()
            return BACKEND.cipher.encrypt(session.sid, action, info)

        if action == "list":
            data = BACKEND.manager.list_sessions(
                USERNAME, str(payload.get("owner") or "") or None
            )
            data["limits"] = BACKEND.limits()
            return BACKEND.cipher.encrypt(session.sid, action, data)

        if action == "input":
            raw = base64.b64decode(payload.get("data") or "")
            BACKEND.manager.write(payload.get("sid"), USERNAME, raw)
            return BACKEND.cipher.encrypt(session.sid, action, {"ok": True})

        if action == "resize":
            BACKEND.manager.resize(
                payload.get("sid"),
                USERNAME,
                int(payload.get("cols") or 100),
                int(payload.get("rows") or 30),
            )
            return BACKEND.cipher.encrypt(session.sid, action, {"ok": True})

        if action == "close":
            BACKEND.call_async(
                lambda: BACKEND.manager.close(payload.get("sid"), USERNAME)
            )
            return BACKEND.cipher.encrypt(session.sid, action, {"ok": True})

        if action == "poll":
            hub = BACKEND.manager.hub_for(USERNAME)
            since = max(0, int(payload.get("since") or 0))
            events = hub.snapshot(since, 1000)
            seq = events[-1]["q"] if events else hub.seq
            return BACKEND.cipher.encrypt(
                session.sid, action, {"events": events, "seq": seq}
            )

        if action == "background/get":
            return BACKEND.cipher.encrypt(
                session.sid, action, BACKEND.get(payload, session)
            )

        if action == "background/upload":
            data = base64.b64decode(payload.get("data") or "")
            result = BACKEND.background.save(
                USERNAME, payload.get("mime"), data
            )
            return BACKEND.cipher.encrypt(
                session.sid, action, {"ok": True, **result}
            )

        if action == "background/reset":
            removed = BACKEND.background.delete(USERNAME)
            return BACKEND.cipher.encrypt(
                session.sid, action, {"ok": True, "removed": removed}
            )

        raise CryptoError(f"预览服务器不支持操作：{action}")

    # ------------------------------------------------------------------
    # SSE
    # ------------------------------------------------------------------
    def _handle_stream(self, parsed) -> None:
        assert BACKEND is not None
        query = parse_qs(parsed.query)
        sid = (query.get("sid") or [""])[0]
        try:
            since = max(0, int((query.get("since") or ["0"])[0]))
        except ValueError:
            since = 0
        try:
            session = BACKEND.cipher.touch(sid, USERNAME)
        except CryptoError as exc:
            self._send_json({"status": "error", "message": str(exc)}, 401)
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        self.close_connection = True

        hub = BACKEND.manager.hub_for(USERNAME)
        last_ping = time.time()
        try:
            self._chunk(b": terminal-shell preview connected\n\n")
            while True:
                events = hub.snapshot(since, 200)
                if events:
                    for event in events:
                        since = event["q"]
                        envelope = BACKEND.cipher.encrypt(
                            session.sid, "stream", event, session=session
                        )
                        data = (
                            "data: "
                            + json.dumps(envelope, separators=(",", ":"))
                            + "\n\n"
                        )
                        self._chunk(data.encode("utf-8"))
                    last_ping = time.time()
                elif time.time() - last_ping > 12:
                    self._chunk(b": keepalive\n\n")
                    last_ping = time.time()
                time.sleep(0.04)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            try:
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except OSError:
                pass

    def _chunk(self, data: bytes) -> None:
        self.wfile.write(f"{len(data):X}\r\n".encode("ascii"))
        self.wfile.write(data)
        self.wfile.write(b"\r\n")
        self.wfile.flush()

    # ------------------------------------------------------------------
    # Static files / responses
    # ------------------------------------------------------------------
    def _serve_static(self, path: str) -> None:
        relative = unquote(path).lstrip("/")
        target = (VIEW_ROOT / relative).resolve()
        try:
            target.relative_to(VIEW_ROOT.resolve())
        except ValueError:
            self.send_error(403)
            return
        if not target.is_file():
            self.send_error(404)
            return
        mime = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if target.suffix == ".js":
            mime = "text/javascript; charset=utf-8"
        elif target.suffix == ".css":
            mime = "text/css; charset=utf-8"
        elif target.suffix == ".html":
            mime = "text/html; charset=utf-8"
        self._send_bytes(target.read_bytes(), mime)

    def _send_bytes(self, data: bytes, mime: str, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _send_json(self, data, status: int = 200) -> None:
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self._send_bytes(payload, "application/json; charset=utf-8", status)


MOCK_BRIDGE = r"""
(() => {
  const subs = new Map();
  window.AstrBotPluginView = {
    async ready() {
      return {
        pluginName: 'astrbot_plugin_terminal_shell',
        displayName: 'Terminal Shell终端',
        pageName: 'terminal',
        locale: 'zh-CN',
        isDark: true
      };
    },
    getContext() { return { isDark: true, locale: 'zh-CN' }; },
    getLocale() { return 'zh-CN'; },
    t(key, fallback) { return fallback; },
    onContext() { return () => {}; },
    async apiGet(endpoint, params) {
      const qs = new URLSearchParams(params || {});
      const res = await fetch('/api/' + endpoint + (qs.size ? '?' + qs : ''));
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || ('HTTP ' + res.status));
      return data;
    },
    async apiPost(endpoint, body) {
      const res = await fetch('/api/' + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || ('HTTP ' + res.status));
      return data;
    },
    async subscribeSSE(endpoint, handlers, params) {
      const qs = new URLSearchParams(params || {});
      const source = new EventSource('/api/' + endpoint + '?' + qs);
      const id = 'sub_' + Math.random().toString(36).slice(2);
      source.onopen = () => handlers.onOpen && handlers.onOpen();
      source.onmessage = (event) => {
        let parsed = event.data;
        try { parsed = JSON.parse(event.data); } catch (_) {}
        if (handlers.onMessage) handlers.onMessage({ raw: event.data, parsed });
      };
      source.onerror = () => handlers.onError && handlers.onError(new Error('SSE error'));
      subs.set(id, source);
      return id;
    },
    async unsubscribeSSE(id) {
      const source = subs.get(id);
      if (source) source.close();
      subs.delete(id);
    }
  };
})();
"""


def main() -> None:
    global BACKEND
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    BACKEND = PreviewBackend()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Terminal Shell preview: http://{args.host}:{args.port}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        BACKEND.close()


if __name__ == "__main__":
    main()
