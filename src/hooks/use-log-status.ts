import { useSyncExternalStore } from "react";

import { logOverview, onLogUpdate } from "@/lib/api";
import type { LogStatus } from "@/types";

// Lives outside React; the Rust side sends the complete state on every change.
let byProject = new Map<string, LogStatus>();
const listeners = new Set<() => void>();
let started = false;

function apply(overview: LogStatus[]) {
  byProject = new Map(overview.map((s) => [s.projectId, s]));
  listeners.forEach((l) => l());
}

function ensureStarted() {
  if (started) return;
  started = true;
  onLogUpdate(apply);
  logOverview().then(apply, () => {});
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useLogStatus(projectId: string): LogStatus | undefined {
  ensureStarted();
  return useSyncExternalStore(subscribe, () => byProject.get(projectId));
}
