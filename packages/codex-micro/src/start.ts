// Idempotent daemon launcher for the plugin startup hook and the start action:
// exits immediately if a daemon already answers on the control socket.
import { daemonAlive } from "./control.js";
import { launchDaemon } from "./launch.js";
import { LOG_FILE } from "./config.js";

if (await daemonAlive()) {
  console.log("codex-micro daemon already running");
  process.exit(0);
}

const pid = launchDaemon();
console.log(`codex-micro daemon started (pid ${pid}), log: ${LOG_FILE}`);
