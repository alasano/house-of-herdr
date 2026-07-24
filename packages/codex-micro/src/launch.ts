// Shared daemon spawner for start.ts and restart.ts.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureStateDir, LOG_FILE } from "./config.js";

export function launchDaemon(): number | undefined {
  ensureStateDir();
  const logFd = fs.openSync(LOG_FILE, "a");
  const daemonPath = fileURLToPath(new URL("./daemon.js", import.meta.url));
  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  return child.pid;
}
