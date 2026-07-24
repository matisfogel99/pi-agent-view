#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const existingSession = valueAfter("--session");
const sessionDir = valueAfter("--session-dir") ?? process.cwd();
const name = valueAfter("--name") ?? "fake";
mkdirSync(sessionDir, { recursive: true });
const sessionFile = existingSession ?? join(sessionDir, "fake-session.jsonl");
if (!existingSession) writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: `fake-${process.pid}`, cwd: process.cwd(), name })}\n`, { mode: 0o600 });

let buffer = "";
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
    send({ id: command.id, type: "response", command: "prompt", success: true });
    queueMicrotask(() => {
      send({ type: "agent_start" });
      send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "working on deterministic output" } });
      if (command.message === "wait") {
        send({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Continue?", message: "Waiting" });
      } else if (command.message === "fail") {
        send({ type: "message_end", message: { role: "assistant", stopReason: "error" } });
        send({ type: "agent_settled" });
      } else if (command.message === "crash") {
        process.exit(17);
      } else {
        setTimeout(() => {
          send({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
          send({ type: "agent_settled" });
        }, 120);
      }
    });
  }
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}
