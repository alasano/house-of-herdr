// Key-map popup TUI: the six Agent Keys in the device's physical layout (two
// centered on top, four below) as boxes colored by status, fed by the
// daemon's watch stream. Keys: p toggles sticky/mirror, q / esc / ctrl+c closes.
import { clipEnd, clipStart, padTo, sanitize } from "./text.js";
import {
  sendCommand,
  watchStatus,
  type ControlState,
  type SlotStatus,
  type StatusPayload,
} from "./control.js";
import { STATUS_COLORS } from "./lights.js";
import { GAP, MARGIN, layout, type Layout } from "./popup-layout.js";

const BOX_HEIGHT = 6;
const FALLBACK_COLUMNS = 160; // the manifest's popup width, for a non-TTY stdout

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const ALT_ENTER = "\x1b[?1049h";
const ALT_LEAVE = "\x1b[?1049l";

let status: StatusPayload | null = null;
let connected = true;
let grid: Layout = layout(FALLBACK_COLUMNS);

const STATE_LABELS: Record<ControlState, [number, string]> = {
  connected: [0x22cc55, "connected"],
  connecting: [0xffaa00, "connecting…"],
  yielded: [0xffaa00, "yielded to Codex app"],
  device_absent: [0xff5555, "not found"],
  permission_required: [0xff5555, "Input Monitoring permission required"],
  device_busy: [0xff5555, "held by another app"],
  stopped: [0xff5555, "released"],
};

function fg(color: number): string {
  return `\x1b[38;2;${(color >> 16) & 0xff};${(color >> 8) & 0xff};${color & 0xff}m`;
}

function content(text: string, style = ""): string {
  const padded = padTo(text, grid.inner);
  return `│ ${style ? style + padded + RESET : padded} │`;
}

function field(text: string): string {
  return clipEnd(sanitize(text), grid.inner);
}

function boxLines(slot: SlotStatus | null, key: number): string[] {
  const { cell, inner } = grid;
  if (!slot) {
    const top = `┌ [${key}] ` + "─".repeat(cell - 7) + "┐";
    return [
      DIM + top + RESET,
      DIM + content("") + RESET,
      DIM + content("· empty ·".padStart(Math.floor((inner + 9) / 2))) + RESET,
      DIM + content("") + RESET,
      DIM + content("") + RESET,
      DIM + "└" + "─".repeat(cell - 2) + "┘" + RESET,
    ];
  }
  const color = fg(STATUS_COLORS[slot.status]);
  const label = ` [${key}] ● ${slot.status} `;
  const top =
    "┌" + label + "─".repeat(Math.max(0, cell - 2 - label.length)) + "┐";
  const name = slot.paneName ? `${slot.paneName} (${slot.agent})` : slot.agent;
  return [
    color + BOLD + top + RESET,
    content(field(name)),
    content(field(slot.tab)),
    content(field(slot.workspace)),
    content(clipStart(sanitize(slot.cwd), inner), DIM),
    color + "└" + "─".repeat(cell - 2) + "┘" + RESET,
  ];
}

function renderRow(
  slots: (SlotStatus | null)[],
  keys: number[],
  indent: number,
): string[] {
  const boxes = keys.map((key, i) => boxLines(slots[i] ?? null, key));
  return Array.from(
    { length: BOX_HEIGHT },
    (_, line) =>
      " ".repeat(indent) + boxes.map((box) => box[line]).join(" ".repeat(GAP)),
  );
}

function render(): void {
  grid = layout(process.stdout.columns ?? FALLBACK_COLUMNS);
  const out: string[] = ["\x1b[2J\x1b[H"];
  if (!status) {
    out.push("  connecting to codex-micro daemon...");
  } else {
    // Total over ControlState, so a new device state is a compile error here
    // rather than a raw enum name rendered at runtime.
    const [color, label] = STATE_LABELS[status.state];
    const device = fg(color) + label + RESET;
    const daemon = connected
      ? ""
      : `    ${fg(0xff5555)}daemon disconnected${RESET}`;
    const herdr = status.herdrConnected
      ? ""
      : `    ${fg(0xff5555)}herdr disconnected${RESET}`;
    const dial =
      status.dialMode === "scroll"
        ? `${status.dialMode} (${status.scrollSteps}×)`
        : status.dialMode;
    out.push(
      `  ${BOLD}Codex Micro${RESET}    policy: ${BOLD}${status.policy.toUpperCase()}${RESET}    dial: ${BOLD}${dial}${RESET}    device: ${device}${daemon}${herdr}`,
    );
    if (status.configError) {
      // Clipped: a validation message is unbounded and would wrap the grid.
      const message = clipEnd(sanitize(status.configError), grid.grid - 16);
      out.push(`  ${fg(0xff5555)}config error: ${message}${RESET}`);
    }
    out.push("  " + DIM + "─".repeat(grid.grid) + RESET);
    out.push("");
    out.push(...renderRow(status.slots.slice(0, 2), [1, 2], grid.topIndent));
    out.push("");
    out.push(...renderRow(status.slots.slice(2, 6), [3, 4, 5, 6], MARGIN));
    out.push("");
    out.push(`  ${DIM}p toggle policy · q close${RESET}`);
  }
  process.stdout.write(out.join("\r\n") + "\r\n");
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

// The alternate buffer keeps the popup from scribbling over whatever was on
// screen; leaving it restores the caller's view when run outside a Herdr pane.
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
