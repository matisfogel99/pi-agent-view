import { homedir } from "node:os";
import { join } from "node:path";

export interface SupervisorPaths {
  stateDir: string;
  socketPath: string;
  registryPath: string;
  sessionsDir: string;
}

export function getSupervisorPaths(stateDir = process.env.PI_AGENT_VIEW_STATE_DIR ?? join(homedir(), ".pi", "agent", "pi-agent-view")): SupervisorPaths {
  return {
    stateDir,
    socketPath: join(stateDir, "supervisor.sock"),
    registryPath: join(stateDir, "registry.json"),
    sessionsDir: join(stateDir, "sessions"),
  };
}
