"""Cross-platform PTY terminal sessions and the output fan-out hub.

Unix uses a real PTY through :mod:`pty`. Windows prefers ConPTY through
``pywinpty`` (installed from requirements.txt) and falls back to plain pipes
when the optional package is unavailable.

The module deliberately has no AstrBot imports so it can be unit tested and
reused by the development preview server.
"""

from __future__ import annotations

import asyncio
import base64
import locale
import os
import secrets
import shutil
import signal
import subprocess
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .guard import TerminalLineGuard

IS_WINDOWS = os.name == "nt"
# Keep enough transcript for a full xterm scrollback so a destroyed iframe
# (for example when navigating to another AstrBot page) can be rebuilt.
HISTORY_BYTES = 512 * 1024
MAX_INPUT_BYTES = 64 * 1024
MAX_POLL_EVENTS = 200
LOCALE_ENCODING = locale.getpreferredencoding(False) or "utf-8"


class TerminalError(Exception):
    """A user-facing terminal error."""


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _home_dir() -> str:
    if IS_WINDOWS:
        return os.environ.get("USERPROFILE") or os.path.expanduser("~")
    return os.environ.get("HOME") or os.path.expanduser("~")


def default_shell() -> str:
    """Return a sensible interactive shell for the current platform."""
    if IS_WINDOWS:
        for candidate in ("pwsh.exe", "powershell.exe"):
            found = shutil.which(candidate)
            if found:
                return found
        return os.environ.get("COMSPEC", "cmd.exe")
    for candidate in (os.environ.get("SHELL"), "/bin/bash", "/bin/zsh", "/bin/sh"):
        if candidate and os.path.exists(candidate):
            return candidate
    return "/bin/sh"


def shell_argv(shell: str) -> list[str]:
    """Build the argv used to launch the interactive shell."""
    name = Path(shell).name.lower()
    if name in {"pwsh.exe", "pwsh", "powershell.exe", "powershell"}:
        return [shell, "-NoLogo"]
    if name in {"cmd.exe", "cmd"}:
        return [shell]
    return [shell]


def _shell_env() -> dict[str, str]:
    env = {str(k): str(v) for k, v in os.environ.items()}
    env.setdefault("TERM", "xterm-256color")
    env.setdefault("COLORTERM", "truecolor")
    if IS_WINDOWS:
        env.setdefault("PYTHONUTF8", "1")
    return env


class OutputHub:
    """Replayable, per-user output fan-out.

    Each event has a monotonically increasing ``q`` sequence number. New SSE
    subscribers can replay the recent ring buffer, which makes reconnects and
    page reloads lossless for the retained window.
    """

    def __init__(self, max_buffer_bytes: int = 320 * 1024, queue_size: int = 256):
        self._events: deque[dict[str, Any]] = deque()
        self._buffer_bytes = 0
        self._max_buffer_bytes = max(32 * 1024, int(max_buffer_bytes))
        self._queue_size = max(16, int(queue_size))
        self._seq = 0
        self._subscribers: set[asyncio.Queue[dict[str, Any] | None]] = set()
        self._closed = False

    @property
    def seq(self) -> int:
        return self._seq

    @property
    def has_subscribers(self) -> bool:
        return bool(self._subscribers)

    def publish(self, event: dict[str, Any]) -> None:
        if self._closed:
            return
        self._seq += 1
        evt = dict(event)
        evt["q"] = self._seq
        self._events.append(evt)
        self._buffer_bytes += self._event_size(evt)
        while (
            self._buffer_bytes > self._max_buffer_bytes and len(self._events) > 1
        ):
            old = self._events.popleft()
            self._buffer_bytes -= self._event_size(old)

        for queue in list(self._subscribers):
            try:
                queue.put_nowait(evt)
            except asyncio.QueueFull:
                # Keep the newest data. Terminal users prefer fresh output to
                # a stalled stream; the client can detect the missing seq.
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    queue.put_nowait(evt)
                except asyncio.QueueFull:
                    pass

    @staticmethod
    def _event_size(event: dict[str, Any]) -> int:
        data = event.get("d")
        return 96 + (len(data) if isinstance(data, str) else 0)

    def snapshot(self, since: int, limit: int = MAX_POLL_EVENTS) -> list[dict[str, Any]]:
        if since < 0:
            since = 0
        result: list[dict[str, Any]] = []
        for event in self._events:
            if event.get("q", 0) > since:
                result.append(event)
                if len(result) >= limit:
                    break
        return result

    def subscribe(self, since: int = 0) -> asyncio.Queue[dict[str, Any] | None]:
        queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue(
            maxsize=self._queue_size
        )
        for event in self.snapshot(since, self._queue_size):
            queue.put_nowait(event)
        if self._closed:
            queue.put_nowait(None)
        else:
            self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[dict[str, Any] | None]) -> None:
        self._subscribers.discard(queue)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(None)
            except asyncio.QueueFull:
                pass
        self._subscribers.clear()


