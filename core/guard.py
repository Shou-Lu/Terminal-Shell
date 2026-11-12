"""Heuristic refusal for catastrophic shell commands.

This module is a defense-in-depth filter, not a security boundary.  It only
inspects the command line before it reaches the shell, so scripts, aliases,
shell history recall, interactive tools and obfuscation can still bypass it.
The goal is to stop the common "I typed the wrong disk" accidents, especially
``format C:``, ``mkfs``/``dd``/``wipefs`` against block devices and recursive
deletion of the system root.
"""

from __future__ import annotations

import re

MAX_LINE_BYTES = 64 * 1024

_WRAPPER_RE = re.compile(
    r"""^\s*(?:
        sudo(?:\s+(?:-[ugpChrt]\s+\S+|--[a-z-]+\s+\S+|--[a-z-]+(?:=\S+)?|-\S+))*
        |doas(?:\s+(?:-[ugpChrt]\s+\S+|--[a-z-]+\s+\S+|--[a-z-]+(?:=\S+)?|-\S+))*
        |pkexec(?:\s+-\S+)*
        |nohup
        |setsid
        |time(?:\s+-p)?
        |command
        |builtin
        |nice(?:\s+(?:-n\s+\S+|-\S+))*
        |ionice(?:\s+(?:-[cnp]\s+\S+|-\S+))*
        |env(?:\s+(?:-[A-Za-z]+|[A-Za-z_][A-Za-z0-9_]*=\S+))*
        |cmd(?:\.exe)?(?:\s+/[A-Za-z]+)*\s+/c
        |powershell(?:\.exe)?(?:\s+-\S+)*\s+-(?:command|encodedcommand|enc|e|c)\b
        |pwsh(?:\.exe)?(?:\s+-\S+)*\s+-(?:command|encodedcommand|enc|e|c)\b
        |(?:bash|sh|zsh|dash|fish)\s+-[A-Za-z]*c[A-Za-z]*\b
        |start(?:\s+"[^"]*")?(?:\s+/[A-Za-z]+)*
    )\s+""",
    re.IGNORECASE | re.VERBOSE,
)

_SEGMENT_SPLIT_RE = re.compile(r"(?:\r\n|\r|\n|;|&&|\|\||\||&)")

_READONLY_DISK_RE = re.compile(
    r"(?:^|\s)(?:-l|--list|-p|--print|-i|--info|-d|--dump)\b"
)
_DESTRUCTIVE_PARTED_RE = re.compile(
    r"\b(?:mklabel|mkpart|rm|resizepart|set|delete|remove|create|write|"
    r"zap|clear|new|toggle)\b"
)
_WINDOWS_ROOT_RE = re.compile(
    r"(?:^|\s)(?:[a-z]:[\\/](?:\s|$|\*)|%systemdrive%[\\/]?(?:\s|$|\*)|"
    r"\$env:systemdrive[\\/]?(?:\s|$|\*))"
)
_POSIX_ROOT_RE = re.compile(r"(?:^|\s)/(?:\s|$|\*|\{)")


def check_command(command: str) -> str | None:
    """Return a refusal reason when *command* looks catastrophic."""
    text = (command or "").strip()
    if not text:
        return None
    # Keep the check bounded for pathological pastes, but never inspect only
    # a tiny prefix: the dangerous command may be at the beginning.
    if len(text) > 200_000:
        text = text[:200_000]
    for segment in _SEGMENT_SPLIT_RE.split(text):
        reason = _check_segment(segment)
        if reason:
            return reason
    return None


def _check_segment(segment: str) -> str | None:
    text = _strip_wrappers(segment)
    if not text:
        return None
    lower = re.sub(r"\s+", " ", text.lower())
    name = _command_name(_first_token(text))
    if not name:
        return None
    if re.search(r"(?:^|\s)(?:--help|-h|/\?)(?:\s|$)", lower) and not re.search(
        r"(?:[a-z]:[\\/]|/dev/)", lower
    ):
        return None
    if re.search(
        r"(?:^|[^>])>>?\s*/dev/(?:sd|nvme|vd|hd|mmcblk|disk)", lower
    ):
        return "重定向写入块设备会覆盖磁盘数据"

    if name in {"format", "format-volume"}:
        return "format / Format-Volume 会格式化磁盘或分区"
    if name.startswith("mkfs") or name in {
        "mke2fs",
        "mkdosfs",
        "mkntfs",
        "mkexfatfs",
        "mkswap",
        "newfs",
        "newfs_apfs",
        "newfs_hfs",
        "newfs_msdos",
    }:
        return "mkfs / newfs / mkswap 会重建文件系统或交换区"
    if name == "cryptsetup" and re.search(
        r"(?:luksformat|lukserase|erase)", lower
    ):
        return "cryptsetup 会格式化或擦除加密卷"
    if name == "wipefs":
        return "wipefs 会擦除文件系统签名"
    if name == "shred" and ("/dev/" in lower or "physicaldrive" in lower):
        return "shred 会覆写块设备"
    if name == "dd" and _dd_targets_device(lower):
        return "dd 正在直接写入磁盘设备"
    if name in {"fdisk", "sfdisk", "sgdisk", "gdisk", "parted"}:
        if _disk_tool_is_readonly(name, lower):
            return None
        return "fdisk / parted 等分区工具会修改分区表"
    if name == "diskutil":
        if re.search(
            r"(?:erasedisk|erasevolume|partitiondisk|zerodisk|securedisk|"
            r"reformat|delete\s*(?:container|volume)|resizevolume)",
            lower,
        ):
            return "diskutil 会擦除或重建磁盘"
        return None
    if name == "diskpart":
        if re.search(r"(?:^|\s)/\?(?:\s|$)", lower):
            return None
        return "diskpart 会清除或重建磁盘分区"
    if name in {
        "clear-disk",
        "initialize-disk",
        "remove-partition",
        "new-partition",
        "set-partition",
        "resize-partition",
    }:
        return "PowerShell 磁盘 / 分区操作会破坏现有数据"
    if name == "cipher" and re.search(r"(?:^|\s)/w(?::|\s|$)", lower):
        return "cipher /w 会覆写磁盘空闲空间"
    if name in {"rd", "rmdir"}:
        if re.search(r"(?:^|\s)/s(?:\s|$)", lower) and _WINDOWS_ROOT_RE.search(
            lower
        ):
            return "递归删除系统盘根目录"
    if name in {"del", "erase"}:
        if _WINDOWS_ROOT_RE.search(lower) and "*" in lower:
            return "删除系统盘根目录内容"
    if name in {"remove-item", "ri"}:
        if re.search(r"(?:^|\s)-(?:recurse|r)\b", lower) and _WINDOWS_ROOT_RE.search(
            lower
        ):
            return "PowerShell 递归删除系统盘根目录"
    if name in {"rm", "unlink"}:
        recursive = bool(
            re.search(r"(?:^|\s)-(?:[a-z]*r[a-z]*|recursive)\b", lower)
            or "--recursive" in lower
        )
        if "no-preserve-root" in lower:
            return "递归删除系统根目录"
        if recursive and (
            _POSIX_ROOT_RE.search(lower) or _WINDOWS_ROOT_RE.search(lower)
        ):
            return "递归删除系统根目录"
    return None


