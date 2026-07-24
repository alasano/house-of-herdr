// Stops any running daemon and starts a fresh one. Needed after plugin
// upgrades (new dist/); config edits hot-apply and do not need this.
import { daemonAlive, sendCommand } from "./control.js";
import { launchDaemon } from "./launch.js";
import { LOG_FILE } from "./config.js";

try {
  await sendCommand("stop");
} catch {
  // not running
}
for (let i = 0; i < 15 && (await daemonAlive()); i++) {
  await new Promise((resolve) => setTimeout(resolve, 200));
}
const pid = launchDaemon();
console.log(`codex-micro daemon restarted (pid ${pid}), log: ${LOG_FILE}`);
