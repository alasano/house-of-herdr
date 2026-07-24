// Sends one control command to the running daemon: ctl.js <status|toggle-policy|popup|stop>
import { sendCommand } from "./control.js";

const cmd = process.argv[2];
if (!cmd || !["status", "toggle-policy", "popup", "stop"].includes(cmd)) {
  console.error("usage: ctl.js <status|toggle-policy|popup|stop>");
  process.exit(2);
}

let reply: Record<string, unknown>;
try {
  reply = await sendCommand(cmd);
} catch (error) {
  console.error(
    `codex-micro daemon is not reachable: ${(error as Error).message}`,
  );
  process.exit(1);
}

console.log(JSON.stringify(reply, null, 2));
// A protocol-level error is a failed command, not a successful round trip.
if (reply.error) process.exit(1);
