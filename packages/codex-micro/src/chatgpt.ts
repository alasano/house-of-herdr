// The ChatGPT desktop app cannot share the device: opened first it seizes it
// exclusively, opened second both hosts receive every input (double dispatch).
// The daemon yields to it and the doctor reports contention with it, so both
// must detect it the same way.
import { spawn } from "node:child_process";

const CHATGPT_BINARY = "ChatGPT.app/Contents/MacOS/ChatGPT";

export function chatGptRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("pgrep", ["-f", CHATGPT_BINARY], { stdio: "ignore" });
    child.on("close", (status) => resolve(status === 0));
    child.on("error", () => resolve(false));
  });
}
