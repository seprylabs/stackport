import { invoke, isTauri } from "@tauri-apps/api/core";
import i18n from "i18next";

import type { CheckOutcome, ConfigHost, CiResult, ProjectCi, ConnectionResult, SiteStatus, LogStatus, Deploy, LastDeploy, Customer, EntityKind, Project, Server, Snapshot, TerminalApp } from "@/types";

// Im Browser (npm run dev ohne Tauri) landen die Daten im localStorage,
// damit sich die Oberfläche auch ohne Rust-Backend ausprobieren lässt.
const BROWSER_KEY = "hostmoor-dev-data";

function browserLoad(): Snapshot {
  try {
    const raw = localStorage.getItem(BROWSER_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // leerer Speicher
  }
  return { customers: [], servers: [], projects: [] };
}

function browserUpdate(fn: (data: Snapshot) => void) {
  const data = browserLoad();
  fn(data);
  localStorage.setItem(BROWSER_KEY, JSON.stringify(data));
}

function upsert<T extends { id: string }>(list: T[], item: T) {
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) list[i] = { ...list[i], ...item };
  else list.push(item);
}

export async function loadAll(): Promise<Snapshot> {
  if (isTauri()) return invoke<Snapshot>("load_all");
  const data = browserLoad();
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "de");
  return {
    customers: data.customers.sort(byName),
    servers: data.servers.sort(byName),
    projects: data.projects.sort(byName),
  };
}

export async function saveCustomer(customer: Customer): Promise<void> {
  if (isTauri()) return invoke("save_customer", { customer });
  browserUpdate((d) => upsert(d.customers, customer));
}

export async function saveServer(server: Server): Promise<void> {
  if (isTauri()) return invoke("save_server", { server });
  // facts gehören dem SSH-Check und werden beim Speichern nicht überschrieben
  const { facts: _facts, ...rest } = server;
  browserUpdate((d) => upsert(d.servers, rest as Server));
}

export async function saveProject(project: Project): Promise<void> {
  if (isTauri()) return invoke("save_project", { project });
  browserUpdate((d) => upsert(d.projects, project));
}

export async function deleteEntity(kind: EntityKind, id: string): Promise<void> {
  if (isTauri()) {
    await invoke("delete_entity", { kind, id });
    return;
  }
  // Gleiches Verhalten wie die Fremdschlüssel in SQLite
  browserUpdate((d) => {
    if (kind === "customer") {
      d.customers = d.customers.filter((c) => c.id !== id);
      d.projects = d.projects.filter((p) => p.customerId !== id);
      d.servers.forEach((s) => s.customerId === id && (s.customerId = null));
    } else if (kind === "server") {
      d.servers = d.servers.filter((s) => s.id !== id);
      d.projects.forEach((p) => p.serverId === id && (p.serverId = null));
    } else {
      d.projects = d.projects.filter((p) => p.id !== id);
    }
  });
}

export async function setFavorite(kind: EntityKind, id: string, favorite: boolean): Promise<void> {
  if (isTauri()) return invoke("set_favorite", { kind, id, favorite });
  browserUpdate((d) => {
    const list: { id: string; favorite?: boolean }[] =
      kind === "customer" ? d.customers : kind === "server" ? d.servers : d.projects;
    const item = list.find((x) => x.id === id);
    if (item) item.favorite = favorite;
  });
}

function backupFileName() {
  return `hostmoor-backup-${new Date().toISOString().slice(0, 10)}.json`;
}

// Funktion statt Konstante, damit der Name erst beim Aufruf übersetzt wird
const backupFilter = () => [{ name: i18n.t("api.backupFilter"), extensions: ["json"] }];

/** Fragt nach einem Speicherort und schreibt das Backup; false, wenn abgebrochen */
export async function exportBackup(): Promise<boolean> {
  const exportedAt = new Date().toISOString();
  if (!isTauri()) {
    const data = { app: "Hostmoor", formatVersion: 1, exportedAt, ...browserLoad() };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: backupFileName() });
    a.click();
    URL.revokeObjectURL(url);
    return true;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({ defaultPath: backupFileName(), filters: backupFilter() });
  if (!path) return false;
  await invoke("export_backup", { path, exportedAt });
  return true;
}

/** Fragt nach einer Backup-Datei; null, wenn abgebrochen */
export async function pickBackupFile(): Promise<string | null> {
  if (!isTauri()) throw new Error(i18n.t("api.importBrowserOnly"));
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({ multiple: false, directory: false, filters: backupFilter() });
  return typeof path === "string" ? path : null;
}