def _strip_wrappers(segment: str) -> str:
    text = segment.strip()
    for _ in range(4):
        text = text.lstrip(" \t(){}&\\")
        if not text:
            return ""
        match = _WRAPPER_RE.match(text)
        if not match:
            break
        text = text[match.end() :]
    return text.strip(" \t(){}&\"'`")


def _first_token(segment: str) -> str:
    match = re.match(r"^[\"'`]*([^\s\"'`]+)", segment)
    return match.group(1) if match else ""


def _command_name(token: str) -> str:
    name = re.split(r"[\\/]", token.strip("\"'`"))[-1].lower()
    for suffix in (".exe", ".com"):
        if name.endswith(suffix):
            name = name[: -len(suffix)]
    return name


def _dd_targets_device(lower: str) -> bool:
    match = re.search(r"\bof\s*=\s*(\S+)", lower)
    if not match:
        return False
    target = match.group(1)
    return (
        "/dev/" in target
        or "physicaldrive" in target
        or "\\\\.\\" in target
        or "%systemdrive%" in target
        or "$env:systemdrive" in target
    )


def _disk_tool_is_readonly(name: str, lower: str) -> bool:
    if _DESTRUCTIVE_PARTED_RE.search(lower):
        return False
    if name == "parted":
        return bool(re.search(r"\bprint\b", lower)) or bool(
            re.search(r"(?:^|\s)(?:-l|--list)\b", lower)
        )
    if name in {"sgdisk", "gdisk"}:
        return bool(
            re.search(r"(?:^|\s)(?:-p|--print|-l|--list|-i|--info)\b", lower)
        )
    return bool(_READONLY_DISK_RE.search(lower))


class TerminalLineGuard:
    """Track one interactive terminal line and cancel refused commands."""

    def __init__(self) -> None:
        self.buffer = bytearray()
        self._escape = 0
        self._skip_lf = False

    def feed(self, data: bytes) -> tuple[bytes, str | None]:
        """Return ``(bytes_to_write, refusal_reason)``.

        When a line is refused its Enter is replaced with Ctrl+C so the
        shell cancels the already-echoed text instead of executing it.
        """
        out = bytearray()
        refusal: str | None = None

        for byte in data:
            if self._skip_lf:
                self._skip_lf = False
                if byte == 0x0A:
                    continue

            if self._escape:
                out.append(byte)
                if self._escape == 1:
                    if byte == 0x5B:  # [
                        self._escape = 2
                    elif byte == 0x5D:  # ]
                        self._escape = 3
                    else:
                        self._escape = 0
                elif self._escape == 2:
                    if 0x40 <= byte <= 0x7E:
                        self._escape = 0
                elif byte == 0x07:
                    self._escape = 0
                continue

            if byte == 0x1B:
                out.append(byte)
                self._escape = 1
                continue

            if byte in (0x0D, 0x0A):
                command = self.buffer.decode("utf-8", "replace").strip()
                self.buffer.clear()
                if command:
                    reason = check_command(command)
                    if reason:
                        refusal = reason
                        break
                out.append(byte)
                if byte == 0x0D:
                    self._skip_lf = True
                continue

            if byte in (0x08, 0x7F):
                if self.buffer:
                    self.buffer.pop()
                out.append(byte)
                continue

            if byte in (0x03, 0x15):
                self.buffer.clear()
                out.append(byte)
                continue

            if byte == 0x17:  # Ctrl+W
                while self.buffer and self.buffer[-1:] == b" ":
                    self.buffer.pop()
                while self.buffer and self.buffer[-1:] != b" ":
                    self.buffer.pop()
                out.append(byte)
                continue

            if byte == 0x09:  # Tab completion is whitespace for our purposes.
                self.buffer.extend(b" ")
                out.append(byte)
                continue

            if byte < 0x20:
                out.append(byte)
                continue

            self.buffer.append(byte)
            if len(self.buffer) > MAX_LINE_BYTES:
                del self.buffer[: len(self.buffer) - MAX_LINE_BYTES]
            out.append(byte)

        return bytes(out), refusal
