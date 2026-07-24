// Idempotent daemon launcher for the plugin startup hook and the start action:
// exits immediately if a daemon already answers on the control socket.
import { daemonAlive } from "./control.js";
import { launchDaemon, waitFor } from "./launch.js";
import { LOG_FILE } from "./config.js";

const READY_TIMEOUT_MS = 5000;

if (await daemonAlive()) {
  console.log("codex-micro daemon already running");
  process.exit(0);
}

const pid = launchDaemon();
// A detached spawn only proves a process started. It can still lose the
// single-instance race or fail to open its socket, so report what actually
// happened rather than the fact that spawn returned.
if (!(await waitFor(daemonAlive, READY_TIMEOUT_MS))) {
  console.error(
    `codex-micro daemon (pid ${pid}) did not come up; see ${LOG_FILE}`,
  );
  process.exit(1);
}
console.log(`codex-micro daemon started (pid ${pid}), log: ${LOG_FILE}`);
