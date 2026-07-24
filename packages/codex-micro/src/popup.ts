// Key-map popup TUI: the six Agent Keys in the device's physical layout (two
// centered on top, four below) as boxes colored by status, fed by the
// daemon's watch stream. Keys: p toggles sticky/mirror, q / esc / ctrl+c closes.
import {
  sendCommand,
  watchStatus,
  type SlotStatus,
  type StatusPayload,
} from "./control.js";
import { STATUS_COLORS } from "./lights.js";
import type { AgentStatus } from "./slots.js";

const CELL = 36; // outer box width
const INNER = CELL - 4; // text width inside "│ ... │"
const GAP = 3;
const MARGIN = 3;
const GRID = 4 * CELL + 3 * GAP;
const TOP_INDENT = MARGIN + Math.floor((GRID - (2 * CELL + GAP)) / 2);
const BOX_HEIGHT = 6;

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

let status: StatusPayload | null = null;

const STATE_LABELS: Record<string, [number, string]> = {
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

function clipEnd(text: string, width: number): string {
  return text.length > width ? text.slice(0, width - 1) + "…" : text;
}

function clipStart(text: string, width: number): string {
  return text.length > width ? "…" + text.slice(text.length - width + 1) : text;
}

function content(text: string, style = ""): string {
  const padded = text.padEnd(INNER);
  return `│ ${style ? style + padded + RESET : padded} │`;
}

function boxLines(slot: SlotStatus | null, key: number): string[] {
  if (!slot) {
    const top = `┌ [${key}] ` + "─".repeat(CELL - 7) + "┐";
    return [
      DIM + top + RESET,
      DIM + content("") + RESET,
      DIM + content("· empty ·".padStart(Math.floor((INNER + 9) / 2))) + RESET,
      DIM + content("") + RESET,
      DIM + content("") + RESET,
      DIM + "└" + "─".repeat(CELL - 2) + "┘" + RESET,
    ];
  }
  const color = fg(STATUS_COLORS[slot.status as AgentStatus]);
  const label = ` [${key}] ● ${slot.status} `;
  const top =
    "┌" + label + "─".repeat(Math.max(0, CELL - 2 - label.length)) + "┐";
  const name = slot.paneName ? `${slot.paneName} (${slot.agent})` : slot.agent;
  return [
    color + BOLD + top + RESET,
    content(clipEnd(name, INNER)),
    content(clipEnd(slot.tab, INNER)),
    content(clipEnd(slot.workspace, INNER)),
    content(clipStart(slot.cwd, INNER), DIM),
    color + "└" + "─".repeat(CELL - 2) + "┘" + RESET,
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
  const out: string[] = ["\x1b[2J\x1b[H"];
  if (!status) {
    out.push("  connecting to codex-micro daemon...");
  } else {
    const state = STATE_LABELS[status.state] ?? [0xff5555, status.state];
    const device = fg(state[0] as number) + (state[1] as string) + RESET;
    const herdr = status.herdrConnected
      ? ""
      : `    ${fg(0xff5555)}herdr disconnected${RESET}`;
    out.push(
      `  ${BOLD}Codex Micro${RESET}    policy: ${BOLD}${status.policy.toUpperCase()}${RESET}    dial: ${BOLD}${status.dialMode}${RESET}    device: ${device}${herdr}`,
    );
    if (status.configError) {
      out.push(`  ${fg(0xff5555)}config error: ${status.configError}${RESET}`);
    }
    out.push("  " + DIM + "─".repeat(GRID) + RESET);
    out.push("");
    out.push(...renderRow(status.slots.slice(0, 2), [1, 2], TOP_INDENT));
    out.push("");
    out.push(...renderRow(status.slots.slice(2, 6), [3, 4, 5, 6], MARGIN));
    out.push("");
    out.push(`  ${DIM}p toggle policy · q close${RESET}`);
  }
  process.stdout.write(out.join("\r\n") + "\r\n");
}

const socket = watchStatus(
  (payload) => {
    status = payload;
    render();
  },
  () => {
    process.stdout.write("\r\ndaemon connection closed\r\n");
    process.exit(0);
  },
);

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", (data) => {
  const key = data.toString("utf8");
  if (key === "q" || key === "\x1b" || key === "\x03") {
    socket.destroy();
    process.exit(0);
  }
  if (key === "p") {
    void sendCommand("toggle-policy").catch(() => {});
  }
});
process.stdout.on("resize", render);
render();
