// Stops any running daemon and starts a fresh one. Needed after plugin
// upgrades (new dist/); config edits hot-apply and do not need this.
import { daemonAlive, sendCommand } from "./control.js";
import { launchDaemon, waitFor } from "./launch.js";
import { LOG_FILE } from "./config.js";

const STOP_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 5000;

try {
  await sendCommand("stop");
} catch {
  // not running
}

// Shutdown releases the device and clears Herdr metadata before it gives up
// the control socket, so it is not instant. Launching over a daemon that is
// still bound just makes the new one exit fatal on the socket lock.
if (!(await waitFor(async () => !(await daemonAlive()), STOP_TIMEOUT_MS))) {
  console.error(
    `the running codex-micro daemon did not stop; not launching another (see ${LOG_FILE})`,
  );
  process.exit(1);
}

const pid = launchDaemon();
if (!(await waitFor(daemonAlive, READY_TIMEOUT_MS))) {
  console.error(
    `codex-micro daemon (pid ${pid}) did not come up; see ${LOG_FILE}`,
  );
  process.exit(1);
}
console.log(`codex-micro daemon restarted (pid ${pid}), log: ${LOG_FILE}`);
