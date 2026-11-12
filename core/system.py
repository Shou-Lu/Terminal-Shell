"""Cross-platform system monitor for the status view.

The monitor keeps a short rolling history of CPU, memory and load samples so
the web UI can draw real function graphs instead of a single frozen number.
``psutil`` is used when it is available; otherwise the module falls back to
platform specific APIs from the standard library (``/proc``, ``ctypes``).
"""

from __future__ import annotations

import asyncio
import contextlib
import ctypes
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import time
from collections import deque
from pathlib import Path
from typing import Any

try:  # pragma: no cover - optional dependency
    import psutil  # type: ignore
except Exception:  # pragma: no cover - psutil is optional
    psutil = None  # type: ignore

PROCESS_START = time.time()
_CPU_STATE: dict[str, tuple[float, float] | None] = {"last": None}


# ----------------------------------------------------------------------
# CPU
# ----------------------------------------------------------------------
def _windows_cpu_times() -> tuple[float, float]:
    class FileTime(ctypes.Structure):
        _fields_ = [
            ("dwLowDateTime", ctypes.c_uint32),
            ("dwHighDateTime", ctypes.c_uint32),
        ]

    idle = FileTime()
    kernel = FileTime()
    user = FileTime()
    ok = ctypes.windll.kernel32.GetSystemTimes(
        ctypes.byref(idle),
        ctypes.byref(kernel),
        ctypes.byref(user),
    )
    if not ok:
        raise OSError("GetSystemTimes failed")

    def as_int(value: FileTime) -> float:
        return float((value.dwHighDateTime << 32) | value.dwLowDateTime)

    idle_ticks = as_int(idle)
    total_ticks = as_int(kernel) + as_int(user)
    return idle_ticks, total_ticks


def _linux_cpu_times() -> tuple[float, float]:
    with open("/proc/stat", "r", encoding="ascii", errors="ignore") as handle:
        parts = handle.readline().split()
    values = [float(item) for item in parts[1:]]
    idle = values[3] + (values[4] if len(values) > 4 else 0.0)
    return idle, sum(values)


def _cpu_times() -> tuple[float, float]:
    if os.name == "nt":
        return _windows_cpu_times()
    return _linux_cpu_times()


