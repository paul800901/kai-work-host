import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";

import type { HostConfig } from "./types.js";
import type { TaskOrchestrator } from "./task-orchestrator.js";
import { createHostMcpHandler } from "./mcp-server.js";
import { HOST_NAME, HOST_VERSION } from "./version.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export class HostHttpServer {
  private readonly handler;
  private readonly mcpRuntime;
  private readonly nodeHandler;
  private server: Server | null = null;

  constructor(
    private readonly config: HostConfig,
    orchestrator: TaskOrchestrator,
  ) {
    const mcp = createHostMcpHandler(orchestrator, config);
    this.handler = mcp.handler;
    this.mcpRuntime = mcp.runtime;
    this.nodeHandler = toNodeHandler(this.handler);
  }

  async listen(): Promise<void> {
    if (this.server !== null) return;
    const validateHost = localhostHostValidation();
    const validateOrigin = localhostOriginValidation();
    const loopback = LOOPBACK_HOSTS.has(this.config.bindHost);
    this.server = createServer((request, response) => {
      const validatedRequest = request as IncomingMessage & { method: string; url: string };
      validatedRequest.method ??= "GET";
      validatedRequest.url ??= "/";
      if (loopback && (!validateHost(validatedRequest, response) || !validateOrigin(validatedRequest, response))) return;
      let url: URL;
      try {
        url = new URL(validatedRequest.url, "http://localhost");
      } catch {
        this.writeJson(response, 400, { ok: false, error: "invalid_url" });
        return;
      }
      if (url.pathname === "/healthz" && request.method === "GET") {
        this.writeJson(response, 200, { ok: true, service: HOST_NAME, version: HOST_VERSION });
        return;
      }
      if (url.pathname !== "/mcp") {
        this.writeJson(response, 404, { ok: false, error: "not_found" });
        return;
      }
      if (!this.authorized(request)) {
        response.setHeader("WWW-Authenticate", "Bearer");
        this.writeJson(response, 401, { ok: false, error: "unauthorized" });
        return;
      }
      void this.nodeHandler(validatedRequest, response);
    });
    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (server === null) return reject(new Error("HTTP server was not created"));
      server.once("error", reject);
      server.listen(this.config.port, this.config.bindHost, () => {
        server.off("error", reject);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server !== null) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
    }
    await this.handler.close();
    this.mcpRuntime.shutdown();
  }

  address(): { host: string; port: number } | null {
    const address = this.server?.address();
    if (address === undefined || address === null || typeof address === "string") return null;
    return { host: this.config.bindHost, port: address.port };
  }

  private authorized(request: IncomingMessage): boolean {
    const expected = this.config.bearerToken;
    if (expected === null) return true;
    const header = request.headers.authorization;
    if (header === undefined || !header.startsWith("Bearer ")) return false;
    const actual = header.slice("Bearer ".length);
    const expectedBytes = Buffer.from(expected, "utf8");
    const actualBytes = Buffer.from(actual, "utf8");
    return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
  }

  private writeJson(response: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
    response.statusCode = statusCode;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(`${JSON.stringify(body)}\n`);
  }
}
