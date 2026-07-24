// Local control protocol between the daemon and its helpers (popup, ctl):
// newline JSON over a unix socket in the state dir. Commands: status, watch,
// toggle-policy, stop. The socket doubles as the single-instance lock.
import fs from "node:fs";
import net from "node:net";
import { CONTROL_SOCKET } from "./config.js";
import type { AgentStatus, Policy } from "./slots.js";

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
  /** Device ownership state; 'yielded' overrides while the ChatGPT app runs. */
  state: string;
  herdrConnected: boolean;
  configError: string | null;
  slots: (SlotStatus | null)[];
}

export interface ControlHandlers {
  status(): StatusPayload;
  togglePolicy(): Policy;
  popup(): void;
  stop(): void;
}

export class ControlServer {
  private server: net.Server | null = null;
  private watchers = new Set<net.Socket>();

  constructor(private handlers: ControlHandlers) {}

  // Bind-first locking: EADDRINUSE means either a live daemon (give up) or a
  // stale socket file (remove and rebind). Never unlink before probing.
  async listen(): Promise<void> {
    this.createServer();
    try {
      await this.bind();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      if (await daemonAlive())
        throw new Error("another daemon instance is running");
      fs.rmSync(CONTROL_SOCKET, { force: true });
      this.createServer();
      await this.bind();
    }
  }

  private bind(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(CONTROL_SOCKET, resolve);
    });
  }

  private createServer(): void {
    this.server = net.createServer((socket) => {
      let buffer = "";
      socket.on("data", (data) => {
        buffer += data.toString("utf8");
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          this.handle(socket, line);
        }
      });
      socket.on("close", () => this.watchers.delete(socket));
      socket.on("error", () => this.watchers.delete(socket));
    });
  }

  broadcast(): void {
    const line = JSON.stringify(this.handlers.status()) + "\n";
    for (const watcher of this.watchers) watcher.write(line);
  }

  close(): void {
    this.server?.close();
    fs.rmSync(CONTROL_SOCKET, { force: true });
  }

  private handle(socket: net.Socket, line: string): void {
    let cmd: string;
    try {
      cmd = String((JSON.parse(line) as { cmd?: string }).cmd ?? "");
    } catch {
      return;
    }
    try {
      if (cmd === "status") {
        socket.write(JSON.stringify(this.handlers.status()) + "\n");
      } else if (cmd === "watch") {
        this.watchers.add(socket);
        socket.write(JSON.stringify(this.handlers.status()) + "\n");
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
      }
    } catch (error) {
      socket.write(JSON.stringify({ error: (error as Error).message }) + "\n");
    }
  }
}

export function sendCommand(cmd: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(CONTROL_SOCKET);
    let buffer = "";
    socket.once("error", reject);
    socket.on("data", (data) => {
      buffer += data.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      socket.destroy();
      try {
        resolve(
          JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>,
        );
      } catch (error) {
        reject(error as Error);
      }
    });
    socket.write(JSON.stringify({ cmd }) + "\n");
  });
}

export function watchStatus(
  onStatus: (status: StatusPayload) => void,
  onClose: () => void,
): net.Socket {
  const socket = net.createConnection(CONTROL_SOCKET);
  let buffer = "";
  socket.on("data", (data) => {
    buffer += data.toString("utf8");
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        onStatus(JSON.parse(line) as StatusPayload);
      } catch {
        // ignore malformed lines
      }
    }
  });
  socket.on("close", onClose);
  socket.on("error", () => {});
  socket.write(JSON.stringify({ cmd: "watch" }) + "\n");
  return socket;
}

export async function daemonAlive(): Promise<boolean> {
  try {
    await sendCommand("status");
    return true;
  } catch {
    return false;
  }
}
