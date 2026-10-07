import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Device } from "node-hid";

const hid = vi.hoisted(() => ({ enumerate: vi.fn(), open: vi.fn() }));
vi.mock("node-hid", () => ({
  devicesAsync: hid.enumerate,
  HIDAsync: { open: hid.open },
}));

import {
  CodexMicro,
  CREATOR_PRODUCT_ID,
  PRODUCT_ID,
  USAGE_PAGE,
  VENDOR_ID,
  findCandidates,
} from "../src/device.js";
import { encodeMessage } from "../src/framing.js";

function candidate(overrides: Partial<Device> = {}): Device {
  return {
    vendorId: VENDOR_ID,
    productId: PRODUCT_ID,
    release: 1,
    interface: 2,
    usagePage: USAGE_PAGE,
    path: "codex",
    ...overrides,
  };
}

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());

describe("findCandidates", () => {
  it("accepts both editions and preserves enumeration order", async () => {
    const creator = candidate({
      productId: CREATOR_PRODUCT_ID,
      path: "creator",
    });
    const codex = candidate();
    hid.enumerate.mockResolvedValue([creator, codex]);
    expect(await findCandidates()).toEqual([creator, codex]);
  });

  it("rejects unrelated devices, standard interfaces and missing paths", async () => {
    hid.enumerate.mockResolvedValue([
      candidate({ vendorId: 1 }),
      candidate({ productId: 1 }),
      candidate({ usagePage: 1 }),
      candidate({ productId: CREATOR_PRODUCT_ID, usagePage: 12 }),
      candidate({ path: undefined }),
      candidate({ path: "" }),
    ]);
    expect(await findCandidates()).toEqual([]);
  });

  it("returns no candidates for an absent device", async () => {
    hid.enumerate.mockResolvedValue([]);
    expect(await findCandidates()).toEqual([]);
  });

  it("propagates enumeration failures", async () => {
    hid.enumerate.mockRejectedValue(new Error("enumeration failed"));
    await expect(findCandidates()).rejects.toThrow("enumeration failed");
  });
});

describe.each([PRODUCT_ID, CREATOR_PRODUCT_ID])(
  "shared transport for PID %i",
  (productId) => {
    it("opens the vendor interface, dispatches both envelopes and sends lighting", async () => {
      const handle = Object.assign(new EventEmitter(), {
        write: vi.fn().mockResolvedValue(64),
        close: vi.fn().mockResolvedValue(undefined),
      });
      hid.enumerate.mockResolvedValue([candidate({ productId })]);
      hid.open.mockResolvedValue(handle);
      const handlers = {
        onConnect: vi.fn(),
        onDisconnect: vi.fn(),
        onStateChange: vi.fn(),
        onHid: vi.fn(),
        onJoystick: vi.fn(),
      };
      const device = new CodexMicro(handlers, vi.fn());
      try {
        device.start();
        await vi.waitFor(() => expect(device.connected).toBe(true));
        expect(hid.open).toHaveBeenCalledWith("codex", { nonExclusive: true });
        expect(handlers.onConnect).toHaveBeenCalledOnce();
        for (const message of [
          { m: "v.oai.hid", p: { k: "ACT06", act: 1 } },
          { method: "v.oai.rad", params: { a: 90, d: 1 } },
        ]) {
          for (const report of encodeMessage(JSON.stringify(message) + "\n")) {
            handle.emit("data", report);
          }
        }
        expect(handlers.onHid).toHaveBeenCalledWith("ACT06", 1);
        expect(handlers.onJoystick).toHaveBeenCalledWith(90, 1);
        // USB reports captured from Creator Micro 2 on layer 1. Its compact
        // envelopes end in CRLF; JSON parsing must tolerate the trailing CR.
        for (const hex of [
          "06022c7b226d223a22762e6f61692e686964222c2270223a7b226b223a2241473030222c22616374223a317d7d0d0a0000000000000000000000000000000000",
          "06022e7b226d223a22762e6f61692e686964222c2270223a7b226b223a22454e435f4357222c22616374223a327d7d0d0a000000000000000000000000000000",
          "06022c7b226d223a22762e6f61692e726164222c2270223a7b2261223a302e3439343934382c2264223a317d7d0d0a0000000000000000000000000000000000",
        ]) {
          handle.emit("data", Buffer.from(hex, "hex"));
        }
        expect(handlers.onHid).toHaveBeenCalledWith("AG00", 1);
        expect(handlers.onHid).toHaveBeenCalledWith("ENC_CW", 2);
        expect(handlers.onJoystick).toHaveBeenCalledWith(0.494948, 1);
        const slots = [{ id: 0, c: 0x00ff00, b: 50, e: 1, s: 0 }];
        await device.setThreadLighting(slots);
        expect(handle.write.mock.calls.map(([report]) => report)).toEqual(
          encodeMessage(
            JSON.stringify({ method: "v.oai.thstatus", params: slots }),
          ),
        );
        handle.write.mockClear();
        const ambient = { e: 1, b: 20, s: 0, m: 0, c: 0x0000ff };
        await device.setAmbientLighting(ambient);
        expect(handle.write.mock.calls.map(([report]) => report)).toEqual(
          encodeMessage(
            JSON.stringify({
              method: "v.oai.rgbcfg",
              params: { ambient, keys: { e: 0, b: 0, s: 0, m: 0, c: 0 } },
            }),
          ),
        );
      } finally {
        await device.stop();
      }
      expect(handlers.onDisconnect).toHaveBeenCalledOnce();
      expect(handle.close).toHaveBeenCalledOnce();
      expect(device.state).toBe("stopped");
    });
  },
);
