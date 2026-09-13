// macOS Secure Keyboard Entry (a focused password field, a locked password
// manager, Terminal's menu item, the lock screen) makes IOKit deny every
// user-space HID client of a keyboard-class device: writes fail with
// 0xE00002E2 "not permitted" and input queues go silent, the very code a
// missing Input Monitoring grant produces. The keypad's vendor channel shares
// one HID interface with its keyboard, so it is blocked as a whole. The
// console session records one holding process; daemon and doctor name it so
// nobody hunts through System Settings for a grant that is already there.
import { execFile } from "node:child_process";

export interface SecureInputHolder {
  pid: number;
  /** App or command name; null once that process has exited. */
  name: string | null;
}

export function parseSecureInputPid(ioreg: string): number | null {
  const match = /"kCGSSessionSecureInputPID"=(\d+)/.exec(ioreg);
  return match ? Number(match[1]) : null;
}

// "/Applications/Zen.app/Contents/MacOS/zen" reads better as "Zen".
export function holderName(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  const bundle = /([^/]+)\.app\//.exec(trimmed);
  return bundle ? bundle[1]! : (trimmed.split("/").pop() ?? trimmed);
}

// The recorded pid is one holder, not necessarily the last one: a password
// manager can keep the state on after the recorded app has quit.
export function describeSecureInput(holder: SecureInputHolder): string {
  if (holder.name) {
    return `on, held by ${holder.name} (pid ${holder.pid}); the keypad's raw HID channel is blocked until that app releases it: leave the password field, or unlock or quit the app`;
  }
  return `on, recorded for pid ${holder.pid} which has exited; another app still holds it: unlock your password manager or leave any focused password field, else log out and back in`;
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout) =>
      resolve(error ? "" : stdout),
    );
  });
}

// The flag lives on the registry root, so depth 1 is enough and cheap.
export async function secureInputHolder(): Promise<SecureInputHolder | null> {
  const pid = parseSecureInputPid(await run("ioreg", ["-l", "-d1", "-w0"]));
  if (pid === null) return null;
  const name = holderName(await run("ps", ["-o", "comm=", "-p", String(pid)]));
  return { pid, name };
}
