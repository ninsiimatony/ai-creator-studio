import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold sm:text-3xl">{title}</h1>
        {desc && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{desc}</p>}
      </div>
      {children}
    </div>
  );
}

const tones = {
  demo: "bg-warning/15 text-warning border-warning/30",
  off: "bg-muted text-muted-foreground border-border",
  teal: "bg-primary/15 text-primary border-primary/30",
  ok: "bg-success/15 text-success border-success/30",
  bad: "bg-destructive/15 text-destructive border-destructive/30",
};
export function Badge({
  tone = "off",
  children,
}: {
  tone?: keyof typeof tones;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

export function NextStep({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="panel border-dashed p-4">
      <div className="mb-1 flex items-center gap-2">
        <Badge tone="off">Not connected</Badge>
        <span className="text-sm font-medium">{title}</span>
      </div>
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

/** A panel for an AI action. Shows why AI is unavailable and disables its controls when it is. */
export function AiBox({
  title,
  blocked,
  children,
}: {
  title: string;
  blocked: string | null;
  children: ReactNode;
}) {
  return (
    <div className="panel p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{title}</span>
        <Badge tone={blocked ? "off" : "teal"}>{blocked ? "Unavailable" : "Claude"}</Badge>
      </div>
      {blocked && <p className="mb-3 text-sm text-muted-foreground">{blocked}</p>}
      <fieldset disabled={!!blocked} className="space-y-3 disabled:opacity-60">
        {children}
      </fieldset>
    </div>
  );
}
