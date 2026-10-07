// Key-map popup TUI. Layout is pure and adapts to the actual pane size.
// Keys: p toggles sticky/mirror, q / esc / ctrl+c closes.
import { sendCommand, watchStatus, type StatusPayload } from "./control.js";
import { renderPopup } from "./popup-render.js";

const ALT_ENTER = "\x1b[?1049h";
const ALT_LEAVE = "\x1b[?1049l";
let status: StatusPayload | null = null;
let connected = true;

function render(): void {
  const lines = renderPopup(
    status,
    connected,
    process.stdout.columns ?? 160,
    process.stdout.rows ?? 22,
  );
  // No final newline: the last line must not scroll the terminal buffer.
  process.stdout.write("\x1b[2J\x1b[H" + lines.join("\r\n"));
}

const watcher = watchStatus(
  (payload) => {
    status = payload;
    connected = true;
    render();
  },
  () => {
    connected = false;
    render();
  },
);

let exiting = false;
function quit(): void {
  if (exiting) process.exit(0);
  exiting = true;
  watcher.stop();
  process.stdin.setRawMode?.(false);
  process.stdout.write(ALT_LEAVE);
  process.exit(0);
}

process.stdout.write(ALT_ENTER);
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", (data) => {
  const key = data.toString("utf8");
  if (key === "q" || key === "\x1b" || key === "\x03") quit();
  if (key === "p") void sendCommand("toggle-policy").catch(() => {});
});
process.on("SIGTERM", quit);
process.on("SIGINT", quit);
process.stdout.on("resize", render);
render();
