// Minimal Marionette client (len:json framing), stdlib only.
const net = require("net");

class Marionette {
  constructor(port) {
    this.port = port;
    this.id = 0;
    this.buf = Buffer.alloc(0);
    this.waiters = [];
  }

  async connect(timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await new Promise((resolve, reject) => {
          this.sock = net.connect(this.port, "127.0.0.1", resolve);
          this.sock.once("error", reject);
        });
        break;
      } catch (e) {
        if (Date.now() > deadline) throw e;
        await new Promise(r => setTimeout(r, 300));
      }
    }
    this.sock.on("data", d => this.onData(d));
    await this.next(); // greeting
    await this.cmd("WebDriver:NewSession", { capabilities: { alwaysMatch: { "moz:accessibilityChecks": false } } });
  }

  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const colon = this.buf.indexOf(":");
      if (colon < 0) return;
      const len = Number(this.buf.slice(0, colon).toString());
      if (this.buf.length < colon + 1 + len) return;
      const msg = JSON.parse(this.buf.slice(colon + 1, colon + 1 + len).toString());
      this.buf = this.buf.slice(colon + 1 + len);
      const w = this.waiters.shift();
      if (w) w(msg);
    }
  }

  next() {
    return new Promise(resolve => this.waiters.push(resolve));
  }

  async cmd(name, params = {}) {
    const id = ++this.id;
    const body = JSON.stringify([0, id, name, params]);
    this.sock.write(`${Buffer.byteLength(body)}:${body}`);
    const [, , error, result] = await this.next();
    if (error) {
      const e = new Error(`${name}: ${error.error}: ${error.message}`);
      e.marionette = error;
      throw e;
    }
    return result;
  }

  async context(value) {
    await this.cmd("Marionette:SetContext", { value });
  }

  /** Runs `body` (async function body, may `return`) in the current context. */
  async run(body, args = [], timeout = 120000) {
    await this.cmd("WebDriver:SetTimeouts", { script: timeout });
    const script = `const [__resolve] = [arguments[arguments.length - 1]];
      (async () => { ${body} })().then(v => __resolve({ ok: true, v }), e => __resolve({ ok: false, e: String(e && e.stack || e) }));`;
    const r = await this.cmd("WebDriver:ExecuteAsyncScript", { script, args });
    const value = r.value;
    if (!value.ok) throw new Error(value.e);
    return value.v;
  }

  close() {
    this.sock?.destroy();
  }
}

module.exports = { Marionette };
