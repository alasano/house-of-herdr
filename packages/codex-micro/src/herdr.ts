// Minimal Herdr socket client: newline-delimited JSON over the local unix
// socket, with one lazy connection for requests and dedicated connections for
// event subscriptions.
import net from "node:net";
import os from "node:os";
import path from "node:path";

export interface AgentInfo {
  terminal_id: string;
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  agent?: string;
  name?: string;
  display_agent?: string;
  agent_status: "idle" | "working" | "blocked" | "done" | "unknown";
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
  label?: string;
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

  // One connection per request: the Herdr server closes request connections
  // after responding, so a persistent socket would race those closures.
  async request(
    method: string,
    params: unknown = {},
  ): Promise<Record<string, unknown>> {
    const socket = await connect();
    const id = `cm:${this.nextId++}`;
    socket.write(JSON.stringify({ id, method, params }) + "\n");
    return new Promise((resolve, reject) => {
      let buffer = "";
      let settled = false;
      socket.on("data", (data) => {
        buffer += data.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline === -1 || settled) return;
        settled = true;
        socket.destroy();
        try {
          const parsed = JSON.parse(buffer.slice(0, newline)) as Record<
            string,
            unknown
          >;
          if (parsed.error) {
            const error = parsed.error as { code?: string; message?: string };
            reject(
              new Error(`${error.code ?? "error"}: ${error.message ?? method}`),
            );
          } else {
            resolve((parsed.result ?? {}) as Record<string, unknown>);
          }
        } catch (error) {
          reject(error as Error);
        }
      });
      socket.on("close", () => {
        if (!settled) {
          settled = true;
          reject(new Error("herdr socket closed"));
        }
      });
      socket.on("error", () => {});
    });
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
// subscription is acknowledged; rejects if the subscribe fails. onClose fires
// whenever the connection drops for any reason after acknowledgement.
export async function subscribe(
  subscriptions: Subscription[],
  onEvent: (event: HerdrEvent) => void,
  onClose: () => void,
): Promise<() => void> {
  const socket = await connect();
  let buffer = "";
  let acknowledged = false;
  let settled = false;
  return new Promise((resolve, reject) => {
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.on("data", (data) => {
      buffer += data.toString("utf8");
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (!acknowledged && parsed.id === "sub") {
          if (parsed.error) {
            fail(new Error(JSON.stringify(parsed.error)));
          } else {
            acknowledged = true;
            settled = true;
            resolve(() => socket.destroy());
          }
        } else if (typeof parsed.event === "string") {
          onEvent(parsed as unknown as HerdrEvent);
        }
      }
    });
    socket.on("close", () => {
      if (acknowledged) onClose();
      else fail(new Error("herdr socket closed before subscription ack"));
    });
    socket.on("error", (error) => fail(error as Error));
    socket.write(
      JSON.stringify({
        id: "sub",
        method: "events.subscribe",
        params: { subscriptions },
      }) + "\n",
    );
  });
}

function connect(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath());
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}
