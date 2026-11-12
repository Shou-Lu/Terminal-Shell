"""Persistent shell used by the /终端 command and the LLM tool.

The shell process itself cannot be serialized, so we keep it alive in the
plugin process and persist an encrypted transcript after every command.  If
the process disappears (plugin reload / idle reaper / AstrBot restart) the
next command starts a fresh shell and restores the encrypted transcript.
"""

from __future__ import annotations

import asyncio
import base64
import codecs
import hashlib
import re
import secrets
import time
from dataclasses import dataclass, field
from pathlib import Path

from .storage import SessionSnapshotStore
from .terminal import TerminalError, TerminalManager

ANSI_RE = re.compile(
    r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-_])"
)
MARKER_TOKEN_RE = re.compile(r"__TS_[0-9a-f]{16}__")
MARKER_COMMAND_RE = re.compile(
    r"(?:Write-Output\s*\(\s*'__TS_|printf\s+'%s%s\\n'\s+'__TS_"
    r"|for\s+%A\s+in\s+\(__TS_\))"
)
HISTORY_BYTES = 48 * 1024


@dataclass
class ChatShellEntry:
    sid: str
    username: str
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class PersistentChatShell:
    """One persistent shell per chat user, with encrypted transcript storage."""

    def __init__(
        self,
        manager: TerminalManager,
        store: SessionSnapshotStore,
        *,
        timeout: float = 25.0,
        max_output_chars: int = 12000,
        chat_output_chars: int = 3500,
    ):
        self.manager = manager
        self.store = store
        self.timeout = max(5.0, float(timeout))
        self.max_output_chars = max(1000, int(max_output_chars))
        self.chat_output_chars = max(500, int(chat_output_chars))
        self._entries: dict[str, ChatShellEntry] = {}

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    async def run(self, key: str, command: str, limit: int | None = None) -> str:
        command = command.strip()
        if not command:
            return await self.tail(key, self.chat_output_chars)

        entry = self._entry(key)
        async with entry.lock:
            session = await self._ensure_session(key, entry)
            marker = f"__TS_{secrets.token_hex(8)}__"
            marker_cmd = self._marker_command(session.shell, marker)
            hub = self.manager.hub_for(entry.username)
            start_seq = hub.seq
            queue = hub.subscribe(start_seq)
            decoder = codecs.getincrementaldecoder("utf-8")("replace")
            buffer = ""
            timed_out = False
            exited = False
            loop = asyncio.get_running_loop()
            deadline = loop.time() + self.timeout

            try:
                payload = (
                    command.rstrip("\r\n")
                    + "\r"
                    + marker_cmd
                    + "\r"
                )
                try:
                    session.write(payload.encode("utf-8"))
                except TerminalError:
                    raise

                while True:
                    remaining = deadline - loop.time()
                    if remaining <= 0:
                        timed_out = True
                        break
                    try:
                        event = await asyncio.wait_for(
                            queue.get(), timeout=min(remaining, 1.0)
                        )
                    except asyncio.TimeoutError:
                        continue
                    if event is None:
                        exited = True
                        break
                    if event.get("s") != entry.sid:
                        continue
                    if event.get("t") == "exit":
                        exited = True
                        break
                    if event.get("t") != "o":
                        continue
                    try:
                        buffer += decoder.decode(
                            base64.b64decode(event.get("d") or "")
                        )
                    except Exception:
                        continue
                    if len(buffer) > 256 * 1024:
                        buffer = buffer[-128 * 1024 :]
                    marker_index = buffer.rfind(marker)
                    if marker_index >= 0:
                        buffer = buffer[:marker_index]
                        break
            finally:
                hub.unsubscribe(queue)
                try:
                    decoder.decode(b"", final=True)
                except Exception:
                    pass
                self._persist(key, entry, session)

            output = self._clean_output(buffer, marker)
            if timed_out:
                try:
                    await asyncio.to_thread(session.close, True)
                except Exception:
                    pass
                output += (
                    "\n[命令执行超时，已返回已捕获的部分输出并重置该 Shell；"
                    "交互式/长时间运行命令建议在 WebUI 终端中使用]"
                )
            if exited:
                output += "\n[Shell 进程已退出，下次调用会自动重建]"
            output = self._cap(output, limit or self.max_output_chars)
            return output or "(无输出)"

    async def tail(self, key: str, limit: int | None = None) -> str:
        """Return recent shell output without executing anything."""
        limit = self.chat_output_chars if limit is None else max(200, int(limit))
        entry = self._entries.get(key)
        history = b""
        if entry:
            try:
                session = self.manager.get(entry.sid, entry.username)
                history = bytes(session.history)
            except TerminalError:
                pass
        if not history:
            snapshot = self.store.load(key)
            if snapshot:
                history = snapshot.get("history", b"")
        if not history:
            return (
                "当前没有持久化终端输出。\n"
                "用法：/终端 <命令>\n"
                "例如：/终端 ls -la"
            )
        text = self._clean_output(
            history.decode("utf-8", "replace"), ""
        )
        return self._cap(text, limit) or "(无输出)"

    async def close(self) -> None:
        """Flush encrypted transcripts before the plugin shuts down."""
        for key, entry in list(self._entries.items()):
            try:
                session = self.manager.get(entry.sid, entry.username)
            except TerminalError:
                continue
            self._persist(key, entry, session)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------
    @staticmethod
    def _username(key: str) -> str:
        digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:20]
        return f"chat:{digest}"

    def _entry(self, key: str) -> ChatShellEntry:
        entry = self._entries.get(key)
        if entry is None:
            entry = ChatShellEntry(sid="", username=self._username(key))
            self._entries[key] = entry
        return entry

    async def _ensure_session(
        self, key: str, entry: ChatShellEntry
    ):
        if entry.sid:
            try:
                session = self.manager.get(entry.sid, entry.username)
                if session.alive:
                    return session
            except TerminalError:
                pass
        info = self.manager.create(entry.username, "chat", 120, 30)
        session = self.manager.get(info["sid"], entry.username)
        entry.sid = session.sid
        snapshot = self.store.load(key)
        if snapshot:
            history = snapshot.get("history") or b""
            if history:
                session.history[:0] = history[-HISTORY_BYTES:]
        return session

    def _persist(self, key: str, entry: ChatShellEntry, session) -> None:
        if not entry.sid:
            return
        try:
            self.store.save(
                key,
                bytes(session.history),
                {
                    "shell": session.shell,
                    "cwd": session.cwd,
                    "backend": session.backend,
                    "updated_at": int(time.time()),
                },
            )
        except Exception:
            pass

    @staticmethod
    def _marker_command(shell: str, marker: str) -> str:
        # Build the marker from two pieces so the shell's echoed input does not
        # contain the full token; only the command's actual output does.
        prefix = "__TS_"
        rest = marker[len(prefix) :]
        name = Path(shell).name.lower()
        if name.startswith("powershell") or name.startswith("pwsh"):
            return f"Write-Output ('{prefix}' + '{rest}')"
        if name in {"cmd.exe", "cmd"}:
            return f"for %A in ({prefix}) do @echo %A{rest}"
        return f"printf '%s%s\\n' '{prefix}' '{rest}'"

    @staticmethod
    def _clean_output(text: str, marker: str) -> str:
        text = ANSI_RE.sub("", text)
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        lines = []
        for line in text.split("\n"):
            if marker and marker in line:
                continue
            if MARKER_TOKEN_RE.search(line):
                continue
            if MARKER_COMMAND_RE.search(line):
                continue
            lines.append(line.rstrip())
        while lines and not lines[0].strip():
            lines.pop(0)
        while lines and not lines[-1].strip():
            lines.pop()
        return "\n".join(lines).strip()

    @staticmethod
    def _cap(text: str, limit: int) -> str:
        if len(text) <= limit:
            return text
        return "…(输出已截断)\n" + text[-limit:]
