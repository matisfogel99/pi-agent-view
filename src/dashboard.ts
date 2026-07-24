import { basename } from "node:path";
import type { SupervisorSnapshot, ThreadSnapshot, ThreadState } from "./protocol.ts";

export type DashboardGrouping = "project" | "attention";
export type DashboardSort = "recent" | "name";

export interface DashboardPreferences {
  grouping: DashboardGrouping;
  sort: DashboardSort;
  expandedProjects: Record<string, boolean>;
}

export interface DashboardGroup {
  key: string;
  label: string;
  expanded: boolean;
  threads: ThreadSnapshot[];
}

const ATTENTION_ORDER: ThreadState[] = ["working", "needs-input", "ready", "failed", "stopped"];

/** UI read model. Identity-based selection deliberately survives reordered live snapshots. */
export class DashboardController {
  private current: SupervisorSnapshot;
  private selectedId?: string;
  private query = "";
  readonly preferences: DashboardPreferences;

  constructor(snapshot: SupervisorSnapshot, preferences?: DashboardPreferences) {
    this.current = snapshot;
    this.preferences = preferences ?? { grouping: "project", sort: "recent", expandedProjects: {} };
    this.ensureSelection();
  }

  applySnapshot(snapshot: SupervisorSnapshot): void {
    this.current = snapshot;
    this.ensureSelection();
  }

  snapshot(): SupervisorSnapshot { return this.current; }
  selected(): ThreadSnapshot | undefined { return this.current.threads.find((thread) => thread.id === this.selectedId); }
  selectedThreadId(): string | undefined { return this.selectedId; }
  searchQuery(): string { return this.query; }

  setSearch(query: string): void {
    this.query = query.trim().toLocaleLowerCase();
    this.ensureSelection(true);
  }

  toggleGrouping(): void {
    this.preferences.grouping = this.preferences.grouping === "project" ? "attention" : "project";
    this.ensureSelection(true);
  }

  toggleSort(): void {
    this.preferences.sort = this.preferences.sort === "recent" ? "name" : "recent";
  }

  toggleSelectedProject(): void {
    const project = this.selected()?.project;
    if (!project || this.preferences.grouping !== "project") return;
    this.preferences.expandedProjects[project] = !this.isProjectExpanded(project);
    // Retain the hidden thread identity so the same group can be expanded again.
  }

  move(delta: number): void {
    const visible = this.visibleThreads();
    if (visible.length === 0) return;
    const index = Math.max(0, visible.findIndex((thread) => thread.id === this.selectedId));
    this.selectedId = visible[Math.max(0, Math.min(visible.length - 1, index + delta))]!.id;
  }

  groups(): DashboardGroup[] {
    const matching = this.current.threads.filter((thread) => this.matches(thread));
    if (this.preferences.grouping === "attention") {
      return ATTENTION_ORDER.map((state) => {
        const threads = matching.filter((thread) => state === "working"
          ? thread.state === "working" || thread.state === "starting"
          : thread.state === state);
        return { key: `state:${state}`, label: attentionLabel(state), expanded: true, threads: this.sort(threads) };
      }).filter((group) => group.threads.length > 0);
    }

    const projects = new Map<string, ThreadSnapshot[]>();
    for (const thread of matching) {
      const entries = projects.get(thread.project) ?? [];
      entries.push(thread);
      projects.set(thread.project, entries);
    }
    return [...projects.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([project, threads]) => ({
      key: `project:${project}`,
      label: `${basename(project) || project}  ${project}`,
      expanded: this.isProjectExpanded(project),
      threads: this.sort(threads),
    }));
  }

  visibleThreads(): ThreadSnapshot[] {
    return this.groups().flatMap((group) => group.expanded ? group.threads : []);
  }

  private ensureSelection(forceVisible = false): void {
    const exists = this.selectedId && this.current.threads.some((thread) => thread.id === this.selectedId);
    const visible = this.visibleThreads();
    if (!exists || forceVisible && !visible.some((thread) => thread.id === this.selectedId)) this.selectedId = visible[0]?.id;
  }

  private isProjectExpanded(project: string): boolean {
    return this.preferences.expandedProjects[project] ?? true;
  }

  private matches(thread: ThreadSnapshot): boolean {
    if (!this.query) return true;
    return [thread.name, thread.cwd, thread.project, thread.activity, thread.lastEvent, thread.transcriptMetadata]
      .filter((value): value is string => Boolean(value)).join("\n").toLocaleLowerCase().includes(this.query);
  }

  private sort(threads: ThreadSnapshot[]): ThreadSnapshot[] {
    return [...threads].sort(this.preferences.sort === "name"
      ? (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
      : (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }
}

function attentionLabel(state: ThreadState): string {
  if (state === "starting") return "Starting";
  if (state === "needs-input") return "Needs input";
  return `${state[0]!.toUpperCase()}${state.slice(1)}`;
}
