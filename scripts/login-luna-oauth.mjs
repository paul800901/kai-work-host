import { spawn } from "node:child_process";
import { applyDeploymentConfig } from "./load-deployment-config.mjs";
import { loadConfig } from "../dist/config.js";
import { CodexAppServer, CodexRuntimeManager } from "../dist/codex-runtime.js";

applyDeploymentConfig();
const config = loadConfig();
const statusOnly = process.argv.includes("--status");
const force = process.argv.includes("--force");
const device = process.argv.includes("--device-code");
const manager = new CodexRuntimeManager(config);
await manager.prepare();
let loginId = null;
let finish;
const completed = new Promise((resolve) => { finish = resolve; });
const server = new CodexAppServer(config, config.stateRoot, async (message) => {
  if (message.method === "account/login/completed" && message.params?.loginId === loginId) finish(message.params);
  if (message.id !== undefined && message.method) server.rejectRequest(message.id);
}, (error) => finish({ success: false, error: error.message }));
let timer;
try {
  await server.start();
  const status = await server.request("account/read", { refreshToken: false });
  const configured = status.account?.type === "chatgpt";
  if (statusOnly || (configured && !force)) {
    console.log(JSON.stringify({ configured, authMode: status.account?.type ?? null, codexHome: config.codexHome, paidModelInvoked: false }));
  } else {
    const login = await server.request("account/login/start", { type: device ? "chatgptDeviceCode" : "chatgpt" });
    loginId = login.loginId;
    // The login link/code is intentionally shown to the operator; no grant or token is ever printed.
    console.log(JSON.stringify({ loginRequired: true, authUrl: login.authUrl ?? login.verificationUri,
      userCode: login.userCode ?? null, codexHome: config.codexHome }));
    if (!device && process.env.KAI_WORK_HOST_OPEN_BROWSER !== "0" && login.authUrl) {
      const url = new URL(login.authUrl);
      if (url.protocol !== "https:" || !["auth.openai.com", "chatgpt.com"].includes(url.hostname)) throw new Error("Unexpected official login URL");
      const child = process.platform === "win32"
        ? spawn("rundll32.exe", ["url.dll,FileProtocolHandler", login.authUrl], { windowsHide: true, detached: true, stdio: "ignore" })
        : spawn(process.platform === "darwin" ? "open" : "xdg-open", [login.authUrl], { detached: true, stdio: "ignore" });
      child.on("error", () => undefined);
      child.unref();
    }
    timer = setTimeout(() => finish({ success: false, error: "ChatGPT sign-in timed out" }), 300_000);
    const result = await completed;
    if (!result.success) throw new Error(result.error ?? "ChatGPT sign-in did not complete");
    const verified = await server.request("account/read", { refreshToken: false });
    if (verified.account?.type !== "chatgpt") throw new Error("Expected a Codex-managed ChatGPT login");
    console.log(JSON.stringify({ configured: true, authMode: "chatgpt", codexHome: config.codexHome, paidModelInvoked: false }));
  }
} finally {
  clearTimeout(timer);
  await server.shutdown();
  await manager.shutdown();
}