@dataclass
class TerminalSession:
    """One shell process plus its retained output."""

    sid: str
    title: str
    owner: str
    username: str | None
    shell: str
    cwd: str
    cols: int
    rows: int
    manager: "TerminalManager"
    created_at: float = field(default_factory=time.time)
    last_active: float = field(default_factory=time.time)
    finished_at: float = 0.0
    alive: bool = True
    exit_code: int | None = None
    exit_reason: str = ""
    backend: str = "unknown"
    history: bytearray = field(default_factory=bytearray)
    line_guard: TerminalLineGuard = field(default_factory=TerminalLineGuard)

    _proc: Any = None
    _master_fd: int | None = None
    _loop: asyncio.AbstractEventLoop | None = None
    _loop_thread_id: int | None = None
    _reader_thread: threading.Thread | None = None
    _stop_reader: threading.Event = field(default_factory=threading.Event)
    _pipe_buffer: bytearray = field(default_factory=bytearray)
    _closed: bool = False
    _finished: bool = False
    _notified: bool = False
    _lock: threading.Lock = field(default_factory=threading.Lock)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._loop_thread_id = threading.get_ident()
        if IS_WINDOWS:
            self._start_windows()
        else:
            self._start_unix()

    def _start_unix(self) -> None:
        import pty

        argv = shell_argv(self.shell)
        master_fd, slave_fd = pty.openpty()
        try:
            self._set_winsize_fd(master_fd)
            self._proc = subprocess.Popen(
                argv,
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=slave_fd,
                cwd=self.cwd,
                env=_shell_env(),
                start_new_session=True,
                close_fds=True,
            )
        except Exception as exc:
            os.close(master_fd)
            os.close(slave_fd)
            raise TerminalError(f"无法启动 Shell：{exc}") from exc

        os.close(slave_fd)
        os.set_blocking(master_fd, False)
        self._master_fd = master_fd
        self.backend = "pty"
        assert self._loop is not None
        self._loop.add_reader(master_fd, self._on_readable)

    def _start_windows(self) -> None:
        argv = shell_argv(self.shell)
        try:
            from winpty import PtyProcess  # type: ignore
        except Exception:
            self._start_windows_pipes(argv)
            return

        try:
            self._proc = PtyProcess.spawn(
                argv,
                cwd=self.cwd,
                env=_shell_env(),
                dimensions=(self.rows, self.cols),
            )
        except Exception as exc:
            raise TerminalError(
                f"无法启动 Shell（ConPTY）：{exc}。请确认已安装 pywinpty。"
            ) from exc

        self.backend = "conpty"
        self._reader_thread = threading.Thread(
            target=self._read_conpty,
            name=f"terminal-{self.sid}",
            daemon=True,
        )
        self._reader_thread.start()

    def _start_windows_pipes(self, argv: list[str]) -> None:
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        try:
            self._proc = subprocess.Popen(
                argv,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                bufsize=0,
                cwd=self.cwd,
                env=_shell_env(),
                creationflags=creationflags,
            )
        except Exception as exc:
            raise TerminalError(f"无法启动 Shell：{exc}") from exc

        self.backend = "pipe"
        self._reader_thread = threading.Thread(
            target=self._read_pipe,
            name=f"terminal-{self.sid}",
            daemon=True,
        )
        self._reader_thread.start()

    def _close_pipe_streams(self) -> None:
        for name in ("stdin", "stdout"):
            stream = getattr(self._proc, name, None)
            if stream is not None:
                try:
                    stream.close()
                except Exception:
                    pass

    # ------------------------------------------------------------------
    # Readers
    # ------------------------------------------------------------------
    def _on_readable(self) -> None:
        fd = self._master_fd
        if fd is None or self._closed:
            return
        while True:
            try:
                chunk = os.read(fd, 65536)
            except BlockingIOError:
                return
            except OSError:
                self._finish_once(None, "exit")
                return
            if not chunk:
                self._finish_once(None, "exit")
                return
            self._emit(chunk)

    def _read_conpty(self) -> None:
        proc = self._proc
        while not self._stop_reader.is_set():
            try:
                text = proc.read(4096)
            except EOFError:
                break
            except Exception:
                break
            if not text:
                try:
                    if not proc.isalive():
                        break
                except Exception:
                    break
                time.sleep(0.005)
                continue
            self._emit_threadsafe(text.encode("utf-8", "replace"))
        self._finish_from_thread()

    def _read_pipe(self) -> None:
        proc = self._proc
        stream = getattr(proc, "stdout", None)
        if stream is None:
            self._finish_from_thread()
            return
        fd = stream.fileno()
        while not self._stop_reader.is_set():
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                break
            if not chunk:
                break
            self._pipe_buffer.extend(chunk)
            self._flush_pipe_lines(final=False)
            # A shell prompt has no trailing newline. Emit buffered UTF-8
            # immediately so the prompt is visible before the user types;
            # invalid/OEM-code-page partial lines stay buffered until \n.
            if self._pipe_buffer:
                try:
                    text = bytes(self._pipe_buffer).decode("utf-8")
                except UnicodeDecodeError:
                    pass
                else:
                    self._pipe_buffer.clear()
                    self._emit_threadsafe(text.encode("utf-8"))
        self._flush_pipe_lines(final=True)
        self._finish_from_thread()

    def _flush_pipe_lines(self, final: bool) -> None:
        """Convert mixed Windows pipe encodings to UTF-8 line by line.

        Windows PowerShell writes its startup warning in the OEM code page but
        console input/output as UTF-8. Decoding the whole stream with one codec
        therefore produces mojibake. Splitting on newlines lets each line use
        the first codec that decodes cleanly.
        """
        while True:
            index = self._pipe_buffer.find(b"\n")
            if index < 0:
                break
            line = bytes(self._pipe_buffer[:index])
            del self._pipe_buffer[: index + 1]
            self._emit_threadsafe(self._decode_pipe_line(line))
        if final and self._pipe_buffer:
            line = bytes(self._pipe_buffer)
            self._pipe_buffer.clear()
            self._emit_threadsafe(self._decode_pipe_line(line))

    @staticmethod
    def _decode_pipe_line(raw: bytes) -> bytes:
        raw = raw.rstrip(b"\r")
        for encoding in ("utf-8", LOCALE_ENCODING, "gb18030"):
            try:
                text = raw.decode(encoding)
                break
            except (UnicodeDecodeError, LookupError):
                continue
        else:
            text = raw.decode("utf-8", "replace")
        return (text + "\r\n").encode("utf-8")

    # ------------------------------------------------------------------
    # Output / lifecycle notifications
    # ------------------------------------------------------------------
    def _emit(self, chunk: bytes) -> None:
        if not chunk:
            return
        self.last_active = time.time()
        self.history.extend(chunk)
        if len(self.history) > HISTORY_BYTES:
            del self.history[: len(self.history) - HISTORY_BYTES]
        self.manager.publish_output(self, chunk)

    def notice(self, message: str) -> None:
        """Render an internal notice without sending it to the shell."""
        if not self.alive:
            return
        line = (
            f"\r\n\x1b[38;2;255;196;107m[Terminal Shell] {message}"
            "\x1b[0m\r\n"
        )
        self._emit(line.encode("utf-8"))

    def _emit_threadsafe(self, chunk: bytes) -> None:
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        loop.call_soon_threadsafe(self._emit, chunk)

    def _finish_from_thread(self) -> None:
        code: int | None = None
        try:
            if hasattr(self._proc, "exitstatus"):
                code = self._proc.exitstatus
            elif hasattr(self._proc, "poll"):
                code = self._proc.poll()
        except Exception:
            code = None
        self._notify_finish(code, "exit")

    def _notify_finish(self, code: int | None, reason: str) -> None:
        """Finalize on the event-loop thread, even when called by a worker."""
        loop = self._loop
        if (
            loop is not None
            and not loop.is_closed()
            and threading.get_ident() != self._loop_thread_id
        ):
            loop.call_soon_threadsafe(self._finish_once, code, reason)
        else:
            self._finish_once(
                code,
                reason,
                dispatch=loop is not None and not loop.is_closed(),
            )

    def _finish_once(
        self,
        code: int | None,
        reason: str,
        dispatch: bool = True,
    ) -> None:
        with self._lock:
            if self._finished:
                return
            self._finished = True
        self.alive = False
        if code is None:
            try:
                code = self._proc.poll() if hasattr(self._proc, "poll") else None
            except Exception:
                code = None
        self.exit_code = code
        self.exit_reason = reason
        self.finished_at = time.time()

        if self._master_fd is not None:
            try:
                assert self._loop is not None
                self._loop.remove_reader(self._master_fd)
            except Exception:
                pass
            try:
                os.close(self._master_fd)
            except Exception:
                pass
            self._master_fd = None

        if dispatch:
            self._close_pipe_streams()
            self.manager.finish(self, code, reason)
        else:
            self._close_pipe_streams()

    # ------------------------------------------------------------------
    # IO
    # ------------------------------------------------------------------
    def write(self, data: bytes) -> None:
        if not self.alive or self._closed:
            raise TerminalError("终端进程已结束")
        if not data:
            return
        self.last_active = time.time()
        if self.backend == "pipe":
            stdin = getattr(self._proc, "stdin", None)
            if stdin is None:
                raise TerminalError("终端输入管道不可用")
            if IS_WINDOWS:
                # xterm sends CR for Enter; pipe-based Windows shells expect LF.
                data = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
            try:
                stdin.write(data)
                stdin.flush()
            except Exception as exc:
                raise TerminalError(f"写入终端失败：{exc}") from exc
            return

        if self.backend == "conpty":
            try:
                self._proc.write(data.decode("utf-8", "replace"))
            except Exception as exc:
                raise TerminalError(f"写入终端失败：{exc}") from exc
            return

        fd = self._master_fd
        if fd is None:
            raise TerminalError("终端已关闭")
        view = memoryview(data)
        try:
            while view:
                written = os.write(fd, view)
                if written <= 0:
                    break
                view = view[written:]
        except OSError as exc:
            raise TerminalError(f"写入终端失败：{exc}") from exc

    def resize(self, cols: int, rows: int) -> None:
        self.cols = cols
        self.rows = rows
        if not self.alive:
            return
        if self.backend == "conpty":
            try:
                self._proc.setwinsize(rows, cols)
            except Exception:
                pass
        elif self.backend == "pty" and self._master_fd is not None:
            self._set_winsize_fd(self._master_fd)

    def _set_winsize_fd(self, fd: int) -> None:
        try:
            import fcntl
            import struct
            import termios

            fcntl.ioctl(
                fd,
                termios.TIOCSWINSZ,
                struct.pack("HHHH", self.rows, self.cols, 0, 0),
            )
        except Exception:
            pass

    def close(self, force: bool = True) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
        self._stop_reader.set()

        if self.backend == "conpty":
            try:
                self._proc.terminate(force=force)
            except Exception:
                pass
            try:
                self._proc.close()
            except Exception:
                pass
        elif self.backend == "pipe":
            try:
                self._proc.terminate()
                try:
                    self._proc.wait(timeout=1.5)
                except Exception:
                    self._proc.kill()
            except Exception:
                pass
            self._close_pipe_streams()
        else:
            proc = self._proc
            if proc is not None:
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                except Exception:
                    try:
                        proc.terminate()
                    except Exception:
                        pass
                try:
                    proc.wait(timeout=1.5)
                except Exception:
                    try:
                        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                    except Exception:
                        try:
                            proc.kill()
                        except Exception:
                            pass

        self._notify_finish(None, "closed")

    def info(self, include_history: bool = True) -> dict[str, Any]:
        result: dict[str, Any] = {
            "sid": self.sid,
            "title": self.title,
            "alive": self.alive,
            "shell": self.shell,
            "cwd": self.cwd,
            "cols": self.cols,
            "rows": self.rows,
            "created_at": int(self.created_at),
            "last_active": int(self.last_active),
            "exit_code": self.exit_code,
            "exit_reason": self.exit_reason,
            "backend": self.backend,
        }
        if include_history:
            result["history"] = _b64(bytes(self.history))
        return result


