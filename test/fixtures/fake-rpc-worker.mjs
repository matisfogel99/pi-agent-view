#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const existingSession = valueAfter("--session");
const sessionDir = valueAfter("--session-dir") ?? process.cwd();
const name = valueAfter("--name") ?? "fake";
mkdirSync(sessionDir, { recursive: true });
const sessionFile = existingSession ?? join(sessionDir, "fake-session.jsonl");
if (!existingSession) writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: `fake-${process.pid}`, cwd: process.cwd(), name })}\n`, { mode: 0o600 });

let buffer = "";
let entrySequence = 0;
let pendingUi;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line));
  }
});

function handle(command) {
  if (command.type === "get_state") {
    send({ id: command.id, type: "response", command: "get_state", success: true, data: { sessionFile, sessionId: `fake-${process.pid}`, sessionName: name, isStreaming: false } });
    return;
  }
  if (command.type === "prompt") {
    respond(command);
    appendMessage("user", command.message);
    runPrompt(command.message);
    return;
  }
  if (command.type === "steer" || command.type === "follow_up") {
    respond(command);
    appendMessage("user", command.message);
    send({ type: "queue_update", steering: command.type === "steer" ? [command.message] : [], followUp: command.type === "follow_up" ? [command.message] : [] });
    return;
  }
  if (command.type === "abort") {
    respond(command);
    send({ type: "message_update", assistantMessageEvent: { type: "error", reason: "aborted" } });
    send({ type: "agent_settled" });
    return;
  }
  if (command.type === "extension_ui_response" && pendingUi === command.id) {
    pendingUi = undefined;
    const answer = command.value ?? (command.confirmed ? "Yes" : "No");
    appendMessage("user", String(answer));
    appendMessage("assistant", `continued with ${answer}`);
    send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `continued with ${answer}` }], stopReason: "stop" } });
    send({ type: "agent_settled" });
  }
}

function runPrompt(message) {
  queueMicrotask(() => {
    send({ type: "agent_start" });
    send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "working on deterministic output" } });
    if (message === "wait" || message === "choose") {
      pendingUi = "ui-1";
      send(message === "choose"
        ? { type: "extension_ui_request", id: pendingUi, method: "select", title: "Pick one", options: ["alpha", "beta"] }
        : { type: "extension_ui_request", id: pendingUi, method: "confirm", title: "Continue?", message: "Waiting" });
    } else if (message === "fail") {
      send({ type: "message_end", message: { role: "assistant", stopReason: "error" } });
      send({ type: "agent_settled" });
    } else if (message === "crash") {
      process.exit(17);
    } else {
      setTimeout(() => {
        appendMessage("assistant", "deterministic result");
        send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "deterministic result" }], stopReason: "stop" } });
        send({ type: "agent_settled" });
      }, 120);
    }
  });
}

function appendMessage(role, content) {
  appendFileSync(sessionFile, `${JSON.stringify({ type: "message", id: `entry-${process.pid}-${++entrySequence}`, parentId: null, timestamp: new Date().toISOString(), message: { role, content } })}\n`);
}

function respond(command) {
  send({ id: command.id, type: "response", command: command.type, success: true });
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}
