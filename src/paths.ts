import { homedir } from "node:os";
import { join } from "node:path";

export interface SupervisorPaths {
  stateDir: string;
  socketPath: string;
  registryPath: string;
  lockPath: string;
  logPath: string;
  sessionsDir: string;
  worktreesDir: string;
}

export function getSupervisorPaths(stateDir = process.env.PI_AGENT_VIEW_STATE_DIR ?? join(homedir(), ".pi", "agent", "pi-agent-view")): SupervisorPaths {
  return {
    stateDir,
    socketPath: join(stateDir, "supervisor.sock"),
    registryPath: join(stateDir, "registry.json"),
    lockPath: join(stateDir, "supervisor.lock"),
    logPath: join(stateDir, "supervisor.log"),
    sessionsDir: join(stateDir, "sessions"),
    worktreesDir: join(stateDir, "worktrees"),
  };
}