/** Ersetzt alle Daten durch das Backup */
export async function importBackup(path: string): Promise<void> {
  await invoke("import_backup", { path });
}

/** Hosts from ~/.ssh/config for the import; the file is only read */
export async function readSshConfig(): Promise<ConfigHost[]> {
  if (!isTauri()) throw new Error(i18n.t("api.sshConfigBrowserOnly"));
  return invoke<ConfigHost[]>("read_ssh_config");
}

/** Prüft per SSH, ob die Anmeldung am Server klappt */
export async function testConnection(serverId: string): Promise<ConnectionResult> {
  if (!isTauri()) throw new Error(i18n.t("api.connectionTestBrowserOnly"));
  return invoke<ConnectionResult>("test_connection", { id: serverId });
}

export async function setDeployScript(projectId: string, script: string | null): Promise<void> {
  if (isTauri()) return invoke("set_deploy_script", { id: projectId, script });
  browserUpdate((d) => {
    const project = d.projects.find((p) => p.id === projectId);
    if (project) project.deployScript = script?.trim() ? script : null;
  });
}

export async function setLogPaths(projectId: string, paths: string | null): Promise<void> {
  if (isTauri()) return invoke("set_log_paths", { id: projectId, paths });
  browserUpdate((d) => {
    const project = d.projects.find((p) => p.id === projectId);
    if (project) project.logPaths = paths?.trim() ? paths : null;
  });
}

/** Last lines of a log file on the project's server */
export async function readLog(projectId: string, file: string, lines: number): Promise<string> {
  if (!isTauri()) throw new Error(i18n.t("api.logsBrowserOnly"));
  return invoke<string>("read_log", { projectId, file, lines });
}

export interface LogLinesEvent {
  streamId: string;
  lines: string[];
  ended: boolean;
  reason?: string | null;
}

/** Follows a log file; new lines arrive via `handler` until `stopLog` or the connection ends */
export async function followLog(
  projectId: string,
  file: string,
  handler: (event: LogLinesEvent) => void,
): Promise<{ streamId: string; stop: () => void }> {
  if (!isTauri()) throw new Error(i18n.t("api.logsBrowserOnly"));
  const { listen } = await import("@tauri-apps/api/event");
  const streamId = crypto.randomUUID();
  const off = await listen<LogLinesEvent>("log-lines", (e) => {
    if (e.payload.streamId !== streamId) return;
    handler(e.payload);
    if (e.payload.ended) off();
  });
  try {
    await invoke("follow_log", { projectId, file, streamId });
  } catch (e) {
    off();
    throw e;
  }
  return { streamId, stop: () => void invoke("stop_log", { streamId }) };
}

/** Empties a log file on the server; the counts are updated afterwards */
export async function clearLog(projectId: string, file: string): Promise<void> {
  if (!isTauri()) throw new Error(i18n.t("api.logsBrowserOnly"));
  await invoke("clear_log", { projectId, file });
}

/** Latest error and warning counts of all projects' log files */
export async function logOverview(): Promise<LogStatus[]> {
  if (!isTauri()) return [];
  return invoke<LogStatus[]>("log_overview");
}

/** Subscribes to new log counts; returns a function to unsubscribe */
export async function onLogUpdate(handler: (overview: LogStatus[]) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<LogStatus[]>("log-update", (e) => handler(e.payload));
}

/** Counts errors and warnings in the project's log files right away */
export async function checkLogs(projectId: string): Promise<LogStatus> {
  if (!isTauri()) throw new Error(i18n.t("api.logsBrowserOnly"));
  return invoke<LogStatus>("check_logs", { projectId });
}

export async function listDeploys(projectId: string): Promise<Deploy[]> {
  if (!isTauri()) return [];
  return invoke<Deploy[]>("list_deploys", { projectId });
}

/** Je Projekt der neueste Deploy, für die Seitenleiste */
export async function lastDeploys(): Promise<LastDeploy[]> {
  if (!isTauri()) return [];
  return invoke<LastDeploy[]>("last_deploys");
}

/** Startet den Deploy; die Ausgabe kommt über onDeployEvents */
export async function startDeploy(projectId: string, deployId: string): Promise<Deploy> {
  if (!isTauri()) throw new Error(i18n.t("api.deployBrowserOnly"));
  return invoke<Deploy>("start_deploy", { projectId, deployId, startedAt: new Date().toISOString() });
}

