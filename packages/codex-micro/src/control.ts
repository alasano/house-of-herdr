// Local control protocol between the daemon and its helpers (popup, ctl):
// newline JSON over a unix socket in the state dir. Commands: status, watch,
// toggle-policy, stop. The socket doubles as the single-instance lock.
import fs from "node:fs";
import net from "node:net";
import { CONTROL_SOCKET } from "./config.js";
import { connect, readLines, requestLine } from "./socket.js";
import type { DeviceState } from "./device.js";
import type { AgentStatus, Policy } from "./slots.js";

const WATCH_RECONNECT_MS = 1000;

/** Device ownership; 'yielded' overrides while the ChatGPT app runs. */
export type ControlState = DeviceState | "yielded";

export interface SlotStatus {
  key: number;
  paneId: string;
  agent: string;
  paneName: string | null;
  workspace: string;
  tab: string;
  cwd: string;
  status: AgentStatus;
}

export interface StatusPayload {
  policy: Policy;
  dialMode: "workspaces" | "agents";
  state: ControlState;
  herdrConnected: boolean;
  configError: string | null;
  slots: (SlotStatus | null)[];
}

export interface ControlHandlers {
  status(): StatusPayload;
  togglePolicy(): Policy;
  popup(): void;
  stop(): void;
  /** Fires when the first watcher arrives, so the daemon can enrich status. */
  watchersChanged(): void;
}

// Socket identity, so we only ever unlink a socket file we still own. Another
// daemon can win the bind race and replace the path between our checks.
function socketIdentity(path: string): string | null {
  const stat = fs.statSync(path, { throwIfNoEntry: false });
  return stat ? `${stat.dev}:${stat.ino}` : null;
}

export class ControlServer {
  private server: net.Server | null = null;
  private watchers = new Set<net.Socket>();
  private ownedIdentity: string | null = null;

  constructor(private handlers: ControlHandlers) {}

  get hasWatchers(): boolean {
    return this.watchers.size > 0;
  }

  // Bind-first locking: EADDRINUSE means either a live daemon (give up) or a
  // stale socket file (remove and rebind). Never unlink before probing, and
  // never unlink a socket that changed identity while we probed: two daemons
  // racing here would otherwise both conclude "stale" and both bind, leaving
  // one of them listening on a path that no longer routes to it.
  async listen(): Promise<void> {
    this.createServer();
    try {
      await this.bind();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      const before = socketIdentity(CONTROL_SOCKET);
      if (await daemonAlive()) {
        throw new Error("another daemon instance is running");
      }
      if (before === null || socketIdentity(CONTROL_SOCKET) !== before) {
        throw new Error("another daemon instance claimed the control socket");
      }
      fs.rmSync(CONTROL_SOCKET, { force: true });
      this.createServer();
      await this.bind();
    }
    this.ownedIdentity = socketIdentity(CONTROL_SOCKET);
  }

  private bind(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = this.server!;
      // Both listeners are one-shot and must be torn down together: leaving
      // the error listener attached would let it swallow the first real
      // server error after a successful bind.
      const onError = (error: Error) => {
        server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(CONTROL_SOCKET);
    });
  }

  private createServer(): void {
    this.server = net.createServer((socket) => {
      readLines(socket, (line) => this.handle(socket, line));
      socket.on("close", () => this.watchers.delete(socket));
      socket.on("error", () => this.watchers.delete(socket));
    });
  }

  broadcast(): void {
    if (this.watchers.size === 0) return;
    const line = JSON.stringify(this.handlers.status()) + "\n";
    for (const watcher of this.watchers) watcher.write(line);
  }

  close(): void {
    this.server?.close();
    // Only remove the path if it still refers to the socket we bound.
    if (
      this.ownedIdentity !== null &&
      socketIdentity(CONTROL_SOCKET) === this.ownedIdentity
    ) {
      fs.rmSync(CONTROL_SOCKET, { force: true });
    }
    this.ownedIdentity = null;
  }

  private handle(socket: net.Socket, line: string): void {
    let cmd: string;
    try {
      cmd = String((JSON.parse(line) as { cmd?: string }).cmd ?? "");
    } catch {
      socket.write(JSON.stringify({ error: "invalid_request" }) + "\n");
      return;
    }
    try {
      if (cmd === "status") {
        socket.write(JSON.stringify(this.handlers.status()) + "\n");
      } else if (cmd === "watch") {
        const first = this.watchers.size === 0;
        this.watchers.add(socket);
        socket.write(JSON.stringify(this.handlers.status()) + "\n");
        if (first) this.handlers.watchersChanged();
      } else if (cmd === "toggle-policy") {
        const policy = this.handlers.togglePolicy();
        socket.write(JSON.stringify({ policy }) + "\n");
      } else if (cmd === "popup") {
        this.handlers.popup();
        socket.write(JSON.stringify({ ok: true }) + "\n");
      } else if (cmd === "stop") {
        // end() flushes the reply before shutdown races process exit.
        socket.end(JSON.stringify({ stopping: true }) + "\n");
        this.handlers.stop();
      } else {
        // Always answer: an unanswered command would strand the caller until
        // its request deadline.
        socket.write(
          JSON.stringify({ error: `unknown command: ${cmd}` }) + "\n",
        );
      }
    } catch (error) {
      socket.write(JSON.stringify({ error: (error as Error).message }) + "\n");
    }
  }
}

export async function sendCommand(
  cmd: string,
): Promise<Record<string, unknown>> {
  const socket = await connect(CONTROL_SOCKET);
  const line = await requestLine(socket, JSON.stringify({ cmd }));
  return JSON.parse(line) as Record<string, unknown>;
}

// Follows daemon status, reconnecting across daemon restarts: a restart is a
// gap to render, not a reason to tear the viewer down. onDisconnect fires on
// each drop, before the next reconnect attempt.
export function watchStatus(
  onStatus: (status: StatusPayload) => void,
  onDisconnect: () => void,
): { stop: () => void } {
  let socket: net.Socket | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let stopped = false;

  const open = () => {
    if (stopped) return;
    const next = net.createConnection(CONTROL_SOCKET);
    socket = next;
    readLines(next, (line) => {
      try {
        onStatus(JSON.parse(line) as StatusPayload);
      } catch {
        // ignore malformed lines
      }
    });
    next.on("close", () => {
      if (stopped || socket !== next) return;
      onDisconnect();
      retryTimer = setTimeout(open, WATCH_RECONNECT_MS);
    });
    next.on("error", () => {});
    next.write(JSON.stringify({ cmd: "watch" }) + "\n");
  };

  open();
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.destroy();
    },
  };
}

export async function daemonAlive(): Promise<boolean> {
  try {
    await sendCommand("status");
    return true;
  } catch {
    return false;
  }
}
