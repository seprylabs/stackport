import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bug, Eraser, FileText, Pause, Pencil, Play, RefreshCw, Search, TriangleAlert } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useLogStatus } from "@/hooks/use-log-status";
import { checkLogs, clearLog, followLog, readLog } from "@/lib/api";
import { matches, parseLog, suggestedLogPaths, type LevelFilter, type LogLevel } from "@/lib/log-parse";
import { cn } from "@/lib/utils";
import type { LogFileCount, Project, Server } from "@/types";

/** Lines loaded when a file is opened */
const INITIAL_LINES = 500;
/** Lines kept while following, older ones are dropped */
const MAX_KEPT = 10_000;

const levelClass: Record<LogLevel, string> = {
  error: "text-red-400",
  warning: "text-amber-300",
  info: "",
};

/** "3 errors, 5 warnings"; empty when there are neither */
function useCountSummary() {
  const { t } = useTranslation();
  return ({ errors, warnings }: Pick<LogFileCount, "errors" | "warnings">) =>
    [errors > 0 && t("logs.errors", { count: errors }), warnings > 0 && t("logs.warnings", { count: warnings })]
      .filter(Boolean)
      .join(", ");
}

/** Sidebar indicator: red when a log of the project has errors, amber when it only has warnings */
export function LogStatusIcon({ projectId, className }: { projectId: string; className?: string }) {
  const { t } = useTranslation();
  const summarize = useCountSummary();
  const status = useLogStatus(projectId);
  if (!status) return null;
  const total = status.files.reduce(
    (sum, f) => ({ errors: sum.errors + f.errors, warnings: sum.warnings + f.warnings }),
    { errors: 0, warnings: 0 },
  );
  if (total.errors === 0 && total.warnings === 0) return null;
  const Icon = total.errors > 0 ? Bug : TriangleAlert;
  const label = t("logs.indicator", { summary: summarize(total) });
  return (
    <span title={label} aria-label={label} className={cn("shrink-0", className)}>
      <Icon className={cn("size-3.5", total.errors > 0 ? "text-danger" : "text-warning")} />
    </span>
  );
}

/** Counts next to a file name in the viewer */
function FileCounts({ count }: { count?: LogFileCount }) {
  const summarize = useCountSummary();
  if (!count || (count.errors === 0 && count.warnings === 0)) return null;
  return (
    <span className="flex items-center gap-1 font-sans tabular-nums" title={summarize(count)}>
      {count.errors > 0 && (
        <span className="bg-danger/15 text-danger rounded px-1 text-[10px] leading-4 font-medium">{count.errors}</span>
      )}
      {count.warnings > 0 && (
        <span className="bg-warning/15 text-warning rounded px-1 text-[10px] leading-4 font-medium">
          {count.warnings}
        </span>
      )}
    </span>
  );
}

interface Props {
  project: Project;
  server?: Server;
  onEditProject: () => void;
  onSavePaths: (paths: string | null) => Promise<boolean>;
}

