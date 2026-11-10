from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core.terminal import TerminalManager  # noqa: E402


class TerminalManagerTests(unittest.TestCase):
    def test_create_write_output_and_close(self):
        async def run():
            manager = TerminalManager(max_sessions=2, idle_timeout=60)
            info = manager.create("tester", "owner-1", 100, 30)
            sid = info["sid"]
            try:
                self.assertTrue(info["alive"])
                self.assertIn("sid", info)
                session = manager.get(sid, "tester")
                session.write(b"echo TERMINAL_SHELL_OK\r\n")

                hub = manager.hub_for("tester")
                chunks = []
                deadline = asyncio.get_running_loop().time() + 15
                while asyncio.get_running_loop().time() < deadline:
                    for event in hub.snapshot(0):
                        if event.get("t") == "o" and event.get("s") == sid:
                            import base64

                            chunks.append(base64.b64decode(event["d"]))
                    if b"TERMINAL_SHELL_OK" in b"".join(chunks):
                        break
                    await asyncio.sleep(0.1)
                self.assertIn(b"TERMINAL_SHELL_OK", b"".join(chunks))
                self.assertGreater(len(session.info()["history"]), 0)
            finally:
                await manager.shutdown()

        asyncio.run(run())

    def test_limits_and_ownership(self):
        async def run():
            manager = TerminalManager(max_sessions=1, idle_timeout=60)
            first = manager.create("alice", "o", 80, 24)
            with self.assertRaises(Exception):
                manager.create("alice", "o", 80, 24)
            with self.assertRaises(Exception):
                manager.get(first["sid"], "bob")
            await manager.shutdown()

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
