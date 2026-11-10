from __future__ import annotations

import base64
import json
import os
import sys
import time
import unittest
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core.crypto import CryptoError, SessionCipher, b64decode, b64encode  # noqa: E402
from core.storage import BackgroundStore  # noqa: E402

INFO = b"astrbot-terminal-shell/v1"


class BrowserSide:
    """Minimal browser peer used to verify the wire protocol."""

    def __init__(self, cipher: SessionCipher, username: str | None = "tester"):
        self.cipher = cipher
        self.username = username
        self.private_key = ec.generate_private_key(ec.SECP256R1())
        raw = self.private_key.public_key().public_bytes(
            Encoding.X962, PublicFormat.UncompressedPoint
        )
        self.handshake = cipher.handshake(b64encode(raw), username)
        peer = ec.EllipticCurvePublicKey.from_encoded_point(
            ec.SECP256R1(), b64decode(self.handshake["pub"])
        )
        shared = self.private_key.exchange(ec.ECDH(), peer)
        self.key = HKDF(
            algorithm=hashes.SHA256(),
            length=32,
            salt=b64decode(self.handshake["salt"]),
            info=INFO,
        ).derive(shared)
        self.sid = self.handshake["sid"]

    def encrypt(self, action: str, payload: dict) -> dict:
        iv = os.urandom(12)
        ct = AESGCM(self.key).encrypt(
            iv,
            json.dumps(payload, separators=(",", ":")).encode(),
            f"{self.sid}|{action}".encode(),
        )
        return {
            "sid": self.sid,
            "a": action,
            "iv": b64encode(iv),
            "ct": b64encode(ct),
        }

    def decrypt(self, action: str, envelope: dict) -> dict:
        raw = AESGCM(self.key).decrypt(
            b64decode(envelope["iv"]),
            b64decode(envelope["ct"]),
            f"{self.sid}|{action}".encode(),
        )
        return json.loads(raw)


class CryptoProtocolTests(unittest.TestCase):
    def test_handshake_and_roundtrip(self):
        cipher = SessionCipher(ttl=300)
        client = BrowserSide(cipher)
        envelope = client.encrypt("echo", {"hello": "世界"})
        payload, session = cipher.decrypt(envelope, "echo", "tester")
        self.assertEqual(payload, {"hello": "世界"})
        self.assertEqual(session.sid, client.sid)

        response = cipher.encrypt(session.sid, "echo", {"ok": True})
        self.assertEqual(client.decrypt("echo", response), {"ok": True})

    def test_action_is_bound_to_ciphertext(self):
        cipher = SessionCipher(ttl=300)
        client = BrowserSide(cipher)
        envelope = client.encrypt("input", {"sid": "t1"})
        with self.assertRaises(CryptoError):
            cipher.decrypt(envelope, "resize", "tester")

    def test_username_binding(self):
        cipher = SessionCipher(ttl=300)
        client = BrowserSide(cipher, username="alice")
        envelope = client.encrypt("list", {})
        with self.assertRaises(CryptoError):
            cipher.decrypt(envelope, "list", "bob")

    def test_tampering_is_rejected(self):
        cipher = SessionCipher(ttl=300)
        client = BrowserSide(cipher)
        envelope = client.encrypt("list", {"x": 1})
        data = bytearray(b64decode(envelope["ct"]))
        data[0] ^= 0xFF
        envelope["ct"] = b64encode(bytes(data))
        with self.assertRaises(CryptoError):
            cipher.decrypt(envelope, "list", "tester")

    def test_expired_session(self):
        cipher = SessionCipher(ttl=60)
        client = BrowserSide(cipher)
        # Expire the server-side idle timer without sleeping for a minute.
        session = cipher._sessions[client.sid]
        session.last_seen = time.time() - 120
        with self.assertRaises(CryptoError):
            cipher.decrypt(client.encrypt("list", {}), "list", "tester")

    def test_server_response_cannot_be_read_with_another_session(self):
        cipher = SessionCipher(ttl=300)
        first = BrowserSide(cipher, username="u")
        second = BrowserSide(cipher, username="u")
        response = cipher.encrypt(first.sid, "stream", {"t": "o"})
        with self.assertRaises(Exception):
            second.decrypt("stream", response)


class BackgroundStoreTests(unittest.TestCase):
    def test_save_load_delete_validation(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            store = BackgroundStore(Path(tmp), max_bytes=1024 * 1024)
            png = b"\x89PNG\r\n\x1a\n" + b"0" * 32
            meta = store.save("alice", "image/png", png)
            self.assertEqual(meta["mime"], "image/png")
            loaded = store.load("alice")
            self.assertEqual(loaded["data"], png)
            self.assertIsNone(store.load("bob"))
            self.assertTrue(store.delete("alice"))
            self.assertIsNone(store.load("alice"))

    def test_rejects_mismatched_magic(self):
        import tempfile

        from core.storage import BackgroundError

        with tempfile.TemporaryDirectory() as tmp:
            store = BackgroundStore(Path(tmp))
            with self.assertRaises(BackgroundError):
                store.save("alice", "image/png", b"not-a-png")


if __name__ == "__main__":
    unittest.main()
