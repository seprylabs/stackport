export type Provider =
  | "allinkl"
  | "aws"
  | "contabo"
  | "digitalocean"
  | "domainfactory"
  | "hetzner"
  | "hosteurope"
  | "ionos"
  | "mittwald"
  | "netcup"
  | "strato"
  | "other";

export type Stack = "laravel" | "wordpress" | "static" | "other";

export interface Customer {
  id: string;
  name: string;
  notes?: string | null;
  favorite?: boolean;
}

export interface Server {
  id: string;
  name: string;
  provider: Provider;
  /** Hostname oder IP */
  host: string;
  port: number;
  sshUser?: string | null;
  /** Nur der Pfad zum Key; die App liest die Datei nie */
  sshKeyPath?: string | null;
  /** Jump host(s) for ssh -J, e.g. bastion or user@bastion:2222 */
  proxyJump?: string | null;
  /** Kunde, dem der Server gehört. Leer = eigener Server */
  customerId?: string | null;
  notes?: string | null;
  favorite?: boolean;
  /** Wird ausschließlich vom SSH-Check gesetzt */
  facts?: ServerFacts | null;
}

/** A host from ~/.ssh/config, offered for import */
export interface ConfigHost {
  alias: string;
  host: string;
  port: number;
  user: string | null;
  identityFile: string | null;
  proxyJump: string | null;
}

export interface Project {
  id: string;
  name: string;
  customerId: string;
  serverId?: string | null;
  stack: Stack;
  domain?: string | null;
  /** Pfad auf dem Server, z. B. /var/www/shop */
  path?: string | null;
  repoUrl?: string | null;
  notes?: string | null;
  favorite?: boolean;
  /** Wird nur in der Deploy-Ansicht bearbeitet */
  deployScript?: string | null;
  /** Log files on the server, one per line; only edited in the log viewer */
  logPaths?: string | null;
}

export type DeployStatus = "running" | "success" | "failed" | "cancelled" | "interrupted";

export interface Deploy {
  id: string;
  projectId: string;
  serverName: string;
  startedAt: string;
  status: DeployStatus;
  exitCode?: number | null;
  durationMs?: number | null;
  output: string;
}

export type CiForge = "github" | "gitlab";

export interface CiRepo {
  forge: CiForge;
  host: string;
  path: string;
  webUrl: string;
}

export type CiRunStatus = "queued" | "running" | "success" | "failed" | "cancelled" | "skipped" | "manual" | "other";

export interface CiRun {
  id: number;
  title: string;
  /** Name des GitHub-Workflows; bei GitLab leer */
  workflow?: string | null;
  branch?: string | null;
  sha?: string | null;
  status: CiRunStatus;
  event?: string | null;
  actor?: string | null;
  url: string;
  createdAt: string;
  updatedAt?: string | null;
}

/** Stand der Hintergrund-Abfrage je Projekt */
export interface ProjectCi {
  projectId: string;
  active: CiRun[];
  latest?: CiRunStatus | null;
  latestAt?: string | null;
}

export type CiResult =
  | { kind: "ok"; repo: CiRepo; runs: CiRun[]; hasToken: boolean }
  | { kind: "noRepo" }
  | { kind: "needsToken"; repo: CiRepo; hasToken: boolean }
  | { kind: "error"; repo: CiRepo; message: string };

export interface LastDeploy {
  projectId: string;
  status: DeployStatus;
  startedAt: string;
}

export interface Snapshot {
  customers: Customer[];
  servers: Server[];
  projects: Project[];
}

export type EntityKind = "customer" | "server" | "project";

/** Ergebnis eines Server-Checks per SSH */
export interface ServerFacts {
  checkedAt: string;
  os: { name: string; version: string; kernel: string };
  uptimeSeconds: number;
  cpu: { cores: number; load: [number, number, number] };
  memory: { totalMb: number; usedMb: number };
  disks: { mount: string; totalGb: number; usedGb: number }[];
  php?: {
    version: string;
    installed: string[];
    extensions: string[];
    memoryLimit: string;
    uploadMaxFilesize: string;
  };
  composer?: string;
  node?: string;
  npm?: string;
  git?: string;
  wpCli?: string;
  webserver?: { name: string; version: string };
  database?: { name: string; version: string };
  redis?: string;
}

export type Selection = { kind: EntityKind; id: string };

export type ConnectionStatus =
  | "ok"
  | "unknownHost"
  | "hostKeyChanged"
  | "authFailed"
  | "keyNotFound"
  | "keyPermissions"
  | "dnsFailed"
  | "refused"
  | "timeout"
  | "unreachable"
  | "invalidConfig"
  | "unknown";

export interface ConnectionResult {
  status: ConnectionStatus;
  /** Originalausgabe von ssh */
  detail?: string | null;
  durationMs: number;
}

/** Ergebnis von „Jetzt prüfen“; gesetzt, wenn keine Verbindung zustande kam */
export interface CheckOutcome {
  connectionError?: ConnectionResult | null;
}

/** Installierte Terminal-App, in der SSH-Sitzungen geöffnet werden können */
export interface TerminalApp {
  id: string;
  name: string;
}

/** Certificate and reachability check of a project domain */
export type SiteLevel = "ok" | "warn" | "critical" | "unknown";
export type CertProblem = "expired" | "notYetValid" | "wrongName" | "revoked" | "untrusted";

export interface SiteStatus {
  projectId: string;
  domain: string;
  /** Unix milliseconds */
  checkedAt: number;
  level: SiteLevel;
  certificate?: {
    /** Unix seconds */
    expiresAt: number;
    issuer?: string | null;
    problem?: CertProblem | null;
  } | null;
  http?: { status: number; millis: number } | null;
  error?: string | null;
}

/** Error and warning entries in a whole log file, counted in the background */
export interface LogFileCount {
  file: string;
  errors: number;
  warnings: number;
}

export interface LogStatus {
  projectId: string;
  /** Unix milliseconds */
  checkedAt: number;
  /** Readable log files; missing ones are left out */
  files: LogFileCount[];
}
