// Keyless protocol fixture. Never calls a provider; actual Codex is tested separately.
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
if (process.argv.includes("--version")) { process.stdout.write("codex-cli 0.153.3\n"); process.exit(0); }
const stateFile = path.join(process.cwd(), "fixture-codex-thread.json");
let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { id: "thread-fixture", turns: 0, tokens: 0 };
let activeTurn = null;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const event = (method, params) => send({ method, params: { threadId: state.id, ...params } });
const usage = () => ({ inputTokens: state.tokens, cachedInputTokens: state.tokens / 2, outputTokens: state.turns * 10, totalTokens: state.tokens + state.turns * 10 });
const usageEvent = () => event("thread/tokenUsage/updated", { turnId: activeTurn, tokenUsage: { total: usage(), last: usage(), modelContextWindow: 272000 } });
const complete = (status, error = null) => event("turn/completed", { turn: { id: activeTurn, status, error } });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (!request.method) {
    if (request.id === "approval") {
      fs.writeFileSync(path.join(process.cwd(), "approval-result.json"), JSON.stringify(request));
      complete("interrupted");
    }
    return;
  }
  fs.appendFileSync(path.join(process.cwd(), "fixture-wire.jsonl"), JSON.stringify(request) + "\n");
  const reply = (result) => send({ id: request.id, result });
  const params = request.params ?? {};
  if (request.method === "initialize") return reply({ userAgent: "fixture/0.153.3" });
  if (request.method === "initialized") return;
  if (request.method === "account/read") return reply({ account: { type: path.basename(process.cwd()) === "apikey" ? "apiKey" : "chatgpt" } });
  if (request.method === "model/list") return reply({ data: [{ model: "gpt-5.6-luna", supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "medium" }] }] });
  if (request.method === "thread/start" || request.method === "thread/resume") {
    if (request.method === "thread/resume") {
      if (!fs.existsSync(stateFile) || params.threadId !== state.id) return send({ id: request.id, error: { message: "no rollout found" } });
      usageEvent();
    }
    const sandbox = params.sandbox === "workspace-write"
      ? { type: "workspaceWrite", writableRoots: [params.cwd], networkAccess: params.config["sandbox_workspace_write.network_access"] }
      : params.sandbox === "danger-full-access" ? { type: "dangerFullAccess" }
        : { type: "readOnly", networkAccess: params.config["sandbox_read_only.network_access"] ?? false };
    return reply({ thread: { id: state.id }, model: params.model, modelProvider: "openai", cwd: params.cwd,
      approvalPolicy: "never", sandbox, reasoningEffort: params.config.model_reasoning_effort });
  }
  if (request.method === "turn/start") {
    state.turns += 1; activeTurn = `turn-${state.turns}`;
    const prompt = params.input[0].text;
    fs.writeFileSync(stateFile, JSON.stringify(state));
    if (prompt.includes("[lost-ack]")) return process.exit(9);
    event("turn/started", { turn: { id: activeTurn } });
    reply({ turn: { id: activeTurn } });
    if (prompt.includes("[hold]")) return;
    if (prompt.includes("[approval]")) return send({ id: "approval", method: "item/commandExecution/requestApproval", params: { threadId: state.id, turnId: activeTurn, command: "outside-scope" } });
    if (prompt.includes("[reroute]")) return event("model/rerouted", { turnId: activeTurn, fromModel: "gpt-5.6-luna", toModel: "gpt-5.6-sol" });
    event("item/started", { turnId: activeTurn, item: { id: "cmd", type: "commandExecution", command: "fixture" } });
    event("item/completed", { turnId: activeTurn, item: { id: "cmd", type: "commandExecution", command: "fixture", exitCode: 0 } });
    event("turn/diff/updated", { turnId: activeTurn, diff: "old diff" });
    event("turn/diff/updated", { turnId: activeTurn, diff: "final aggregate diff" });
    state.tokens += 100; fs.writeFileSync(stateFile, JSON.stringify(state));
    usageEvent(); usageEvent(); // Repeated cumulative snapshot must not double count.
    event("item/completed", { turnId: activeTurn, item: { type: "agentMessage", id: "answer", text: "fixture completed", phase: "final_answer" } });
    return complete(prompt.includes("[fail]") ? "failed" : "completed", prompt.includes("[fail]") ? { message: "fixture failure" } : null);
  }
  if (request.method === "turn/interrupt") { reply({}); return complete("interrupted"); }
  send({ id: request.id, error: { message: `Unsupported fixture request: ${request.method}` } });
});
