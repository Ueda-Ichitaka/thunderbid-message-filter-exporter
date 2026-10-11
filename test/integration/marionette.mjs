// About me: Minimal, dependency-free Marionette client for the integration
// tests. Marionette is the remote-control protocol built into Thunderbird
// (length-prefixed JSON over TCP). This client only does what the tests need:
// open a session, switch to the privileged chrome context, run scripts there,
// and quit the application.

import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const COMMAND = 0;
const RESPONSE = 1;

export class Marionette {
  #socket;
  #buffer = Buffer.alloc(0);
  #nextId = 1;
  #pending = new Map();
  #onGreeting;

  static async connect(port, { timeoutMs = 90_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const client = new Marionette();
        await client.#open(port);
        return client;
      } catch (error) {
        if (Date.now() > deadline) {
          throw new Error(`Marionette not reachable on port ${port}: ${error.message}`);
        }
        await sleep(500);
      }
    }
  }

  #open(port) {
    return new Promise((resolve, reject) => {
      this.#onGreeting = resolve;
      this.#socket = net.connect(port, "127.0.0.1");
      this.#socket.once("error", reject);
      this.#socket.on("data", (data) => this.#receive(data));
      this.#socket.once("close", () => {
        for (const { reject: rejectPending } of this.#pending.values()) {
          rejectPending(new Error("Marionette connection closed"));
        }
        this.#pending.clear();
        reject(new Error("Marionette connection closed before greeting"));
      });
    });
  }

  #receive(data) {
    this.#buffer = Buffer.concat([this.#buffer, data]);
    for (;;) {
      const colon = this.#buffer.indexOf(":");
      if (colon < 0) {
        return;
      }
      const length = Number(this.#buffer.subarray(0, colon).toString());
      const end = colon + 1 + length;
      if (this.#buffer.length < end) {
        return;
      }
      const message = JSON.parse(this.#buffer.subarray(colon + 1, end).toString());
      this.#buffer = this.#buffer.subarray(end);
      if (!Array.isArray(message)) {
        this.#onGreeting(message);
        continue;
      }
      const [type, id, error, result] = message;
      const pending = this.#pending.get(id);
      if (type !== RESPONSE || !pending) {
        continue;
      }
      this.#pending.delete(id);
      if (error) {
        pending.reject(new Error(`${error.error}: ${error.message}\n${error.stacktrace ?? ""}`));
      } else {
        pending.resolve(result);
      }
    }
  }

  send(name, parameters = {}) {
    const id = this.#nextId++;
    const body = Buffer.from(JSON.stringify([COMMAND, id, name, parameters]));
    this.#socket.write(`${body.length}:`);
    this.#socket.write(body);
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  async startChromeSession() {
    await this.send("WebDriver:NewSession", { capabilities: {} });
    await this.send("Marionette:SetContext", { value: "chrome" });
    await this.send("WebDriver:SetTimeouts", { script: 60_000 });
  }

  // Runs `body` as the body of an async function in Thunderbird's chrome
  // context. The function sees the passed values as `args` and its return
  // value (JSON-serializable) is returned here. All scripts share one sandbox,
  // so globals defined by one script are visible to later ones.
  async executeChrome(body, args = []) {
    const script = `
      const done = arguments[arguments.length - 1];
      const args = Array.from(arguments).slice(0, -1);
      (async () => { ${body}\n })().then(
        (value) => done({ ok: true, value }),
        (error) => done({ ok: false, error: String(error) + "\\n" + (error && error.stack) })
      );`;
    const { value: outcome } = await this.send("WebDriver:ExecuteAsyncScript", {
      script,
      args,
      sandbox: "integration-tests",
    });
    if (!outcome.ok) {
      throw new Error(`Chrome script failed: ${outcome.error}`);
    }
    return outcome.value;
  }

  async quit() {
    try {
      await this.send("Marionette:Quit", { flags: ["eForceQuit"] });
    } catch {
      // The connection may drop before the quit response arrives.
    }
    this.#socket.destroy();
  }
}
