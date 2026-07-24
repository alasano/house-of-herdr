import { describe, expect, it } from "vitest";
import {
  CHANNEL_RPC,
  REPORT_ID,
  Reassembler,
  encodeMessage,
} from "../src/framing.js";

describe("encodeMessage", () => {
  it("frames a short message into one 64-byte report", () => {
    const reports = encodeMessage('{"id":1}');
    expect(reports).toHaveLength(1);
    const report = reports[0]!;
    expect(report.length).toBe(64);
    expect(report[0]).toBe(REPORT_ID);
    expect(report[1]).toBe(CHANNEL_RPC);
    expect(report[2]).toBe(8);
    expect(report.subarray(3, 11).toString("utf8")).toBe('{"id":1}');
  });

  it("splits messages longer than 61 bytes across reports", () => {
    const message = JSON.stringify({
      id: 2,
      method: "v.oai.thstatus",
      params: [{ id: 0, c: 16777215 }],
    });
    const reports = encodeMessage(message);
    expect(reports.length).toBeGreaterThan(1);
    const reassembled = reports
      .map((report) => report.subarray(3, 3 + report[2]!).toString("utf8"))
      .join("");
    expect(reassembled).toBe(message);
  });
});

describe("Reassembler", () => {
  function deviceReports(message: string): Buffer[] {
    // Device-to-host frames are newline-terminated and, on macOS, arrive with
    // the report id as byte 0.
    return encodeMessage(message + "\n");
  }

  it("reassembles a message spanning multiple reports", () => {
    const reassembler = new Reassembler();
    const message = JSON.stringify({
      id: 1,
      result: {
        version: "v0.4.1",
        profile_index: 0,
        layer_index: 1,
        battery: 53,
        is_charging: false,
      },
    });
    const reports = deviceReports(message);
    expect(reports.length).toBeGreaterThan(1);
    const collected = reports.flatMap((report) => reassembler.push(report));
    expect(collected).toEqual([{ channel: CHANNEL_RPC, message }]);
  });

  it("splits multiple newline-delimited messages in one buffer stream", () => {
    const reassembler = new Reassembler();
    const collected = deviceReports('{"a":1}\n{"b":2}').flatMap((report) =>
      reassembler.push(report),
    );
    expect(collected.map((frame) => frame.message)).toEqual([
      '{"a":1}',
      '{"b":2}',
    ]);
  });

  it("decodes a multibyte character split across the report boundary", () => {
    const reassembler = new Reassembler();
    const message = `{"name":"${"x".repeat(51)}€"}`; // the euro sign's 3 bytes straddle byte 61
    const reports = deviceReports(message);
    expect(reports.length).toBe(2);
    const collected = reports.flatMap((report) => reassembler.push(report));
    expect(collected).toEqual([{ channel: CHANNEL_RPC, message }]);
  });

  it("drops a partial frame on reset", () => {
    const reassembler = new Reassembler();
    const [first] = deviceReports('{"partial":"' + "y".repeat(80) + '"}');
    expect(reassembler.push(first!)).toEqual([]);
    reassembler.reset();
    const collected = deviceReports('{"fresh":1}').flatMap((report) =>
      reassembler.push(report),
    );
    expect(collected).toEqual([
      { channel: CHANNEL_RPC, message: '{"fresh":1}' },
    ]);
  });

  it("rejects a report that does not carry the report id", () => {
    const reassembler = new Reassembler();
    // macOS always prefixes numbered input reports. Guessing at the layout
    // would read a channel byte out of a payload on any frame whose channel
    // happened to equal the report id.
    const stripped = deviceReports('{"m":"v.oai.hid"}').map((report) =>
      Buffer.from(report.subarray(1)),
    );
    expect(stripped.flatMap((report) => reassembler.push(report))).toEqual([]);
  });

  it("rejects truncated reports and out-of-range declared lengths", () => {
    const reassembler = new Reassembler();
    expect(reassembler.push(Buffer.from([REPORT_ID, CHANNEL_RPC]))).toEqual([]);

    const overrun = Buffer.alloc(64);
    overrun[0] = REPORT_ID;
    overrun[1] = CHANNEL_RPC;
    overrun[2] = 200; // past both the report end and the payload capacity
    expect(reassembler.push(overrun)).toEqual([]);

    // Declares ten payload bytes but carries one.
    expect(
      reassembler.push(Buffer.from([REPORT_ID, CHANNEL_RPC, 10, 0x61])),
    ).toEqual([]);

    // None of that poisoned the channel buffer.
    const collected = deviceReports('{"ok":1}').flatMap((report) =>
      reassembler.push(report),
    );
    expect(collected).toEqual([{ channel: CHANNEL_RPC, message: '{"ok":1}' }]);
  });
});
