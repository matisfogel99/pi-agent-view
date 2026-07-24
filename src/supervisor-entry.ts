#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { getSupervisorPaths } from "./paths.ts";
import { SupervisorServer } from "./supervisor-server.ts";

const paths = getSupervisorPaths();
const server = new SupervisorServer({ paths });

try {
  await server.start();
} catch (cause) {
  await appendFile(join(paths.stateDir, "supervisor.log"), `${new Date().toISOString()} ${cause instanceof Error ? cause.stack : String(cause)}\n`, { mode: 0o600 }).catch(() => undefined);
  process.exitCode = 1;
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => void server.close().finally(() => process.exit(0)));
}
