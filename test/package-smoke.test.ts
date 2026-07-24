import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { readJsonLines, encodeJsonLine } from "../src/jsonl.ts";
import { getSupervisorPaths } from "../src/paths.ts";
import { SupervisorClient } from "../src/supervisor-client.ts";

const execFileAsync = promisify(execFile);
const pi = resolve("node_modules/.bin/pi");
const packageRoot = resolve(".");

test("Pi package install smoke keeps regular mode inert and enables agent mode only when requested", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-view-package-"));
  const agentDir = join(root, "agent");
  const stateDir = join(root, "supervisor");
  const env = credentialFreeEnvironment({
    HOME: root,
    PI_CODING_AGENT_DIR: agentDir,
    PI_AGENT_VIEW_STATE_DIR: stateDir,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
  });

  await execFileAsync(pi, ["install", packageRoot], { cwd: root, env, timeout: 10_000 });
  const settings = await readFile(join(agentDir, "settings.json"), "utf8");
  assert.match(settings, /pi-agent-view/);

  const regular = await runRpcPi(env, []);
  assert.deepEqual(regular.commands.filter((command) => command.name === "agent-mode" || command.name === "threads").map((command) => command.name).sort(), ["agent-mode", "threads"]);
  await assert.rejects(access(stateDir), "installing and starting regular Pi must not start the supervisor");

  const optedIn = await runRpcPi(env, ["--agent-mode"], 750);
  assert.deepEqual(optedIn.commands.filter((command) => command.name === "agent-mode" || command.name === "threads").map((command) => command.name).sort(), ["agent-mode", "threads"]);
  const paths = getSupervisorPaths(stateDir);
  await waitFor(() => access(paths.socketPath), 5_000);
  const client = new SupervisorClient({ paths, autoStart: false, connectTimeoutMs: 2_000 });
  t.after(() => client.disconnect());
  await client.connect();
  await client.shutdownSupervisor();
});

async function runRpcPi(env: NodeJS.ProcessEnv, extraArgs: string[], lingerMs = 0): Promise<{ commands: Array<{ name: string }> }> {
  const child = spawn(pi, ["--mode", "rpc", "--no-session", "--offline", "--no-context-files", ...extraArgs], {
    cwd: dirnameSafe(env.HOME), env, stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const response = new Promise<{ commands: Array<{ name: string }> }>((resolveResponse, reject) => {
      const errors: string[] = [];
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => errors.push(chunk));
      readJsonLines(child.stdout, (value) => {
        if (!isObject(value) || value.type !== "response" || value.id !== "commands") return;
        if (value.success !== true || !isObject(value.data) || !Array.isArray(value.data.commands)) {
          reject(new Error(`get_commands failed: ${JSON.stringify(value)}`));
          return;
        }
        resolveResponse(value.data as { commands: Array<{ name: string }> });
      }, reject);
      child.once("exit", (code) => reject(new Error(`Pi RPC exited before smoke response (${code}): ${errors.join("")}`)));
    });
    child.stdin.write(encodeJsonLine({ id: "commands", type: "get_commands" }));
    const result = await withTimeout(response, 8_000, "Timed out waiting for Pi package smoke response");
    if (lingerMs) await delay(lingerMs);
    return result;
  } finally {
    await stopChild(child);
  }
}

function credentialFreeEnvironment(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env, ...overrides };
  for (const key of Object.keys(env)) if (key.endsWith("_API_KEY") || key.endsWith("_OAUTH_TOKEN")) delete env[key];
  return env;
}

function dirnameSafe(home: string | undefined): string {
  return home ?? tmpdir();
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  child.kill("SIGTERM");
  await Promise.race([exited, delay(2_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function waitFor(operation: () => Promise<unknown>, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try { await operation(); return; } catch (cause) { lastError = cause; }
    await delay(30);
  }
  throw lastError instanceof Error ? lastError : new Error("Timed out");
}

async function withTimeout<T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
