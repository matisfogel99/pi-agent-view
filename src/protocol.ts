export const PROTOCOL_VERSION = 3;

export type ThreadState = "starting" | "working" | "needs-input" | "ready" | "failed" | "stopped";
export type SessionOrigin = "created" | "adopted";

export type ExtensionUiMethod = "select" | "confirm" | "input" | "editor";

export interface PendingUiRequest {
  id: string;
  method: ExtensionUiMethod;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
}

export interface ThreadSnapshot {
  id: string;
  cwd: string;
  project: string;
  name: string;
  state: ThreadState;
  pid?: number;
  sessionFile?: string;
  sessionId?: string;
  sessionOrigin: SessionOrigin;
  createdAt: string;
  updatedAt: string;
  lastEvent?: string;
  activity?: string;
  /** Bounded, supervisor-derived text used by dashboard search. */
  transcriptMetadata?: string;
  /** Bounded recent assistant output for live preview; durable history remains in the session file. */
  recentOutput?: string;
  pendingRequest?: PendingUiRequest;
  error?: string;
}

export interface SupervisorSnapshot {
  protocolVersion: number;
  supervisorPid: number;
  threads: ThreadSnapshot[];
}

export interface LaunchThreadInput {
  cwd: string;
  name?: string;
  prompt?: string;
}

export interface AdoptThreadInput {
  sessionFile: string;
  name?: string;
}

export type ThreadMessageMode = "prompt" | "steer" | "followUp";

export interface TranscriptEntry {
  id: string;
  type: string;
  timestamp?: string;
  [key: string]: unknown;
}

export interface TranscriptPage {
  entries: TranscriptEntry[];
  /** First and last durable entry ids in this page. */
  startCursor?: string;
  cursor?: string;
  hasMore: boolean;
}

export interface UiResponseInput {
  requestId: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

export interface DeleteThreadResult {
  id: string;
  recordRemoved: boolean;
  transcriptDeleted: boolean;
  preservedPaths: string[];
  warnings: string[];
}

export type SupervisorMethod =
  | "snapshot" | "launch" | "adopt" | "stop" | "resume" | "delete"
  | "message" | "answer" | "abort" | "transcript" | "shutdown";

export interface ClientRequest {
  id: string;
  type: "request";
  method: SupervisorMethod;
  payload?: unknown;
}

export interface ServerResponse {
  id: string;
  type: "response";
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface SnapshotEvent {
  type: "snapshot";
  data: SupervisorSnapshot;
}
