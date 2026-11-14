import { CircleAlert, CircleX, Loader2, Workflow } from "lucide-react";
import { useTranslation } from "react-i18next";

import { LogStatusIcon } from "@/components/log-panel";
import { SiteStatusIcon } from "@/components/site-panel";
import { useProjectCi } from "@/hooks/use-ci-overview";
import { useDeployStatus } from "@/hooks/use-live-deploys";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Kleines Symbol in der Seitenleiste: Deploy läuft oder letzter Deploy fehlgeschlagen. Erfolg bleibt unauffällig. */
export function DeployStatusIcon({ projectId, className }: { projectId: string; className?: string }) {
  const { t } = useTranslation();
  const deploy = useDeployStatus(projectId);
  if (!deploy) return null;

  if (deploy.status === "running") {
    return (
      <span title={t("deployStatus.running")} className={cn("shrink-0", className)}>
        <Loader2 className="size-3.5 animate-spin text-info" />
      </span>
    );
  }
  if (deploy.status === "failed" || deploy.status === "interrupted") {
    const when = deploy.startedAt ? ` · ${formatRelative(deploy.startedAt)}` : "";
    const label = deploy.status === "failed" ? t("deployStatus.lastFailed") : t("deployStatus.lastInterrupted");
    return (
      <span title={`${label}${when}`} className={cn("shrink-0", className)}>
        <CircleAlert className={cn("size-3.5", deploy.status === "failed" ? "text-danger" : "text-warning")} />
      </span>
    );
  }
  return null;
}

/** Kleines Symbol in der Seitenleiste: Pipeline läuft oder letzte fehlgeschlagen */
export function CiStatusIcon({ projectId, className }: { projectId: string; className?: string }) {
  const { t } = useTranslation();
  const ci = useProjectCi(projectId);
  if (!ci) return null;

  if (ci.active.length > 0) {
    return (
      <span title={t("deployStatus.ciRunning", { title: ci.active[0].title })} className={cn("shrink-0", className)}>
        <Workflow className="size-3.5 animate-pulse text-ci" />
      </span>
    );
  }
  if (ci.latest === "failed") {
    const when = ci.latestAt ? ` · ${formatRelative(ci.latestAt)}` : "";
    return (
      <span title={`${t("deployStatus.lastPipelineFailed")}${when}`} className={cn("shrink-0", className)}>
        <CircleX className="size-3.5 text-danger" />
      </span>
    );
  }
  return null;
}

/** Deploy- und CI-Status nebeneinander */
export function ProjectStatusIcons({ projectId, className }: { projectId: string; className?: string }) {
  return (
    <span className={cn("flex shrink-0 items-center gap-1", className)}>
      <SiteStatusIcon projectId={projectId} />
      <LogStatusIcon projectId={projectId} />
      <CiStatusIcon projectId={projectId} />
      <DeployStatusIcon projectId={projectId} />
    </span>
  );
}
