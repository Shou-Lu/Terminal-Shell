"""Safe filesystem browser/editor backend for the file-manager view."""

from __future__ import annotations

import mimetypes
import os
import shutil
from pathlib import Path
from typing import Any

MAX_ENTRIES = 2000


class FileError(Exception):
    """A user-facing file-manager error."""


class FileManager:
    """Browse and modify files inside one configured root directory."""

    def __init__(self, root: str | os.PathLike[str], max_bytes: int = 8 * 1024 * 1024):
        raw = str(root or "").strip()
        path = Path(os.path.expanduser(os.path.expandvars(raw or "~"))).resolve()
        if not path.is_dir():
            path = Path.home().resolve()
        self.root = path
        self.max_bytes = max(64 * 1024, int(max_bytes))

    # ------------------------------------------------------------------
    # Path safety
    # ------------------------------------------------------------------
    def _resolve(self, relative: Any, *, must_exist: bool = True) -> Path:
        if relative is None:
            relative = ""
        if not isinstance(relative, str):
            raise FileError("路径格式不正确")
        relative = relative.replace("\\", "/").strip("/")
        if relative in {".", ""}:
            target = self.root
        else:
            try:
                target = (self.root / relative).resolve()
            except (OSError, ValueError) as exc:
                raise FileError("路径格式不正确") from exc
        try:
            target.relative_to(self.root)
        except ValueError as exc:
            raise FileError("路径超出文件管理根目录") from exc
        if must_exist and not target.exists():
            raise FileError("路径不存在")
        return target

    def _relative(self, path: Path) -> str:
        if path == self.root:
            return ""
        try:
            return path.relative_to(self.root).as_posix()
        except ValueError:
            return ""

    @staticmethod
    def _mime(path: Path) -> str:
        return mimetypes.guess_type(str(path))[0] or "application/octet-stream"

    # ------------------------------------------------------------------
    # Operations
    # ------------------------------------------------------------------
    def info(self) -> dict[str, Any]:
        return {
            "root": str(self.root),
            "root_name": self.root.name or str(self.root),
            "max_bytes": self.max_bytes,
        }

    def list(self, relative: Any = "") -> dict[str, Any]:
        target = self._resolve(relative)
        if not target.is_dir():
            raise FileError("不是一个目录")
        entries: list[dict[str, Any]] = []
        try:
            children = list(target.iterdir())
        except OSError as exc:
            raise FileError(f"读取目录失败：{exc}") from exc

        for child in children[:MAX_ENTRIES]:
            try:
                resolved = child.resolve()
                resolved.relative_to(self.root)
            except (OSError, ValueError):
                continue
            try:
                stat = child.stat()
                is_dir = child.is_dir()
            except OSError:
                continue
            entries.append(
                {
                    "name": child.name,
                    "path": self._relative(child),
                    "is_dir": is_dir,
                    "size": 0 if is_dir else int(stat.st_size),
                    "mtime": int(stat.st_mtime),
                    "mime": "" if is_dir else self._mime(child),
                }
            )

        entries.sort(key=lambda item: (not item["is_dir"], item["name"].lower()))
        return {
            "path": self._relative(target),
            "parent": self._relative(target.parent) if target != self.root else None,
            "entries": entries,
            "truncated": len(children) > MAX_ENTRIES,
            **self.info(),
        }

    def read(self, relative: Any) -> dict[str, Any]:
        target = self._resolve(relative)
        if not target.is_file():
            raise FileError("不是一个文件")
        try:
            stat = target.stat()
            if stat.st_size > self.max_bytes:
                raise FileError(
                    f"文件超过 {self.max_bytes // (1024 * 1024)} MB 限制"
                )
            data = target.read_bytes()
        except FileError:
            raise
        except OSError as exc:
            raise FileError(f"读取文件失败：{exc}") from exc
        return {
            "name": target.name,
            "path": self._relative(target),
            "mime": self._mime(target),
            "size": len(data),
            "mtime": int(stat.st_mtime),
            "data": data,
        }

    def write(
        self,
        relative: Any,
        data: bytes,
        *,
        overwrite: bool = True,
    ) -> dict[str, Any]:
        if len(data) > self.max_bytes:
            raise FileError(
                f"文件超过 {self.max_bytes // (1024 * 1024)} MB 限制"
            )
        target = self._resolve(relative, must_exist=False)
        if target == self.root:
            raise FileError("不能写入根目录")
        if target.is_dir():
            raise FileError("目标是一个目录")
        if target.exists() and not overwrite:
            raise FileError("文件已存在")
        if not target.parent.is_dir():
            raise FileError("目标父目录不存在")
        tmp = target.with_name(
            f".{target.name}.uploading-{os.urandom(4).hex()}"
        )
        try:
            tmp.write_bytes(data)
            os.replace(tmp, target)
        except OSError as exc:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
            raise FileError(f"写入文件失败：{exc}") from exc
        return {
            "ok": True,
            "path": self._relative(target),
            "size": len(data),
        }

    def mkdir(self, relative: Any) -> dict[str, Any]:
        target = self._resolve(relative, must_exist=False)
        if target == self.root:
            raise FileError("目录已存在")
        if target.exists():
            raise FileError("目标已存在")
        if not target.parent.is_dir():
            raise FileError("父目录不存在")
        try:
            target.mkdir()
        except OSError as exc:
            raise FileError(f"创建目录失败：{exc}") from exc
        return {"ok": True, "path": self._relative(target)}

    def delete(self, relative: Any, *, recursive: bool = False) -> dict[str, Any]:
        target = self._resolve(relative)
        if target == self.root:
            raise FileError("不能删除文件管理根目录")
        try:
            if target.is_dir():
                if any(target.iterdir()) and not recursive:
                    raise FileError("目录非空，请确认递归删除")
                if recursive:
                    shutil.rmtree(target)
                else:
                    target.rmdir()
            else:
                target.unlink()
        except FileError:
            raise
        except OSError as exc:
            raise FileError(f"删除失败：{exc}") from exc
        return {"ok": True, "path": self._relative(target)}

    def rename(self, old: Any, new: Any) -> dict[str, Any]:
        source = self._resolve(old)
        target = self._resolve(new, must_exist=False)
        if source == self.root:
            raise FileError("不能重命名根目录")
        if target == self.root:
            raise FileError("目标路径无效")
        if target.exists():
            raise FileError("目标已存在")
        if not target.parent.is_dir():
            raise FileError("目标父目录不存在")
        try:
            source.rename(target)
        except OSError as exc:
            raise FileError(f"重命名失败：{exc}") from exc
        return {"ok": True, "path": self._relative(target)}
