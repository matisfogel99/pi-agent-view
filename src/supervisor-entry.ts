#!/usr/bin/env node
import { appendFile, chmod } from "node:fs/promises";
import { getSupervisorPaths } from "./paths.ts";
import { SupervisorServer } from "./supervisor-server.ts";

const paths = getSupervisorPaths();
const server = new SupervisorServer({ paths });

try {
  await server.start();
} catch (cause) {
  await appendFile(paths.logPath, `${new Date().toISOString()} ${cause instanceof Error ? cause.stack : String(cause)}\n`, { mode: 0o600 })
    .then(() => chmod(paths.logPath, 0o600)).catch(() => undefined);
  process.exitCode = 1;
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => void server.close().finally(() => process.exit(0)));
}
