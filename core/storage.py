"""Per-user background and UI preference storage.

All mutable plugin data lives under ``data/plugin_data/<plugin_name>/`` so
plugin updates/reinstalls never overwrite it and AstrBot's "persistent data"
cleanup can find it.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import threading
import time
from pathlib import Path
from typing import Any, Callable

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ALLOWED_MIME = {
    "image/jpeg": (b"\xff\xd8\xff",),
    "image/png": (b"\x89PNG\r\n\x1a\n",),
    "image/webp": (b"RIFF",),
    "image/gif": (b"GIF87a", b"GIF89a"),
    "image/bmp": (b"BM",),
}

PREFERENCE_SPECS: dict[str, tuple[Callable[[Any], Any], float, float]] = {
    "size": (float, 0.45, 6.0),
    "glow": (float, 0.35, 2.0),
    "drift": (float, 0.0, 2.5),
    "veil": (float, 0.15, 0.9),
    "fontSize": (int, 11, 20),
}


class BackgroundError(Exception):
    """A user-facing background storage error."""


class PreferenceError(Exception):
    """A user-facing preference storage error."""


def _key(username: str | None) -> str:
    value = (username or "anonymous").encode("utf-8")
    return hashlib.sha256(value).hexdigest()[:24]


def normalize_preferences(values: Any) -> dict[str, Any]:
    """Whitelist and clamp the small set of UI preferences we persist."""
    if not isinstance(values, dict):
        return {}
    result: dict[str, Any] = {}
    for name, (convert, lower, upper) in PREFERENCE_SPECS.items():
        if name not in values:
            continue
        try:
            value = convert(values[name])
        except (TypeError, ValueError):
            continue
        if isinstance(value, float) and value != value:  # NaN
            continue
        result[name] = max(lower, min(upper, value))
    if "fontSize" in result:
        result["fontSize"] = int(round(result["fontSize"]))
    return result


class BackgroundStore:
    """Store one background image per WebUI user on local disk."""

    def __init__(self, root: Path, max_bytes: int = 8 * 1024 * 1024):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.max_bytes = max(256 * 1024, int(max_bytes))

    def _paths(self, username: str | None) -> tuple[Path, Path]:
        key = _key(username)
        return self.root / f"{key}.bin", self.root / f"{key}.json"

    def load(self, username: str | None) -> dict[str, Any] | None:
        image_path, meta_path = self._paths(username)
        if not image_path.is_file() or not meta_path.is_file():
            return None
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            data = image_path.read_bytes()
        except (OSError, ValueError):
            return None
        if not isinstance(meta, dict):
            return None
        mime = meta.get("mime")
        if mime not in ALLOWED_MIME or not data:
            return None
        try:
            updated_at = int(meta.get("updated_at", 0))
        except (TypeError, ValueError):
            updated_at = 0
        return {
            "mime": mime,
            "bytes": len(data),
            "updated_at": updated_at,
            "data": data,
        }

    def save(self, username: str | None, mime: str, data: bytes) -> dict[str, Any]:
        if mime not in ALLOWED_MIME:
            raise BackgroundError("不支持的图片格式")
        if not data:
            raise BackgroundError("图片内容为空")
        if len(data) > self.max_bytes:
            limit = self.max_bytes // (1024 * 1024)
            raise BackgroundError(f"图片不能超过 {limit} MB")
        if not self._magic_matches(mime, data[:16]):
            raise BackgroundError("图片内容与格式不匹配")

        image_path, meta_path = self._paths(username)
        image_tmp = image_path.with_suffix(".bin.tmp")
        meta_tmp = meta_path.with_suffix(".json.tmp")
        meta = {
            "mime": mime,
            "bytes": len(data),
            "updated_at": int(time.time()),
        }
        try:
            image_tmp.write_bytes(data)
            meta_tmp.write_text(
                json.dumps(meta, ensure_ascii=False),
                encoding="utf-8",
            )
            os.replace(image_tmp, image_path)
            os.replace(meta_tmp, meta_path)
        except OSError as exc:
            for path in (image_tmp, meta_tmp):
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    pass
            raise BackgroundError(f"保存背景图片失败：{exc}") from exc

        return {
            "mime": mime,
            "bytes": len(data),
            "updated_at": meta["updated_at"],
        }

    def delete(self, username: str | None) -> bool:
        image_path, meta_path = self._paths(username)
        removed = False
        for path in (image_path, meta_path):
            try:
                path.unlink()
                removed = True
            except FileNotFoundError:
                pass
            except OSError as exc:
                raise BackgroundError(f"删除背景图片失败：{exc}") from exc
        return removed

    @staticmethod
    def _magic_matches(mime: str, header: bytes) -> bool:
        magics = ALLOWED_MIME.get(mime, ())
        if mime == "image/webp":
            return (
                len(header) >= 12
                and header[:4] == b"RIFF"
                and header[8:12] == b"WEBP"
            )
        return any(header.startswith(magic) for magic in magics)


class PreferenceStore:
    """Store one small JSON document of UI preferences per WebUI user."""

    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()

    def _path(self, username: str | None) -> Path:
        return self.root / f"{_key(username)}.json"

    def load(self, username: str | None) -> dict[str, Any]:
        path = self._path(username)
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"settings": {}, "updated_at": 0}
        if not isinstance(raw, dict):
            return {"settings": {}, "updated_at": 0}
        settings = normalize_preferences(raw.get("settings"))
        try:
            updated_at = int(raw.get("updated_at", 0))
        except (TypeError, ValueError):
            updated_at = 0
        return {
            "settings": settings,
            "updated_at": updated_at,
        }

    def save(self, username: str | None, settings: Any) -> dict[str, Any]:
        normalized = normalize_preferences(settings)
        if not normalized:
            raise PreferenceError("没有可保存的界面设置")
        path = self._path(username)
        tmp = path.with_suffix(".json.tmp")
        payload = {
            "settings": normalized,
            "updated_at": int(time.time()),
        }
        with self._lock:
            try:
                tmp.write_text(
                    json.dumps(payload, ensure_ascii=False),
                    encoding="utf-8",
                )
                os.replace(tmp, path)
            except OSError as exc:
                try:
                    tmp.unlink(missing_ok=True)
                except OSError:
                    pass
                raise PreferenceError(f"保存界面设置失败：{exc}") from exc
        return payload

    def delete(self, username: str | None) -> bool:
        path = self._path(username)
        with self._lock:
            try:
                path.unlink()
                return True
            except FileNotFoundError:
                return False
            except OSError as exc:
                raise PreferenceError(f"删除界面设置失败：{exc}") from exc


class SessionSnapshotStore:
    """Encrypted at-rest snapshots of persistent chat shell output.

    The key lives next to the snapshots in the plugin data directory.  This
    protects against casual inspection / accidental plaintext backups; it is
    not a substitute for full-disk encryption against someone who can read the
    plugin data directory as the AstrBot process user.
    """

    MAGIC = b"TSS1"
    AAD = b"terminal-shell-session-v1"
    KEY_BYTES = 32
    IV_BYTES = 12

    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._key_path = self.root / ".session.key"
        self._key = self._load_or_create_key()

    def _load_or_create_key(self) -> bytes:
        with self._lock:
            try:
                key = self._key_path.read_bytes()
            except OSError:
                key = b""
            if len(key) != self.KEY_BYTES:
                key = secrets.token_bytes(self.KEY_BYTES)
                tmp = self._key_path.with_suffix(".key.tmp")
                try:
                    tmp.write_bytes(key)
                    try:
                        os.chmod(tmp, 0o600)
                    except OSError:
                        pass
                    os.replace(tmp, self._key_path)
                except OSError:
                    try:
                        tmp.unlink(missing_ok=True)
                    except OSError:
                        pass
            try:
                os.chmod(self._key_path, 0o600)
            except OSError:
                pass
            return key

    def _path(self, key: str) -> Path:
        digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:32]
        return self.root / f"{digest}.bin"

    def save(
        self,
        key: str,
        history: bytes,
        meta: dict[str, Any] | None = None,
    ) -> bool:
        """Encrypt and atomically persist one transcript snapshot."""
        payload = {
            "history": base64.b64encode(history[-96 * 1024 :]).decode("ascii"),
            **(meta or {}),
        }
        plaintext = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        iv = secrets.token_bytes(self.IV_BYTES)
        try:
            ciphertext = AESGCM(self._key).encrypt(iv, plaintext, self.AAD)
        except Exception:
            return False
        blob = self.MAGIC + iv + ciphertext
        target = self._path(key)
        tmp = target.with_suffix(".bin.tmp")
        try:
            tmp.write_bytes(blob)
            os.replace(tmp, target)
            return True
        except OSError:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
            return False

    def load(self, key: str) -> dict[str, Any] | None:
        try:
            blob = self._path(key).read_bytes()
        except OSError:
            return None
        if len(blob) < len(self.MAGIC) + self.IV_BYTES + 16:
            return None
        if not blob.startswith(self.MAGIC):
            return None
        iv_start = len(self.MAGIC)
        iv = blob[iv_start : iv_start + self.IV_BYTES]
        ciphertext = blob[iv_start + self.IV_BYTES :]
        try:
            plaintext = AESGCM(self._key).decrypt(iv, ciphertext, self.AAD)
            payload = json.loads(plaintext.decode("utf-8"))
        except Exception:
            return None
        if not isinstance(payload, dict):
            return None
        try:
            history = base64.b64decode(payload.pop("history", ""), validate=True)
        except Exception:
            return None
        payload["history"] = history
        return payload

    def delete(self, key: str) -> bool:
        try:
            self._path(key).unlink()
            return True
        except FileNotFoundError:
            return False
        except OSError:
            return False
