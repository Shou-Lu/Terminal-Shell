"""Application-layer encryption for Terminal Shell.

The browser generates an ephemeral P-256 key pair, sends the raw public key to
the plugin, and both sides derive an AES-256-GCM key with HKDF-SHA256. Every
request body and every response body (including each SSE event) is wrapped in
an authenticated envelope. The envelope also binds the ciphertext to the
plugin action, so a captured payload cannot be replayed against another
endpoint.
"""

from __future__ import annotations

import base64
import binascii
import json
import secrets
import threading
import time
from dataclasses import dataclass, field
from typing import Any

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

HKDF_INFO = b"astrbot-terminal-shell/v1"
IV_BYTES = 12
KEY_BYTES = 32
MAX_CIPHERTEXT_BYTES = 48 * 1024 * 1024


class CryptoError(Exception):
    """Raised when a handshake or an encrypted envelope is invalid."""


def b64encode(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def b64decode(value: str) -> bytes:
    if not isinstance(value, str) or not value:
        raise CryptoError("缺少加密数据")
    try:
        return base64.b64decode(value.encode("ascii"), validate=True)
    except (binascii.Error, UnicodeEncodeError, ValueError) as exc:
        raise CryptoError("加密数据不是合法的 Base64") from exc


@dataclass
class SecureSession:
    """An ephemeral AES session shared with one browser view."""

    sid: str
    key: bytes
    username: str | None
    created_at: float
    last_seen: float
    requests: int = 0
    label: str = ""

    def expired(self, ttl: int, now: float | None = None) -> bool:
        now = time.time() if now is None else now
        return now - self.last_seen > ttl


@dataclass
class SessionCipher:
    """Handshake and envelope codec used by every plugin API handler."""

    ttl: int = 3600
    max_sessions: int = 256
    _sessions: dict[str, SecureSession] = field(default_factory=dict)
    _lock: threading.RLock = field(default_factory=threading.RLock)

    def __post_init__(self) -> None:
        self.ttl = max(60, int(self.ttl))
        self.max_sessions = max(8, int(self.max_sessions))

    # ------------------------------------------------------------------
    # Handshake
    # ------------------------------------------------------------------
    def handshake(
        self,
        client_public_key: Any,
        username: str | None,
        label: str = "",
    ) -> dict[str, Any]:
        """Create a session from a browser P-256 public key."""
        if not isinstance(client_public_key, str):
            raise CryptoError("缺少客户端公钥")
        raw = b64decode(client_public_key)
        if len(raw) != 65 or raw[0] != 0x04:
            raise CryptoError("客户端公钥格式不正确")

        try:
            peer_key = ec.EllipticCurvePublicKey.from_encoded_point(
                ec.SECP256R1(), raw
            )
        except ValueError as exc:
            raise CryptoError("客户端公钥无效") from exc

        private_key = ec.generate_private_key(ec.SECP256R1())
        shared = private_key.exchange(ec.ECDH(), peer_key)
        salt = secrets.token_bytes(16)
        key = HKDF(
            algorithm=hashes.SHA256(),
            length=KEY_BYTES,
            salt=salt,
            info=HKDF_INFO,
        ).derive(shared)

        sid = secrets.token_urlsafe(24)
        now = time.time()
        session = SecureSession(
            sid=sid,
            key=key,
            username=username,
            created_at=now,
            last_seen=now,
            label=(label or "")[:64],
        )

        with self._lock:
            self._purge_locked(now)
            while len(self._sessions) >= self.max_sessions:
                oldest = min(
                    self._sessions.values(), key=lambda item: item.last_seen
                )
                self._sessions.pop(oldest.sid, None)
            self._sessions[sid] = session

        public_raw = private_key.public_key().public_bytes(
            Encoding.X962, PublicFormat.UncompressedPoint
        )
        return {
            "sid": sid,
            "pub": b64encode(public_raw),
            "salt": b64encode(salt),
            "ttl": self.ttl,
            "server_time": int(now),
        }

    # ------------------------------------------------------------------
    # Session lookup
    # ------------------------------------------------------------------
    def touch(self, sid: Any, username: str | None) -> SecureSession:
        """Validate and refresh a session without decrypting a payload."""
        if not isinstance(sid, str) or not sid or len(sid) > 128:
            raise CryptoError("加密会话不存在")
        with self._lock:
            session = self._sessions.get(sid)
            if session is None:
                raise CryptoError("加密会话不存在或已过期")
            if session.expired(self.ttl):
                self._sessions.pop(sid, None)
                raise CryptoError("加密会话已过期，请刷新页面")
            if (
                session.username is not None
                and username is not None
                and session.username != username
            ):
                raise CryptoError("加密会话不属于当前用户")
            session.last_seen = time.time()
            session.requests += 1
            return session

    # ------------------------------------------------------------------
    # Envelope codec
    # ------------------------------------------------------------------
    def encrypt(
        self,
        sid: str,
        action: str,
        payload: Any,
        *,
        session: SecureSession | None = None,
    ) -> dict[str, str]:
        if session is None:
            with self._lock:
                session = self._sessions.get(sid)
        if session is None:
            raise CryptoError("加密会话不存在")

        plaintext = json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        iv = secrets.token_bytes(IV_BYTES)
        ciphertext = AESGCM(session.key).encrypt(
            iv, plaintext, self._aad(session.sid, action)
        )
        return {
            "sid": session.sid,
            "a": action,
            "iv": b64encode(iv),
            "ct": b64encode(ciphertext),
        }

    def decrypt(
        self,
        envelope: Any,
        action: str,
        username: str | None,
    ) -> tuple[dict[str, Any], SecureSession]:
        if not isinstance(envelope, dict):
            raise CryptoError("请求体格式不正确")
        if envelope.get("a") != action:
            raise CryptoError("加密数据的操作标识不匹配")

        session = self.touch(envelope.get("sid"), username)
        iv = b64decode(envelope.get("iv"))
        ciphertext = b64decode(envelope.get("ct"))
        if len(iv) != IV_BYTES:
            raise CryptoError("加密 IV 长度不正确")
        if len(ciphertext) < 17 or len(ciphertext) > MAX_CIPHERTEXT_BYTES:
            raise CryptoError("加密数据长度不正确")

        try:
            plaintext = AESGCM(session.key).decrypt(
                iv, ciphertext, self._aad(session.sid, action)
            )
        except Exception as exc:  # cryptography raises InvalidTag
            raise CryptoError("密文校验失败") from exc

        try:
            payload = json.loads(plaintext.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise CryptoError("解密后的数据不是合法 JSON") from exc
        if not isinstance(payload, dict):
            raise CryptoError("解密后的数据格式不正确")
        return payload, session

    @staticmethod
    def _aad(sid: str, action: str) -> bytes:
        return f"{sid}|{action}".encode("utf-8")

    # ------------------------------------------------------------------
    # Maintenance
    # ------------------------------------------------------------------
    def cleanup(self) -> int:
        with self._lock:
            return self._purge_locked(time.time())

    def _purge_locked(self, now: float) -> int:
        expired = [
            sid
            for sid, session in self._sessions.items()
            if session.expired(self.ttl, now)
        ]
        for sid in expired:
            self._sessions.pop(sid, None)
        return len(expired)

    def clear(self) -> None:
        with self._lock:
            self._sessions.clear()

    @property
    def session_count(self) -> int:
        with self._lock:
            return len(self._sessions)
