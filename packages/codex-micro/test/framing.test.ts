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

  it("handles reports without the leading report id byte", () => {
    const reassembler = new Reassembler();
    const stripped = deviceReports('{"m":"v.oai.hid"}').map((report) =>
      report.subarray(1),
    );
    const collected = stripped.flatMap((report) =>
      reassembler.push(Buffer.from(report)),
    );
    expect(collected).toEqual([
      { channel: CHANNEL_RPC, message: '{"m":"v.oai.hid"}' },
    ]);
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
});
