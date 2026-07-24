// Codex Micro vendor HID framing: 64-byte reports carrying newline-delimited
// JSON-RPC on a channel byte. Report layout: [report id 6][channel][length][payload...61].
export const REPORT_ID = 6;
export const CHANNEL_RPC = 2;
const REPORT_SIZE = 64;
const MAX_PAYLOAD = 61;

export function encodeMessage(message: string): Buffer[] {
  const bytes = Buffer.from(message, "utf8");
  const reports: Buffer[] = [];
  for (let off = 0; off < bytes.length; off += MAX_PAYLOAD) {
    const chunk = bytes.subarray(off, off + MAX_PAYLOAD);
    const report = Buffer.alloc(REPORT_SIZE);
    report[0] = REPORT_ID;
    report[1] = CHANNEL_RPC;
    report[2] = chunk.length;
    chunk.copy(report, 3);
    reports.push(report);
  }
  return reports;
}

export interface FrameMessage {
  channel: number;
  message: string;
}

// Device-to-host messages are newline-terminated and may span reports. macOS
// delivers input reports with the report id as byte 0; strip it when present.
// Buffers raw bytes per channel so multibyte UTF-8 characters crossing a
// report boundary decode correctly.
export class Reassembler {
  private buffers = new Map<number, Buffer>();

  push(data: Buffer): FrameMessage[] {
    const off = data[0] === REPORT_ID ? 1 : 0;
    const channel = data[off] ?? 0;
    const length = data[off + 1] ?? 0;
    const payload = data.subarray(off + 2, off + 2 + length);
    let buffer = Buffer.concat([
      this.buffers.get(channel) ?? Buffer.alloc(0),
      payload,
    ]);
    const messages: FrameMessage[] = [];
    let newline;
    while ((newline = buffer.indexOf(0x0a)) !== -1) {
      messages.push({
        channel,
        message: buffer.subarray(0, newline).toString("utf8"),
      });
      buffer = buffer.subarray(newline + 1);
    }
    this.buffers.set(channel, buffer);
    return messages;
  }

  reset(): void {
    this.buffers.clear();
  }
}
