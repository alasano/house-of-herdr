// Standalone setup diagnostics. Deliberately not routed through the daemon:
// the moment you need a doctor is when the daemon may be dead or blocked.
// Prints one line per check plus guidance for anything failing.
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HIDAsync } from "node-hid";
import { chatGptRunning } from "./chatgpt.js";
import { daemonAlive, sendCommand } from "./control.js";
import { classifyOpenError, findCandidates } from "./device.js";
import { socketPath } from "./herdr.js";

const check = (name: string, ok: boolean, detail: string) =>
  console.log(`${ok ? "✓" : "✗"} ${name}: ${detail}`);

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
if (await daemonAlive()) {
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
const chatGpt = await chatGptRunning();
check(
  "chatgpt app",
  !chatGpt,
  chatGpt
    ? "running; the daemon yields the device while it is open"
    : "not running",
);

// Device present, and can this process open it (Input Monitoring)? Discovery
// and error classification come from the daemon's own module so a diagnosis
// here can never drift from what the daemon actually does.
await checkDevice();

async function checkDevice(): Promise<void> {
  let candidates;
  try {
    candidates = await findCandidates();
  } catch (error) {
    check("device", false, `enumeration failed: ${(error as Error).message}`);
    return;
  }
  if (candidates.length === 0) {
    check(
      "device",
      false,
      "Codex Micro not found; check power, USB, or Bluetooth",
    );
    return;
  }
  let lastError: Error | null = null;
  for (const info of candidates) {
    try {
      const device = await HIDAsync.open(info.path!, { nonExclusive: true });
      await device.close();
      check(
        "device",
        true,
        "present and openable (Input Monitoring OK for this terminal)",
      );
      return;
    } catch (error) {
      lastError = error as Error;
    }
  }
  const message = lastError?.message ?? "no candidate opened";
  const guidance: Record<string, string> = {
    permission_required:
      "open denied: grant Input Monitoring (System Settings → Privacy & Security) to this terminal and to whatever launches the daemon",
    device_busy: "another process holds the device exclusively (ChatGPT app?)",
    device_absent: "Codex Micro not found; check power, USB, or Bluetooth",
  };
  check(
    "device",
    false,
    guidance[classifyOpenError(message)] ?? `open failed: ${message}`,
  );
}

// Accessibility (only needed for `key` bindings).
const tapkey = fileURLToPath(new URL("../bin/tapkey", import.meta.url));
const axGranted = await new Promise<boolean>((resolve) => {
  const child = spawn(tapkey, ["0", "check"], { stdio: "ignore" });
  child.on("close", (status) => resolve(status === 0));
  child.on("error", () => resolve(false));
});
check(
  "accessibility",
  axGranted,
  axGranted
    ? 'granted (needed only for {"key": ...} bindings)'
    : 'not granted; needed only for {"key": ...} bindings (System Settings → Privacy & Security → Accessibility)',
);
