// Minimal Herdr socket client: newline-delimited JSON over the local unix
// socket, with one connection per request and dedicated connections for event
// subscriptions.
import path from "node:path";
import os from "node:os";
import {
  REQUEST_TIMEOUT_MS,
  connect,
  readLines,
  requestLine,
} from "./socket.js";
import type { AgentStatus } from "./slots.js";

const SUBSCRIBE_ID = "sub";

// Herdr answers with a machine-readable code; callers branch on it (a clear
// against an already-closed pane is expected, not a failure), so the code has
// to survive as a field rather than only inside the message text.
export class HerdrError extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "HerdrError";
  }
}

function herdrError(body: unknown, fallback: string): HerdrError {
  const { code, message } = (body ?? {}) as { code?: string; message?: string };
  return new HerdrError(code ?? "error", message ?? fallback);
}

export interface AgentInfo {
  terminal_id: string;
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  agent?: string;
  name?: string;
  agent_status: AgentStatus;
  state_change_seq: number;
  focused: boolean;
}

export interface WorkspaceInfo {
  workspace_id: string;
  label: string;
  focused: boolean;
  active_tab_id: string;
}

export interface TabInfo {
  tab_id: string;
  label: string;
  focused: boolean;
}

export interface PaneInfo {
  pane_id: string;
  label?: string;
  cwd?: string;
  foreground_cwd?: string;
}

export type Subscription = { type: string } & Record<string, unknown>;

export interface HerdrEvent {
  event: string;
  data: Record<string, unknown>;
}

export function socketPath(): string {
  return (
    process.env.HERDR_SOCKET_PATH ??
    path.join(os.homedir(), ".config", "herdr", "herdr.sock")
  );
}

export class HerdrClient {
  private nextId = 1;

  // One connection per request: the Herdr server reads a single request per
  // connection and closes it after responding, so a persistent socket would
  // race those closures.
  async request(
    method: string,
    params: unknown = {},
  ): Promise<Record<string, unknown>> {
    const socket = await connect(socketPath());
    const id = `cm:${this.nextId++}`;
    const line = await requestLine(
      socket,
      JSON.stringify({ id, method, params }),
    );
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed.error) throw herdrError(parsed.error, method);
    return (parsed.result ?? {}) as Record<string, unknown>;
  }

  async agentList(): Promise<AgentInfo[]> {
    const result = await this.request("agent.list");
    return (result.agents ?? []) as AgentInfo[];
  }

  async workspaceList(): Promise<WorkspaceInfo[]> {
    const result = await this.request("workspace.list");
    return (result.workspaces ?? []) as WorkspaceInfo[];
  }

  async tabList(workspaceId: string): Promise<TabInfo[]> {
    const result = await this.request("tab.list", {
      workspace_id: workspaceId,
    });
    return (result.tabs ?? []) as TabInfo[];
  }

  async paneList(): Promise<PaneInfo[]> {
    const result = await this.request("pane.list");
    return (result.panes ?? []) as PaneInfo[];
  }
}

// Opens a dedicated connection, sends one events.subscribe request, and calls
// onEvent for every pushed envelope. Resolves with a close function once the
// subscription is acknowledged. onClose fires whenever the connection drops
// for any reason after acknowledgement.
//
// Rejects with a HerdrError when Herdr refuses the subscription and with a
// plain Error when the transport fails. Callers must tell these apart: Herdr
// probes every pane-scoped subscription at subscribe time and refuses the
// whole batch if one pane has closed, which says nothing about reachability.
export async function subscribe(
  subscriptions: Subscription[],
  onEvent: (event: HerdrEvent) => void,
  onClose: () => void,
): Promise<() => void> {
  const socket = await connect(socketPath());
  return new Promise((resolve, reject) => {
    let acknowledged = false;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(
      () =>
        fail(
          new Error(`subscription ack timed out after ${REQUEST_TIMEOUT_MS}ms`),
        ),
      REQUEST_TIMEOUT_MS,
    );
    readLines(socket, (line) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!acknowledged && parsed.id === SUBSCRIBE_ID) {
        if (parsed.error) {
          fail(herdrError(parsed.error, "events.subscribe"));
        } else {
          acknowledged = true;
          settled = true;
          clearTimeout(timer);
          resolve(() => socket.destroy());
        }
      } else if (typeof parsed.event === "string") {
        onEvent(parsed as unknown as HerdrEvent);
      }
    });
    socket.on("close", () => {
      if (acknowledged) onClose();
      else fail(new Error("herdr socket closed before subscription ack"));
    });
    socket.on("error", (error: Error) => fail(error));
    socket.write(
      JSON.stringify({
        id: SUBSCRIBE_ID,
        method: "events.subscribe",
        params: { subscriptions },
      }) + "\n",
    );
  });
}
