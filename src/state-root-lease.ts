import { createHash } from "node:crypto";
import { createServer, type Server } from "node:net";
import path from "node:path";

export interface StateRootLease {
  readonly stateRoot: string;
  close(): Promise<void>;
}

export async function acquireStateRootLease(stateRoot: string): Promise<StateRootLease> {
  const canonical = path.resolve(stateRoot);
  const identity = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const digest = createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 32);
  const endpoint: string | { host: string; port: number } = process.platform === "win32"
    ? `\\\\.\\pipe\\kai-work-host-state-${digest}`
    : process.platform === "linux"
      ? `\0kai-work-host-state-${digest}`
      : { host: "127.0.0.1", port: 42_000 + (Number.parseInt(digest.slice(0, 8), 16) % 20_000) };
  const server = createServer((socket) => socket.destroy());
  await listen(server, endpoint, canonical);
  return {
    stateRoot: canonical,
    close: () => close(server),
  };
}

async function listen(
  server: Server,
  endpoint: string | { host: string; port: number },
  stateRoot: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      if (error.code === "EADDRINUSE") {
        reject(new Error(`KAI Work Host state root is already owned by another local process: ${stateRoot}`));
        return;
      }
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    if (typeof endpoint === "string") server.listen(endpoint);
    else server.listen(endpoint);
  });
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}
