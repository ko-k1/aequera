"""Minimal Marionette client (Python stdlib only).

Speaks the Marionette protocol (`<length>:<json>` framing, message type 0 for
commands and 1 for responses) to a browser started with `-marionette`. Only
what the local benchmarks need: a session, the chrome context, and script
execution. Not a WebDriver implementation.
"""

import json
import socket
import time


class MarionetteError(RuntimeError):
    pass


class Marionette:
    def __init__(self, port, host="127.0.0.1", connect_timeout=60.0):
        deadline = time.monotonic() + connect_timeout
        last = None
        while time.monotonic() < deadline:
            try:
                self.sock = socket.create_connection((host, port), timeout=5)
                break
            except OSError as e:
                last = e
                time.sleep(0.1)
        else:
            raise MarionetteError(f"no Marionette on {host}:{port}: {last}")
        self.sock.settimeout(None)
        self._buf = b""
        self._id = 0
        self.hello = self._read()

    def _read(self):
        while b":" not in self._buf:
            self._recv()
        head, _, rest = self._buf.partition(b":")
        length = int(head)
        self._buf = rest
        while len(self._buf) < length:
            self._recv()
        body, self._buf = self._buf[:length], self._buf[length:]
        return json.loads(body)

    def _recv(self):
        chunk = self.sock.recv(65536)
        if not chunk:
            raise MarionetteError("Marionette connection closed")
        self._buf += chunk

    def command(self, name, params=None):
        self._id += 1
        data = json.dumps([0, self._id, name, params or {}]).encode()
        self.sock.sendall(str(len(data)).encode() + b":" + data)
        while True:
            msg = self._read()
            if msg[0] == 1 and msg[1] == self._id:
                break
        if msg[2]:
            err = msg[2]
            raise MarionetteError(f"{name}: {err.get('error')}: {err.get('message')}")
        return msg[3]

    def start_session(self, script_timeout_ms=600000):
        self.command("WebDriver:NewSession", {"capabilities": {}})
        self.command("WebDriver:SetTimeouts", {"script": script_timeout_ms})
        self.command("Marionette:SetContext", {"value": "chrome"})

    def execute(self, script, args=None):
        """Runs an async chrome script; it resolves by calling `resolve(value)`."""
        wrapped = (
            "const resolve = arguments[arguments.length - 1];\n"
            "const args = arguments;\n"
            "(async () => {" + script + "})().catch(e => resolve({__error: String(e) + '\\n' + e.stack}));"
        )
        value = self.command(
            "WebDriver:ExecuteAsyncScript",
            {"script": wrapped, "args": args or [], "newSandbox": False},
        ).get("value")
        if isinstance(value, dict) and "__error" in value:
            raise MarionetteError(value["__error"])
        return value

    def quit(self):
        try:
            self.command("Marionette:Quit", {"flags": ["eForceQuit"]})
        except (MarionetteError, OSError):
            pass
        finally:
            self.close()

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass
