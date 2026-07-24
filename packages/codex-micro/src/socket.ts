// Newline-delimited JSON over a unix socket: the shared framing for both the
// Herdr API and this plugin's own control protocol. Every exchange is bounded
// by a deadline, because a peer that accepts a connection and then neither
// answers nor closes would otherwise leave a promise pending forever.
import net from "node:net";

export const CONNECT_TIMEOUT_MS = 5000;
export const REQUEST_TIMEOUT_MS = 10_000;

// Decoding must be stateful: a multi-byte character split across two `data`
// events decodes to replacement characters if each chunk is converted alone.
// setEncoding runs the chunks through one StringDecoder, so the split heals.
export function readLines(
  socket: net.Socket,
  onLine: (line: string) => void,
): void {
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      onLine(line);
    }
  });
}

export function connect(
  path: string,
  timeoutMs = CONNECT_TIMEOUT_MS,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`connect to ${path} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

// One request, one response line, then the socket is done. Both protocols
// answer a request on its own connection, so settling always destroys it.
export function requestLine(
  socket: net.Socket,
  request: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      finish();
    };
    const timer = setTimeout(
      () =>
        settle(() =>
          reject(new Error(`request timed out after ${timeoutMs}ms`)),
        ),
      timeoutMs,
    );
    readLines(socket, (line) => settle(() => resolve(line)));
    socket.on("close", () =>
      settle(() => reject(new Error("socket closed before a response"))),
    );
    socket.on("error", (error: Error) => settle(() => reject(error)));
    socket.write(request + "\n");
  });
}