export async function cancelDeploy(projectId: string): Promise<boolean> {
  return invoke<boolean>("cancel_deploy", { projectId });
}

export interface DeployEvents {
  onOutput: (deployId: string, line: string) => void;
  onFinished: (deployId: string, projectId: string, status: Deploy["status"]) => void;
}

/** Abonniert die Live-Ausgabe aller Deploys; liefert eine Funktion zum Abmelden */
export async function onDeployEvents(handlers: DeployEvents): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const offOutput = await listen<{ deployId: string; line: string }>("deploy-output", (e) =>
    handlers.onOutput(e.payload.deployId, e.payload.line),
  );
  const offFinished = await listen<{ deployId: string; projectId: string; status: Deploy["status"] }>(
    "deploy-finished",
    (e) => handlers.onFinished(e.payload.deployId, e.payload.projectId, e.payload.status),
  );
  return () => {
    offOutput();
    offFinished();
  };
}

/** Letzte Pipeline-Läufe (GitHub Actions / GitLab CI) zur Repo-URL des Projekts */
export async function ciRuns(projectId: string): Promise<CiResult> {
  if (!isTauri()) throw new Error(i18n.t("api.ciBrowserOnly"));
  return invoke<CiResult>("ci_runs", { projectId });
}

/** Letzter Stand der Hintergrund-Abfrage aller Projekte */
export async function ciOverview(): Promise<ProjectCi[]> {
  if (!isTauri()) return [];
  return invoke<ProjectCi[]>("ci_overview");
}

/** Meldet sich für Änderungen der Hintergrund-Abfrage an; liefert eine Funktion zum Abmelden */
export async function onCiUpdate(handler: (overview: ProjectCi[]) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<ProjectCi[]>("ci-update", (e) => handler(e.payload));
}

/** Latest certificate checks of all project domains */
export async function siteOverview(): Promise<SiteStatus[]> {
  if (!isTauri()) return [];
  return invoke<SiteStatus[]>("site_overview");
}

/** Subscribes to new certificate check results; returns a function to unsubscribe */
export async function onSiteUpdate(handler: (overview: SiteStatus[]) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<SiteStatus[]>("site-update", (e) => handler(e.payload));
}

/** Checks the certificate of one project domain right away */
export async function checkSite(projectId: string): Promise<SiteStatus> {
  if (!isTauri()) throw new Error(i18n.t("api.siteBrowserOnly"));
  return invoke<SiteStatus>("check_site", { projectId });
}

/** Speichert den Token im Schlüsselbund des Systems; null entfernt ihn */
export async function setCiToken(host: string, token: string | null): Promise<void> {
  await invoke("set_ci_token", { host, token });
}

/** Tells the Rust side which language to use (null = system language); returns the resolved language */
export async function setBackendLanguage(language: "en" | "de" | null): Promise<"en" | "de"> {
  if (isTauri()) return invoke<"en" | "de">("set_language", { language });
  return (language ?? navigator.language).toLowerCase().startsWith("de") ? "de" : "en";
}

/** Öffnet einen Link im Standardbrowser */
export async function openExternal(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, "_blank", "noopener");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

/** Öffnet das Terminal mit einer SSH-Sitzung; mit `dir` direkt in diesem Ordner auf dem Server.
 *  `terminal` ist eine ID aus `listTerminals`, null = Systemstandard */
export async function openTerminal(serverId: string, dir?: string | null, terminal?: string | null): Promise<void> {
  if (!isTauri()) throw new Error(i18n.t("api.terminalBrowserOnly"));
  await invoke("open_terminal", { id: serverId, dir: dir ?? null, terminal: terminal ?? null });
}

/** Installierte Terminal-Apps (Terminal, iTerm2, Ghostty …) */
export async function listTerminals(): Promise<TerminalApp[]> {
  if (!isTauri()) return [];
  return invoke<TerminalApp[]>("list_terminals");
}

/** Liest PHP, Node, Kapazität usw. per SSH aus; das Ergebnis wird beim Server gespeichert */
export async function checkServer(serverId: string): Promise<CheckOutcome> {
  if (!isTauri()) throw new Error(i18n.t("api.serverCheckBrowserOnly"));
  return invoke<CheckOutcome>("check_server", { id: serverId, checkedAt: new Date().toISOString() });
}
