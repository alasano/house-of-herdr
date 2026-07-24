// Standalone setup diagnostics. Deliberately not routed through the daemon:
// the moment you need a doctor is when the daemon may be dead or blocked.
// Prints one line per check plus guidance for anything failing.
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HIDAsync, devicesAsync } from "node-hid";
import { daemonAlive, sendCommand } from "./control.js";
import { socketPath } from "./herdr.js";

const check = (name: string, ok: boolean, detail: string) =>
  console.log(`${ok ? "✓" : "✗"} ${name}: ${detail}`);

function run(command: string, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("close", (status) => resolve(status));
    child.on("error", () => resolve(null));
  });
}

// Herdr server reachable?
const herdrUp = await new Promise<boolean>((resolve) => {
  const socket = net.createConnection(socketPath());
  socket.once("connect", () => {
    socket.destroy();
    resolve(true);
  });
  socket.once("error", () => resolve(false));
});
check(
  "herdr server",
  herdrUp,
  herdrUp ? socketPath() : `no socket at ${socketPath()}`,
);

// Daemon running?
const daemonUp = await daemonAlive();
if (daemonUp) {
  const status = await sendCommand("status");
  check(
    "daemon",
    true,
    `running (state: ${String(status.state)}, policy: ${String(status.policy)})`,
  );
  if (status.configError) check("config", false, String(status.configError));
  else check("config", true, "valid");
} else {
  check("daemon", false, "not running; start with: node dist/start.js");
}

// ChatGPT contention?
const chatGpt =
  (await run("pgrep", ["-f", "ChatGPT.app/Contents/MacOS/ChatGPT"])) === 0;
check(
  "chatgpt app",
  !chatGpt,
  chatGpt
    ? "running; the daemon yields the device while it is open"
    : "not running",
);

// Device present, and can this process open it (Input Monitoring)?
const devices = await devicesAsync();
const info = devices.find(
  (d) =>
    d.vendorId === 0x303a &&
    d.productId === 0x8360 &&
    d.usagePage === 0xff00 &&
    d.path,
);
if (!info) {
  check(
    "device",
    false,
    "Codex Micro not found; check power, USB, or Bluetooth",
  );
} else {
  try {
    const device = await HIDAsync.open(info.path!, { nonExclusive: true });
    await device.close();
    check(
      "device",
      true,
      "present and openable (Input Monitoring OK for this terminal)",
    );
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes("privilege violation")) {
      check(
        "device",
        false,
        "open denied: grant Input Monitoring (System Settings → Privacy & Security) to this terminal and to whatever launches the daemon",
      );
    } else if (message.includes("exclusive access")) {
      check(
        "device",
        false,
        "another process holds the device exclusively (ChatGPT app?)",
      );
    } else {
      check("device", false, `open failed: ${message}`);
    }
  }
}

// Accessibility (only needed for `key` bindings).
const tapkey = fileURLToPath(new URL("../bin/tapkey", import.meta.url));
const axStatus = await run(tapkey, ["0", "check"]);
check(
  "accessibility",
  axStatus === 0,
  axStatus === 0
    ? 'granted (needed only for {"key": ...} bindings)'
    : 'not granted; needed only for {"key": ...} bindings (System Settings → Privacy & Security → Accessibility)',
);
