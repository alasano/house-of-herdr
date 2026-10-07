// Pure, size-aware key-map rendering. The popup owns terminal I/O; this
// module owns layout so narrow/short panes can be regression tested.
import { clipEnd, clipStart, padTo, sanitize } from "./text.js";
import type { ControlState, SlotStatus, StatusPayload } from "./control.js";
import { STATUS_COLORS } from "./lights.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const MARGIN = 2;
const GAP = 3;
const BOX_HEIGHT = 6;

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

function boxLines(
  slot: SlotStatus | null,
  key: number,
  cell: number,
): string[] {
  const inner = cell - 4;
  const field = (text: string) => clipEnd(sanitize(text), inner);
  const content = (text: string, style = "") =>
    `│ ${style}${padTo(text, inner)}${RESET} │`;
  if (!slot) {
    return [
      DIM + `┌ [${key}] ` + "─".repeat(cell - 7) + "┐" + RESET,
      DIM + content("") + RESET,
      DIM + content(field("· empty ·")) + RESET,
      DIM + content("") + RESET,
      DIM + content("") + RESET,
      DIM + "└" + "─".repeat(cell - 2) + "┘" + RESET,
    ];
  }
  const color = fg(STATUS_COLORS[slot.status]);
  const label = clipEnd(` [${key}] ● ${slot.status} `, cell - 2);
  const name = slot.paneName ? `${slot.paneName} (${slot.agent})` : slot.agent;
  return [
    color +
      BOLD +
      "┌" +
      padTo(label, cell - 2).replace(/ +$/, (spaces) =>
        "─".repeat(spaces.length),
      ) +
      "┐" +
      RESET,
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
  cell: number,
): string[] {
  const boxes = keys.map((key, i) => boxLines(slots[i] ?? null, key, cell));
  return Array.from(
    { length: BOX_HEIGHT },
    (_, line) =>
      " ".repeat(indent) + boxes.map((box) => box[line]).join(" ".repeat(GAP)),
  );
}

export function renderPopup(
  status: StatusPayload | null,
  connected: boolean,
  columns: number,
  rows: number,
): string[] {
  // Reserve a column and row: writing into the last cell can auto-wrap or
  // scroll the popup, leaving stale boxes behind on the next update.
  const width = Math.max(0, Math.floor(columns) - 1);
  const height = Math.max(0, Math.floor(rows) - 1);
  if (width < 1 || height < 1) return [];
  const text = (value: string) => clipEnd(sanitize(value), width);
  if (!status) return [text("connecting to codex-micro daemon...")];
  const [color, label] = STATE_LABELS[status.state];
  const dial =
    status.dialMode === "scroll"
      ? `scroll (${status.scrollSteps}×)`
      : status.dialMode;
  const out = [
    BOLD +
      text(
        `Codex / Creator Micro · ${status.policy.toUpperCase()} · dial: ${dial}`,
      ) +
      RESET,
    fg(color) +
      text(
        `device: ${label}${connected ? "" : " · daemon disconnected"}${status.herdrConnected ? "" : " · herdr disconnected"}`,
      ) +
      RESET,
  ];
  if (status.configError)
    out.push(
      fg(0xff5555) + text(`config error: ${status.configError}`) + RESET,
    );
  if (width >= 64 && height >= 19 + (status.configError ? 1 : 0)) {
    const cell = Math.min(36, Math.floor((width - 2 * MARGIN - 3 * GAP) / 4));
    const grid = 4 * cell + 3 * GAP;
    const topIndent = MARGIN + Math.floor((grid - (2 * cell + GAP)) / 2);
    out.push(DIM + "─".repeat(Math.min(width, grid + MARGIN)) + RESET, "");
    out.push(...renderRow(status.slots.slice(0, 2), [1, 2], topIndent, cell));
    out.push("");
    out.push(
      ...renderRow(status.slots.slice(2, 6), [3, 4, 5, 6], MARGIN, cell),
    );
    out.push("");
  } else {
    // A list remains useful when six boxes cannot fit without wrapping.
    for (let i = 0; i < 6; i++) {
      const slot = status.slots[i];
      const line = slot
        ? `[${i + 1}] ${slot.status} · ${slot.paneName ?? slot.agent} · ${slot.workspace}`
        : `[${i + 1}] · empty ·`;
      out.push(
        (slot ? fg(STATUS_COLORS[slot.status]) : DIM) + text(line) + RESET,
      );
    }
  }
  const footer = DIM + text("p toggle policy · q / esc close") + RESET;
  // Keep the close hint visible even in a severely height-constrained pane.
  return [...out.slice(0, Math.max(0, height - 1)), footer];
}
