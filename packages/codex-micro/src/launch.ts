// Shared daemon spawner for start.ts and restart.ts.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensurePluginDirs, LOG_FILE } from "./config.js";

// The daemon appends for its whole life and retries a missing device forever,
// so the log needs a ceiling somewhere. Launch is the one moment no writer
// holds it.
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const POLL_MS = 100;

function rotateLog(): void {
  try {
    const stat = fs.statSync(LOG_FILE, { throwIfNoEntry: false });
    if (stat && stat.size > MAX_LOG_BYTES) {
      fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
  } catch {
    // An unrotatable log must never block a launch.
  }
}

export function launchDaemon(): number | undefined {
  ensurePluginDirs();
  rotateLog();
  const logFd = fs.openSync(LOG_FILE, "a");
  try {
    const daemonPath = fileURLToPath(new URL("./daemon.js", import.meta.url));
    const child = spawn(process.execPath, [daemonPath], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    return child.pid;
  } finally {
    // The child inherited its own descriptors; ours is done.
    fs.closeSync(logFd);
  }
}

export async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
