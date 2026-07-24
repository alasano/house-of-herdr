// Codex Micro vendor HID framing: 64-byte reports carrying newline-delimited
// JSON-RPC on a channel byte. Report layout: [report id 6][channel][length][payload...61].
export const REPORT_ID = 6;
export const CHANNEL_RPC = 2;
const REPORT_SIZE = 64;
const MAX_PAYLOAD = 61;
const HEADER_SIZE = 3;
// A message that never terminates must not grow the buffer without bound.
const MAX_BUFFERED = 64 * 1024;

export function encodeMessage(message: string): Buffer[] {
  const bytes = Buffer.from(message, "utf8");
  const reports: Buffer[] = [];
  for (let off = 0; off < bytes.length; off += MAX_PAYLOAD) {
    const chunk = bytes.subarray(off, off + MAX_PAYLOAD);
    const report = Buffer.alloc(REPORT_SIZE);
    report[0] = REPORT_ID;
    report[1] = CHANNEL_RPC;
    report[2] = chunk.length;
    chunk.copy(report, HEADER_SIZE);
    reports.push(report);
  }
  return reports;
}

export interface FrameMessage {
  channel: number;
  message: string;
}

// Device-to-host messages are newline-terminated and may span reports. macOS
// (the only supported platform) delivers numbered input reports with the
// report id as byte 0, so a report that does not start with it is malformed
// rather than an alternate layout. Buffers raw bytes per channel so multibyte
// UTF-8 characters crossing a report boundary decode correctly.
export class Reassembler {
  private buffers = new Map<number, Buffer>();

  push(data: Buffer): FrameMessage[] {
    if (data.length < HEADER_SIZE || data[0] !== REPORT_ID) return [];
    const channel = data[1]!;
    const length = data[2]!;
    // The device declares its payload length; a length past the end of the
    // report, or past the frame capacity, would otherwise pull in zero
    // padding and poison the next message on that channel.
    if (length > MAX_PAYLOAD || HEADER_SIZE + length > data.length) return [];
    const payload = data.subarray(HEADER_SIZE, HEADER_SIZE + length);
    let buffer = Buffer.concat([
      this.buffers.get(channel) ?? Buffer.alloc(0),
      payload,
    ]);
    const messages: FrameMessage[] = [];
    let newline: number;
    while ((newline = buffer.indexOf(0x0a)) !== -1) {
      messages.push({
        channel,
        message: buffer.subarray(0, newline).toString("utf8"),
      });
      buffer = buffer.subarray(newline + 1);
    }
    this.buffers.set(
      channel,
      buffer.length > MAX_BUFFERED ? Buffer.alloc(0) : buffer,
    );
    return messages;
  }

  reset(): void {
    this.buffers.clear();
  }
}
