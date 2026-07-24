// Connection to the physical Codex Micro: discovery, fire-and-forget vendor
// RPC, notifications, and reconnect. The ChatGPT app seizes the device
// exclusively while running, so open failures are expected and retried;
// quitting it hands the device over on the next retry.
import { HIDAsync, devicesAsync, type Device } from "node-hid";
import { CHANNEL_RPC, Reassembler, encodeMessage } from "./framing.js";

export const VENDOR_ID = 0x303a;
export const PRODUCT_ID = 0x8360;
export const USAGE_PAGE = 0xff00;
const RECONNECT_MIN_MS = 3000;
const RECONNECT_JITTER_MS = 5000;

export interface ThreadLighting {
  id: number;
  c: number;
  b: number;
  e: number;
  s: number;
}

export interface LightingSide {
  e: number;
  b: number;
  s: number;
  /** The vendor schema's "magic" parameter; the firmware expects it present. */
  m: number;
  c: number;
}

export type DeviceState =
  | "connected"
  | "connecting"
  | "device_absent"
  | "permission_required"
  | "device_busy"
  | "stopped";

export interface DeviceHandlers {
  onConnect(): void;
  onDisconnect(): void;
  onStateChange(): void;
  onHid(key: string, act: number): void;
  onJoystick(angle: number, distance: number): void;
}

// Maps IOKit open failures to actionable states: 0xE00002C1 (privilege
// violation) is a missing Input Monitoring grant; 0xE00002C5 (exclusive
// access) means another host, in practice the ChatGPT app, holds the device.
export function classifyOpenError(message: string): DeviceState {
  if (message.includes("privilege violation") || message.includes("E00002C1")) {
    return "permission_required";
  }
  if (message.includes("exclusive access") || message.includes("E00002C5")) {
    return "device_busy";
  }
  if (message.includes("device not found")) return "device_absent";
  return "connecting";
}

export async function findCandidates(): Promise<Device[]> {
  const devices = await devicesAsync();
  return devices.filter(
    (d) =>
      d.vendorId === VENDOR_ID &&
      d.productId === PRODUCT_ID &&
      d.usagePage === USAGE_PAGE &&
      d.path,
  );
}

export class CodexMicro {
  private device: HIDAsync | null = null;
  private reassembler = new Reassembler();
  private generation = 0;
  private stopped = false;
  private connecting = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private currentState: DeviceState = "stopped";
  private lastOpenFailure = "";

  constructor(
    private handlers: DeviceHandlers,
    private log: (message: string) => void,
  ) {}

  get connected(): boolean {
    return this.device !== null;
  }

  get state(): DeviceState {
    return this.currentState;
  }

  private setState(state: DeviceState): void {
    if (state === this.currentState) return;
    this.currentState = state;
    this.handlers.onStateChange();
  }

  // Idempotent: calling it while connected or already connecting is a no-op,
  // so it never flaps the state or starts a second retry chain.
  start(): void {
    if (!this.stopped && (this.device || this.connecting)) return;
    this.stopped = false;
    this.clearRetry();
    this.setState("connecting");
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation++;
    this.clearRetry();
    await this.disconnect();
    this.setState("stopped");
  }

  // Fire-and-forget (the firmware does not reply), serialized through a write
  // queue so concurrent callers cannot interleave multi-report frames.
  setThreadLighting(slots: ThreadLighting[]): Promise<void> {
    return this.send("v.oai.thstatus", slots);
  }

  // Ambient ring; the keys side stays off (thread lighting renders the keys).
  setAmbientLighting(ambient: LightingSide): Promise<void> {
    return this.send("v.oai.rgbcfg", {
      ambient,
      keys: { e: 0, b: 0, s: 0, m: 0, c: 0 },
    });
  }

  private send(method: string, params: unknown): Promise<void> {
    // Bind to the handle that was live when the write was queued: the queue
    // can advance across a reconnect, and a frame composed for the old
    // connection must not be delivered on the new one.
    const target = this.device;
    const generation = this.generation;
    const result = this.writeQueue.then(async () => {
      if (!target || this.device !== target || this.generation !== generation) {
        throw new Error("device not connected");
      }
      const message = JSON.stringify({ method, params });
      for (const report of encodeMessage(message)) {
        await target.write(report);
      }
    });
    this.writeQueue = result.catch(() => {});
    return result;
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.device || this.connecting) return;
    this.connecting = true;
    const generation = ++this.generation;
    try {
      const candidates = await findCandidates();
      if (candidates.length === 0) throw new Error("device not found");
      let opened: HIDAsync | null = null;
      let lastError: Error | null = null;
      for (const info of candidates) {
        try {
          opened = await HIDAsync.open(info.path!, { nonExclusive: true });
          break;
        } catch (error) {
          lastError = error as Error;
        }
      }
      if (!opened) throw lastError ?? new Error("no candidate opened");
      if (this.stopped || this.generation !== generation) {
        await opened.close().catch(() => {});
        return;
      }
      opened.on("data", (data: Buffer) => this.onData(data));
      opened.on("error", (error: Error) => {
        this.log(`device error: ${error.message}`);
        void this.dropAndRetry();
      });
      this.device = opened;
      this.lastOpenFailure = "";
      this.setState("connected");
      this.log("device connected");
      this.handlers.onConnect();
    } catch (error) {
      // A failure from a superseded attempt must not overwrite the live
      // state or queue a retry the current attempt did not ask for.
      if (this.stopped || this.generation !== generation) return;
      const message = (error as Error).message;
      // The absent-device retry runs forever; logging every attempt would
      // grow the log without bound for an unplugged keypad.
      if (message !== this.lastOpenFailure) {
        this.lastOpenFailure = message;
        this.log(`device open failed: ${message}`);
      }
      this.setState(classifyOpenError(message));
      this.scheduleRetry();
    } finally {
      this.connecting = false;
    }
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    const delay = RECONNECT_MIN_MS + Math.random() * RECONNECT_JITTER_MS;
    this.retryTimer = setTimeout(() => void this.connect(), delay);
  }

  private async dropAndRetry(): Promise<void> {
    await this.disconnect();
    if (this.stopped) return;
    this.setState("connecting");
    this.scheduleRetry();
  }

  // Fires onDisconnect exactly once per live handle that goes away, so the
  // "no synthetic key stays held" invariant has a single owner here rather
  // than one call per teardown path.
  private async disconnect(): Promise<void> {
    const device = this.device;
    this.device = null;
    this.reassembler.reset();
    if (!device) return;
    device.removeAllListeners("data");
    device.removeAllListeners("error");
    await device.close().catch(() => {});
    this.handlers.onDisconnect();
  }

  private onData(data: Buffer): void {
    for (const { channel, message } of this.reassembler.push(data)) {
      if (channel !== CHANNEL_RPC) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(message) as Record<string, unknown>;
      } catch {
        continue;
      }
      // The firmware speaks both envelope forms - compact {m,p} for
      // notifications, long {method,params} for responses. Only notifications
      // reach this daemon today, but both are real wire formats, so the
      // long-form fallback stays for whenever request/response returns.
      const method = (parsed.method ?? parsed.m) as string | undefined;
      const params = (parsed.params ?? parsed.p) as
        Record<string, unknown> | undefined;
      if (method === "v.oai.hid" && params) {
        this.handlers.onHid(String(params.k ?? ""), Number(params.act ?? 0));
      } else if (method === "v.oai.rad" && params) {
        this.handlers.onJoystick(Number(params.a ?? 0), Number(params.d ?? 0));
      }
    }
  }
}
