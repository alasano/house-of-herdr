// Posts a synthetic keystroke via the compiled tapkey helper; requires the
// Accessibility permission for the daemon's process tree. Isolated from the
// dispatch logic so that logic can be exercised without driving the real
// keyboard.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { KeyCombo } from "./keys.js";

export type KeyMode = "tap" | "down" | "up";

export function postKey(
  combo: KeyCombo,
  mode: KeyMode,
  log: (message: string) => void,
): void {
  const helper = fileURLToPath(new URL("../bin/tapkey", import.meta.url));
  const args = [String(combo.keyCode), mode, String(combo.modifiers)];
  const child = spawn(helper, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (data: Buffer) => (stderr += data.toString("utf8")));
  child.on("close", (status) => {
    if (status !== 0) {
      log(`key ${combo.keyCode} ${mode} failed: ${stderr.trim()}`);
    }
  });
  child.on("error", (error: Error) =>
    log(`tapkey spawn failed: ${error.message}`),
  );
}
