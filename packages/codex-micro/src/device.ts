// Connection to the physical Codex Micro: discovery, fire-and-forget vendor
// RPC, notifications, and reconnect. The ChatGPT app seizes the device
// exclusively while running, so open failures are expected and retried;
// quitting it hands the device over on the next retry.
import { HIDAsync, devicesAsync } from "node-hid";
import { CHANNEL_RPC, Reassembler, encodeMessage } from "./framing.js";

const VENDOR_ID = 0x303a;
const PRODUCT_ID = 0x8360;
const USAGE_PAGE = 0xff00;
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
function classifyOpenError(message: string): DeviceState {
  if (message.includes("privilege violation") || message.includes("E00002C1")) {
    return "permission_required";
  }
  if (message.includes("exclusive access") || message.includes("E00002C5")) {
    return "device_busy";
  }
  if (message.includes("device not found")) return "device_absent";
  return "connecting";
}

export class CodexMicro {
  private device: HIDAsync | null = null;
  private reassembler = new Reassembler();
  private generation = 0;
  private stopped = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private currentState: DeviceState = "stopped";

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

  start(): void {
    this.stopped = false;
    this.setState("connecting");
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
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
    const result = this.writeQueue.then(async () => {
      const device = this.device;
      if (!device) throw new Error("device not connected");
      const message = JSON.stringify({ method, params });
      for (const report of encodeMessage(message)) {
        await device.write(report);
      }
    });
    this.writeQueue = result.catch(() => {});
    return result;
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.device) return;
    const generation = ++this.generation;
    try {
      const devices = await devicesAsync();
      const candidates = devices.filter(
        (d) =>
          d.vendorId === VENDOR_ID &&
          d.productId === PRODUCT_ID &&
          d.usagePage === USAGE_PAGE &&
          d.path,
      );
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
      this.setState("connected");
      this.log("device connected");
      this.handlers.onConnect();
    } catch (error) {
      const message = (error as Error).message;
      this.log(`device open failed: ${message}`);
      this.setState(classifyOpenError(message));
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    const delay = RECONNECT_MIN_MS + Math.random() * RECONNECT_JITTER_MS;
    this.retryTimer = setTimeout(() => void this.connect(), delay);
  }

  private async dropAndRetry(): Promise<void> {
    await this.disconnect();
    this.setState("connecting");
    this.handlers.onDisconnect();
    this.scheduleRetry();
  }

  private async disconnect(): Promise<void> {
    const device = this.device;
    this.device = null;
    this.reassembler.reset();
    if (device) {
      device.removeAllListeners("data");
      device.removeAllListeners("error");
      await device.close().catch(() => {});
    }
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
      const method = (parsed.method ?? parsed.m) as string | undefined;
      const params = (parsed.params ?? parsed.p) as
        Record<string, unknown> | undefined;
      if (method === "v.oai.hid" && params) {
        this.handlers.onHid(
          String(params.k ?? params.key ?? ""),
          Number(params.act ?? 0),
        );
      } else if (method === "v.oai.rad" && params) {
        this.handlers.onJoystick(Number(params.a ?? 0), Number(params.d ?? 0));
      }
    }
  }
}