def _mac_cpu_percent() -> float:
    try:
        output = subprocess.check_output(
            ["ps", "-A", "-o", "%cpu"],
            text=True,
            timeout=3,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception:
        return 0.0
    total = 0.0
    for line in output.splitlines()[1:]:
        line = line.strip()
        if not line:
            continue
        try:
            total += float(line)
        except ValueError:
            continue
    return max(0.0, min(100.0, total / max(1, os.cpu_count() or 1)))


def cpu_percent() -> float:
    """Return the current system-wide CPU usage percentage."""
    if psutil is not None:
        try:
            return max(0.0, min(100.0, float(psutil.cpu_percent(interval=None))))
        except Exception:
            pass
    if sys.platform == "darwin":
        return _mac_cpu_percent()
    try:
        current = _cpu_times()
    except Exception:
        return 0.0
    previous = _CPU_STATE.get("last")
    _CPU_STATE["last"] = current
    if previous is None:
        return 0.0
    idle_delta = current[0] - previous[0]
    total_delta = current[1] - previous[1]
    if total_delta <= 0:
        return 0.0
    usage = (1.0 - idle_delta / total_delta) * 100.0
    return max(0.0, min(100.0, usage))


# ----------------------------------------------------------------------
# Memory
# ----------------------------------------------------------------------
class _MemoryStatusEx(ctypes.Structure):
    _fields_ = [
        ("dwLength", ctypes.c_ulong),
        ("dwMemoryLoad", ctypes.c_ulong),
        ("ullTotalPhys", ctypes.c_ulonglong),
        ("ullAvailPhys", ctypes.c_ulonglong),
        ("ullTotalPageFile", ctypes.c_ulonglong),
        ("ullAvailPageFile", ctypes.c_ulonglong),
        ("ullTotalVirtual", ctypes.c_ulonglong),
        ("ullAvailVirtual", ctypes.c_ulonglong),
        ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
    ]


def _windows_memory() -> dict[str, float]:
    status = _MemoryStatusEx()
    status.dwLength = ctypes.sizeof(_MemoryStatusEx)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
        raise OSError("GlobalMemoryStatusEx failed")
    total = float(status.ullTotalPhys)
    available = float(status.ullAvailPhys)
    return _memory_result(total, available)


def _memory_result(total: float, available: float) -> dict[str, float]:
    total = max(0.0, total)
    available = max(0.0, min(total, available))
    used = max(0.0, total - available)
    percent = (used / total * 100.0) if total else 0.0
    return {
        "total": total,
        "available": available,
        "used": used,
        "percent": round(percent, 2),
    }


def _linux_memory() -> dict[str, float]:
    values: dict[str, float] = {}
    with open("/proc/meminfo", "r", encoding="ascii", errors="ignore") as handle:
        for line in handle:
            key, _, rest = line.partition(":")
            parts = rest.split()
            if not parts:
                continue
            try:
                values[key.strip()] = float(parts[0]) * 1024.0
            except ValueError:
                continue
    total = values.get("MemTotal", 0.0)
    available = values.get("MemAvailable")
    if available is None:
        available = (
            values.get("MemFree", 0.0)
            + values.get("Buffers", 0.0)
            + values.get("Cached", 0.0)
        )
    return _memory_result(total, available)


def _mac_memory() -> dict[str, float]:
    try:
        total = float(
            subprocess.check_output(
                ["sysctl", "-n", "hw.memsize"],
                text=True,
                timeout=3,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            ).strip()
        )
    except Exception:
        return _memory_result(0.0, 0.0)
    page_size = 4096.0
    free_pages = 0.0
    inactive_pages = 0.0
    try:
        output = subprocess.check_output(
            ["vm_stat"],
            text=True,
            timeout=3,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        for line in output.splitlines():
            if line.startswith("Mach Virtual Memory Statistics"):
                match = re.search(r"page size of (\d+) bytes", line)
                if match:
                    page_size = float(match.group(1))
            elif "Pages free" in line:
                free_pages = float(re.sub(r"[^0-9]", "", line) or 0)
            elif "Pages inactive" in line:
                inactive_pages = float(re.sub(r"[^0-9]", "", line) or 0)
    except Exception:
        pass
    available = (free_pages + inactive_pages) * page_size
    return _memory_result(total, available)


def memory_status() -> dict[str, float]:
    if psutil is not None:
        try:
            info = psutil.virtual_memory()
            return _memory_result(float(info.total), float(info.available))
        except Exception:
            pass
    try:
        if os.name == "nt":
            return _windows_memory()
        if sys.platform == "darwin":
            return _mac_memory()
        return _linux_memory()
    except Exception:
        return _memory_result(0.0, 0.0)


# ----------------------------------------------------------------------
# Uptime / static info
# ----------------------------------------------------------------------
def system_uptime() -> float:
    """Seconds since the system booted."""
    if psutil is not None:
        try:
            return max(0.0, time.time() - float(psutil.boot_time()))
        except Exception:
            pass
    try:
        if os.name == "nt":
            return max(0.0, ctypes.windll.kernel32.GetTickCount64() / 1000.0)
        if sys.platform.startswith("linux"):
            with open("/proc/uptime", "r", encoding="ascii") as handle:
                return max(0.0, float(handle.read().split()[0]))
        if sys.platform == "darwin":
            output = subprocess.check_output(
                ["sysctl", "-n", "kern.boottime"],
                text=True,
                timeout=3,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            match = re.search(r"sec\s*=\s*(\d+)", output)
            if match:
                return max(0.0, time.time() - float(match.group(1)))
    except Exception:
        pass
    return 0.0


def _cpu_model() -> str:
    if os.name == "nt":
        try:
            import winreg

            with winreg.OpenKey(
                winreg.HKEY_LOCAL_MACHINE,
                r"HARDWARE\DESCRIPTION\System\CentralProcessor\0",
            ) as key:
                value, _ = winreg.QueryValueEx(key, "ProcessorNameString")
                if isinstance(value, str) and value.strip():
                    return value.strip()
        except Exception:
            pass
    name = platform.processor() or platform.uname().processor
    return name.strip() if isinstance(name, str) and name.strip() else "Unknown"


def _astrbot_version() -> str:
    try:
        from importlib.metadata import version

        return version("astrbot")
    except Exception:
        pass
    try:
        import astrbot

        return getattr(astrbot, "__version__", "unknown")
    except Exception:
        return "unknown"


def _load_average() -> float:
    try:
        if hasattr(os, "getloadavg"):
            return float(os.getloadavg()[0])
        if psutil is not None:
            return float(psutil.getloadavg()[0])
    except Exception:
        pass
    return 0.0


def _format_uptime(seconds: float) -> str:
    seconds = max(0, int(seconds))
    days, rest = divmod(seconds, 86400)
    hours, rest = divmod(rest, 3600)
    minutes, secs = divmod(rest, 60)
    if days:
        return f"{days}天 {hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


# ----------------------------------------------------------------------
# Monitor
# ----------------------------------------------------------------------
class SystemMonitor:
    """Periodically sample system metrics for the status dashboard."""

    def __init__(
        self,
        root: str | os.PathLike[str] | None = None,
        *,
        interval: float = 2.0,
        points: int = 90,
    ) -> None:
        self.root = Path(root).expanduser() if root else Path.home()
        try:
            if not self.root.exists():
                self.root = Path.home()
        except OSError:
            self.root = Path.home()
        self.interval = max(1.0, float(interval))
        self.points = max(10, int(points))
        self.started_at = time.time()
        self._task: asyncio.Task | None = None
        self._times: deque[float] = deque(maxlen=self.points)
        self._cpu: deque[float] = deque(maxlen=self.points)
        self._memory: deque[float] = deque(maxlen=self.points)
        self._load: deque[float] = deque(maxlen=self.points)

    # -- lifecycle -----------------------------------------------------
    async def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self.started_at = time.time()
        self._task = asyncio.create_task(self._run(), name="terminal-system-monitor")

    async def stop(self) -> None:
        task = self._task
        self._task = None
        if task is None:
            return
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task

    async def _run(self) -> None:
        while True:
            try:
                sample = await asyncio.to_thread(self._sample)
                self._times.append(sample["t"])
                self._cpu.append(sample["cpu"])
                self._memory.append(sample["memory"])
                self._load.append(sample["load"])
            except asyncio.CancelledError:
                raise
            except Exception:
                # A failing platform probe must never kill the sampler.
                pass
            await asyncio.sleep(self.interval)

    def _sample(self) -> dict[str, float]:
        memory = memory_status()
        return {
            "t": time.time(),
            "cpu": round(cpu_percent(), 2),
            "memory": round(float(memory.get("percent", 0.0)), 2),
            "load": round(_load_average(), 3),
        }

    # -- snapshots -----------------------------------------------------
    def status(self) -> dict[str, Any]:
        now = time.time()
        memory = memory_status()
        try:
            disk = shutil.disk_usage(str(self.root))
            disk_info = {
                "path": str(self.root),
                "total": float(disk.total),
                "used": float(disk.used),
                "free": float(disk.free),
                "percent": round(disk.used / disk.total * 100.0, 2)
                if disk.total
                else 0.0,
            }
        except Exception:
            disk_info = {
                "path": str(self.root),
                "total": 0.0,
                "used": 0.0,
                "free": 0.0,
                "percent": 0.0,
            }

        boot_time = max(0.0, now - system_uptime())
        current_cpu = self._cpu[-1] if self._cpu else round(cpu_percent(), 2)
        current_memory = (
            self._memory[-1] if self._memory else float(memory.get("percent", 0.0))
        )
        current_load = self._load[-1] if self._load else round(_load_average(), 3)

        return {
            "generated_at": now,
            "interval": self.interval,
            "info": {
                "hostname": socket.gethostname(),
                "platform": platform.system(),
                "os": f"{platform.system()} {platform.release()}".strip(),
                "os_version": platform.version(),
                "kernel": platform.release(),
                "machine": platform.machine(),
                "cpu_model": _cpu_model(),
                "cpu_count": os.cpu_count() or 1,
                "python": platform.python_version(),
                "astrbot": _astrbot_version(),
                "boot_time": boot_time,
                "uptime": system_uptime(),
                "uptime_text": _format_uptime(system_uptime()),
                "process_uptime": max(0.0, now - PROCESS_START),
                "plugin_uptime": max(0.0, now - self.started_at),
            },
            "metrics": {
                "cpu": current_cpu,
                "memory": {
                    "percent": current_memory,
                    "total": float(memory.get("total", 0.0)),
                    "used": float(memory.get("used", 0.0)),
                    "available": float(memory.get("available", 0.0)),
                },
                "disk": disk_info,
                "load": current_load,
                "process": {
                    "pid": os.getpid(),
                    "threads": _thread_count(),
                },
            },
            "series": {
                "t": list(self._times),
                "cpu": list(self._cpu),
                "memory": list(self._memory),
                "load": list(self._load),
            },
        }


def _thread_count() -> int:
    try:
        if psutil is not None:
            return int(psutil.Process().num_threads())
    except Exception:
        pass
    try:
        import threading

        return int(threading.active_count())
    except Exception:
        return 0
