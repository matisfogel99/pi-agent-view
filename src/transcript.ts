import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { TranscriptEntry, TranscriptPage } from "./protocol.ts";

/** Bounded client-side read model backed by durable session-entry cursors. */
export class TranscriptController {
  private readonly maximumEntries: number;
  private values: TranscriptEntry[] = [];
  private nextCursor?: string;
  private oldest?: string;
  private olderAvailable = false;
  private scrollFromBottom = 0;

  constructor(maximumEntries = 200) {
    this.maximumEntries = Math.max(1, maximumEntries);
  }

  applyPage(page: TranscriptPage): void {
    const wasEmpty = this.values.length === 0;
    const known = new Set(this.values.map((entry) => entry.id));
    for (const entry of page.entries) if (!known.has(entry.id)) {
      this.values.push(entry);
      known.add(entry.id);
    }
    if (this.values.length > this.maximumEntries) {
      this.values.splice(0, this.values.length - this.maximumEntries);
      this.olderAvailable = true;
    }
    this.nextCursor = page.cursor ?? this.nextCursor;
    this.oldest = this.values[0]?.id;
    if (wasEmpty) this.olderAvailable = page.hasMore;
  }

  prependPage(page: TranscriptPage): void {
    const known = new Set(this.values.map((entry) => entry.id));
    const older = page.entries.filter((entry) => !known.has(entry.id));
    this.values.unshift(...older);
    if (this.values.length > this.maximumEntries) this.values.length = this.maximumEntries;
    this.oldest = this.values[0]?.id;
    this.olderAvailable = page.hasMore;
  }

  entries(): readonly TranscriptEntry[] { return this.values; }
  cursor(): string | undefined { return this.nextCursor; }
  oldestCursor(): string | undefined { return this.oldest; }
  hasOlder(): boolean { return this.olderAvailable; }
  shouldLoadOlder(): boolean { return this.olderAvailable && this.scrollFromBottom >= Math.max(0, this.values.length - 10); }
  scroll(delta: number): void { this.scrollFromBottom = Math.max(0, this.scrollFromBottom + delta); }
  followLatest(): void { this.scrollFromBottom = 0; }

  render(width: number, height: number): string[] {
    const safeWidth = Math.max(1, width);
    const safeHeight = Math.max(1, height);
    const lines = this.values.flatMap((entry) => formatTranscriptEntry(entry).flatMap((line) => wrapTextWithAnsi(line, safeWidth)));
    const maximumOffset = Math.max(0, lines.length - safeHeight);
    this.scrollFromBottom = Math.min(this.scrollFromBottom, maximumOffset);
    const end = lines.length - this.scrollFromBottom;
    return lines.slice(Math.max(0, end - safeHeight), end).map((line) => truncateToWidth(line, safeWidth));
  }
}

export function formatTranscriptEntry(entry: TranscriptEntry): string[] {
  if (entry.type === "message" && isObject(entry.message)) {
    const role = typeof entry.message.role === "string" ? entry.message.role : "message";
    const text = contentText(entry.message.content);
    if (text) return [`${role}> ${text}`];
  }
  if (entry.type === "compaction" && typeof entry.summary === "string") return [`summary> ${entry.summary}`];
  if (entry.type === "session_info" && typeof entry.name === "string") return [`session> ${entry.name}`];
  return [`${entry.type}> ${compactJson(entry)}`];
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(isObject).map((block) => {
    if (typeof block.text === "string") return block.text;
    if (typeof block.thinking === "string") return `[thinking] ${block.thinking}`;
    if (block.type === "toolCall" && typeof block.name === "string") return `[tool] ${block.name}`;
    return "";
  }).filter(Boolean).join("\n");
}

function compactJson(value: unknown): string {
  try { return JSON.stringify(value).replace(/\s+/g, " ").slice(0, 500); }
  catch { return "unrenderable entry"; }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
