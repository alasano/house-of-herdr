// Sends one control command to the running daemon: ctl.js <status|toggle-policy|popup|stop>
import { sendCommand } from "./control.js";

const cmd = process.argv[2];
if (!cmd || !["status", "toggle-policy", "popup", "stop"].includes(cmd)) {
  console.error("usage: ctl.js <status|toggle-policy|popup|stop>");
  process.exit(2);
}

try {
  console.log(JSON.stringify(await sendCommand(cmd), null, 2));
} catch {
  console.error("codex-micro daemon is not running");
  process.exit(1);
}