export function LogPanel({ project, server, onEditProject, onSavePaths }: Props) {
  const { t } = useTranslation();
  const paths = useMemo(() => {
    const saved = (project.logPaths ?? "")
      .split("\n")
      .map((p) => p.trim())
      .filter(Boolean);
    return saved.length > 0 ? saved : suggestedLogPaths(project.stack);
  }, [project.logPaths, project.stack]);

  const [file, setFile] = useState<string | null>(paths[0] ?? null);
  const [lines, setLines] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [following, setFollowing] = useState(false);
  const [filter, setFilter] = useState<LevelFilter>("all");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const status = useLogStatus(project.id);
  const stopRef = useRef<(() => void) | null>(null);
  const outRef = useRef<HTMLPreElement>(null);

  // Selected file disappeared after editing the list
  useEffect(() => {
    if (!file || !paths.includes(file)) setFile(paths[0] ?? null);
  }, [paths, file]);

  const stopFollowing = useCallback(() => {
    stopRef.current?.();
    stopRef.current = null;
    setFollowing(false);
  }, []);

  // Stop when the file, project or view changes
  useEffect(() => stopFollowing, [file, project.id, stopFollowing]);

  const load = useCallback(async () => {
    if (!file || !server) return;
    setLoading(true);
    setError(null);
    try {
      const text = await readLog(project.id, file, INITIAL_LINES);
      setLines(text ? text.replace(/\n$/, "").split("\n") : []);
    } catch (e) {
      setLines(null);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [file, project.id, server]);

  const refresh = () => {
    load();
    // The indicator counts the whole file; a failed count keeps the last one
    checkLogs(project.id).catch(() => {});
  };

  const clear = async () => {
    if (!file) return;
    setClearing(true);
    try {
      await clearLog(project.id, file);
      setLines([]);
      toast.success(t("logs.cleared"), { description: file });
    } catch (e) {
      toast.error(t("logs.clearFailed"), { description: String(e) });
    } finally {
      setClearing(false);
      setConfirmClear(false);
    }
  };

  // Load once per file; the log is only read when the panel is shown
  useEffect(() => {
    setLines(null);
    load();
  }, [load]);

  const follow = async () => {
    if (!file) return;
    if (lines === null) await load();
    try {
      const { stop } = await followLog(project.id, file, (event) => {
        if (event.lines.length > 0) {
          setLines((prev) => {
            const next = [...(prev ?? []), ...event.lines];
            return next.length > MAX_KEPT ? next.slice(next.length - MAX_KEPT) : next;
          });
        }
        if (event.ended) {
          stopRef.current = null;
          setFollowing(false);
          if (event.reason) toast.error(t("logs.followEnded"), { description: event.reason });
        }
      });
      stopRef.current = stop;
      setFollowing(true);
    } catch (e) {
      toast.error(t("logs.followFailed"), { description: String(e) });
    }
  };

  const entries = useMemo(() => parseLog(lines ?? []), [lines]);
  const visible = useMemo(() => entries.filter((e) => matches(e, filter, search)), [entries, filter, search]);

  // Stay at the bottom like `tail`, unless the user scrolled up
  useEffect(() => {
    const el = outRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [visible]);

  const startEditing = () => {
    setDraft(paths.join("\n"));
    setEditing(true);
  };

  const save = async () => {
    if (await onSavePaths(draft.trim() ? draft : null)) setEditing(false);
  };

  const missing = !server
    ? t("logs.missingServer")
    : !project.path && paths.some((p) => !p.startsWith("/") && !p.startsWith("~/"))
      ? t("logs.missingPath")
      : null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2">
        <FileText className="text-muted-foreground size-4" />
        <CardTitle>{t("logs.title")}</CardTitle>
        <div className="ml-auto flex gap-1">
          {!editing && (
            <Button size="sm" variant="ghost" onClick={startEditing}>
              <Pencil /> {t("logs.editPaths")}
            </Button>
          )}
          {file && !editing && !missing && (
            <>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={refresh}
                disabled={loading || following}
                title={t("common.refresh")}
                aria-label={t("common.refresh")}
              >
                <RefreshCw className={cn(loading && "animate-spin")} />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmClear(true)} disabled={clearing}>
                <Eraser /> {t("logs.clear")}
              </Button>
              <Button size="sm" variant={following ? "secondary" : "outline"} onClick={following ? stopFollowing : follow}>
                {following ? <Pause /> : <Play />} {following ? t("logs.stopFollowing") : t("logs.follow")}
              </Button>
            </>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-3 text-sm">
        {missing && !editing && (
          <div className="bg-muted/60 flex items-center justify-between gap-4 rounded-md px-3 py-2">
            <span className="text-muted-foreground">{missing}</span>
            <Button size="sm" variant="outline" onClick={onEditProject}>
              {t("common.editProject")}
            </Button>
          </div>
        )}

        {editing ? (
          <div className="space-y-3">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              rows={4}
              className="font-mono text-xs"
              placeholder={"storage/logs/laravel.log\n/var/log/nginx/error.log"}
            />
            <p className="text-muted-foreground text-xs">
              <Trans
                i18nKey="logs.pathsHelp"
                values={{ path: project.path || t("deploy.panel.noPath") }}
                components={{ code: <code className="font-mono" /> }}
              />
            </p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                {t("deploy.panel.discard")}
              </Button>
              <Button size="sm" onClick={save}>
                {t("common.save")}
              </Button>
            </div>
          </div>
        ) : paths.length === 0 ? (
          <p className="text-muted-foreground">{t("logs.noPaths")}</p>
        ) : (
          !missing && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {paths.map((p) => (
                  <Button
                    key={p}
                    size="xs"
                    variant={p === file ? "secondary" : "ghost"}
                    className="font-mono"
                    onClick={() => setFile(p)}
                  >
                    {p}
                    <FileCounts count={status?.files.find((f) => f.file === p)} />
                  </Button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <ToggleGroup
                  type="single"
                  size="sm"
                  variant="outline"
                  value={filter}
                  onValueChange={(v) => v && setFilter(v as LevelFilter)}
                >
                  <ToggleGroupItem value="all">{t("logs.filter.all")}</ToggleGroupItem>
                  <ToggleGroupItem value="warning">{t("logs.filter.warning")}</ToggleGroupItem>
                  <ToggleGroupItem value="error">{t("logs.filter.error")}</ToggleGroupItem>
                </ToggleGroup>
                <div className="relative min-w-48 flex-1">
                  <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={t("logs.search")}
                    className="h-8 pl-8"
                  />
                </div>
                {lines && (
                  <span className="text-muted-foreground text-xs">
                    {t("logs.count", { shown: visible.length, count: entries.length })}
                  </span>
                )}
              </div>
              {error ? (
                <pre className="text-danger bg-muted max-h-40 overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap">
                  {error}
                </pre>
              ) : (
                <pre
                  ref={outRef}
                  className="bg-terminal text-terminal-foreground h-80 overflow-auto rounded-md p-3 font-mono text-xs leading-relaxed"
                >
                  {lines === null
                    ? t("common.loading")
                    : visible.length === 0
                      ? lines.length === 0
                        ? t("logs.empty")
                        : t("logs.noMatches")
                      : visible.map((entry, i) => (
                          <div key={i} className={levelClass[entry.level]}>
                            {entry.text}
                          </div>
                        ))}
                </pre>
              )}
              <p className="text-muted-foreground text-xs">{t("logs.footer", { count: INITIAL_LINES })}</p>
            </>
          )
        )}
      </CardContent>

      <AlertDialog open={confirmClear} onOpenChange={(open) => !clearing && setConfirmClear(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("logs.clearTitle", { file })}</AlertDialogTitle>
            <AlertDialogDescription>{t("logs.clearDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clearing}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={clearing}
              onClick={(e) => {
                // Stay open until the server answered
                e.preventDefault();
                clear();
              }}
            >
              <Eraser /> {t("logs.clear")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