class TerminalManager:
    """Owns every terminal for every WebUI user."""

    def __init__(
        self,
        *,
        shell: str = "",
        cwd: str = "",
        max_sessions: int = 8,
        idle_timeout: int = 1800,
        max_total: int = 48,
    ):
        self.shell = shell.strip()
        self.cwd_setting = cwd.strip()
        self.max_sessions = max(1, int(max_sessions))
        self.idle_timeout = max(60, int(idle_timeout))
        self.max_total = max(self.max_sessions, int(max_total))
        self.sessions: dict[str, TerminalSession] = {}
        self.hubs: dict[str, OutputHub] = {}
        self._reaper: asyncio.Task | None = None
        self._closed = False

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    @staticmethod
    def _user_key(username: str | None) -> str:
        return username or "__anonymous__"

    def hub_for(self, username: str | None) -> OutputHub:
        key = self._user_key(username)
        hub = self.hubs.get(key)
        if hub is None:
            hub = OutputHub()
            self.hubs[key] = hub
        return hub

    def _resolve_cwd(self) -> str:
        candidate = self.cwd_setting
        if candidate:
            path = Path(os.path.expanduser(os.path.expandvars(candidate)))
            if path.is_dir():
                return str(path)
            raise TerminalError(f"配置的启动目录不存在：{path}")
        return _home_dir()

    def _sessions_for(self, username: str | None) -> list[TerminalSession]:
        return [
            session
            for session in self.sessions.values()
            if session.username == username
        ]

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def create(
        self,
        username: str | None,
        owner: str,
        cols: int,
        rows: int,
    ) -> dict[str, Any]:
        if self._closed:
            raise TerminalError("插件正在关闭")
        self._prune_dead(force=False)

        user_sessions = [
            session for session in self._sessions_for(username) if session.alive
        ]
        if len(user_sessions) >= self.max_sessions:
            raise TerminalError(
                f"每个用户最多同时打开 {self.max_sessions} 个终端"
            )
        if (
            sum(1 for session in self.sessions.values() if session.alive)
            >= self.max_total
        ):
            raise TerminalError("服务器终端数量已达上限，请稍后再试")

        cols = max(20, min(500, int(cols)))
        rows = max(5, min(300, int(rows)))
        shell = os.path.expanduser(
            os.path.expandvars(self.shell or default_shell())
        )
        if not os.path.exists(shell):
            found = shutil.which(shell)
            if not found:
                raise TerminalError(f"找不到 Shell：{shell}")
            shell = found
        cwd = self._resolve_cwd()

        sid = "t_" + secrets.token_hex(10)
        title = f"Terminal {len(user_sessions) + 1}"
        session = TerminalSession(
            sid=sid,
            title=title,
            owner=owner[:64],
            username=username,
            shell=shell,
            cwd=cwd,
            cols=cols,
            rows=rows,
            manager=self,
        )
        try:
            session.start()
        except Exception:
            try:
                session.close(True)
            except Exception:
                pass
            raise
        self.sessions[sid] = session

        hub = self.hub_for(username)
        hub.publish(
            {
                "t": "ready",
                "s": sid,
                "title": title,
                "shell": shell,
                "cwd": cwd,
                "backend": session.backend,
            }
        )
        return session.info()

    def get(self, sid: str, username: str | None) -> TerminalSession:
        session = self.sessions.get(sid)
        if session is None:
            raise TerminalError("终端不存在或已关闭")
        if session.username != username:
            raise TerminalError("终端不属于当前用户")
        return session

    def list_sessions(
        self,
        username: str | None,
        owner: str | None = None,
    ) -> dict[str, Any]:
        self._prune_dead(force=False)
        sessions = [
            session for session in self._sessions_for(username) if session.alive
        ]
        # AstrBot plugin views live in a sandboxed iframe without Web
        # Storage, so the owner id changes whenever the iframe is recreated
        # (for example after visiting another dashboard page and coming back).
        # Owner ids therefore cannot isolate sessions reliably: list every
        # live session that belongs to this WebUI user so the recreated view
        # can rebuild its terminals and replay their history instead of
        # starting from a blank shell.
        sessions.sort(key=lambda item: item.created_at)
        hub = self.hub_for(username)
        return {
            "sessions": [session.info() for session in sessions],
            "seq": hub.seq,
            "limits": self.limits(),
        }

    def limits(self) -> dict[str, int]:
        return {
            "max_sessions": self.max_sessions,
            "idle_timeout": self.idle_timeout,
        }

    def write(self, sid: str, username: str | None, data: bytes) -> None:
        if len(data) > MAX_INPUT_BYTES:
            raise TerminalError("单次输入数据过大")
        session = self.get(sid, username)
        payload, refusal = session.line_guard.feed(data)
        if payload:
            session.write(payload)
        if refusal:
            # Clear the line where possible (Ctrl+U then Ctrl+C). The Enter is
            # intentionally never forwarded, so the command cannot execute.
            try:
                session.write(b"\x15\x03")
            except TerminalError:
                pass
            session.notice(f"高危指令已拦截：{refusal}；命令未执行。")
            hint = ""
            if session.backend == "pipe":
                # Pipe-backed shells may ignore line-editing control bytes, so
                # the dangerous text could remain in their input buffer and run
                # on the next Enter. Close this session instead of risking it.
                try:
                    session.close(force=True)
                except Exception:
                    pass
                hint = "当前终端已关闭，请新建标签。"
            raise TerminalError(
                f"[高危指令拦截] 已拒绝执行：{refusal}。"
                f"命令未发送到 Shell。{hint}"
            )

    def resize(self, sid: str, username: str | None, cols: int, rows: int) -> None:
        self.get(sid, username).resize(
            max(20, min(500, int(cols))),
            max(5, min(300, int(rows))),
        )

    async def close(self, sid: str, username: str | None) -> None:
        session = self.get(sid, username)
        await asyncio.to_thread(session.close, True)

    # ------------------------------------------------------------------
    # Hub / lifecycle callbacks
    # ------------------------------------------------------------------
    def publish_output(self, session: TerminalSession, chunk: bytes) -> None:
        if self._closed:
            return
        self.hub_for(session.username).publish(
            {"t": "o", "s": session.sid, "d": _b64(chunk)}
        )

    def finish(
        self,
        session: TerminalSession,
        code: int | None,
        reason: str,
    ) -> None:
        if self._closed:
            return
        session.alive = False
        if not session.finished_at:
            session.finished_at = time.time()
        session.exit_code = code
        session.exit_reason = reason
        if session._notified:
            return
        session._notified = True
        self.hub_for(session.username).publish(
            {
                "t": "exit",
                "s": session.sid,
                "code": code,
                "reason": reason,
            }
        )

    def _prune_dead(self, force: bool) -> None:
        now = time.time()
        for sid, session in list(self.sessions.items()):
            if session.alive:
                continue
            if force or now - session.finished_at > 120:
                self.sessions.pop(sid, None)

    # ------------------------------------------------------------------
    # Reaper
    # ------------------------------------------------------------------
    def start_reaper(self) -> None:
        if self._reaper is None:
            self._reaper = asyncio.create_task(
                self._reap_loop(), name="terminal-shell-reaper"
            )

    async def _reap_loop(self) -> None:
        try:
            while not self._closed:
                await asyncio.sleep(30)
                try:
                    await self.reap()
                except Exception:
                    # Keep the maintenance loop alive even if one session
                    # fails to close cleanly.
                    continue
        except asyncio.CancelledError:
            return

    async def reap(self) -> None:
        now = time.time()
        for session in list(self.sessions.values()):
            if (
                session.alive
                and now - session.last_active > self.idle_timeout
            ):
                try:
                    await asyncio.to_thread(session.close, True)
                except Exception:
                    pass
        self._prune_dead(force=False)

        alive_users = {session.username for session in self.sessions.values()}
        for key, hub in list(self.hubs.items()):
            if hub.has_subscribers:
                continue
            username = None if key == "__anonymous__" else key
            if username not in alive_users:
                self.hubs.pop(key, None)

    async def shutdown(self) -> None:
        self._closed = True
        if self._reaper is not None:
            self._reaper.cancel()
            try:
                await self._reaper
            except (asyncio.CancelledError, Exception):
                pass
            self._reaper = None
        for session in list(self.sessions.values()):
            try:
                await asyncio.to_thread(session.close, True)
            except Exception:
                pass
        self.sessions.clear()
        for hub in self.hubs.values():
            hub.close()
        self.hubs.clear()
