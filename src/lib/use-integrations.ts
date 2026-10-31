import { useQuery } from "@tanstack/react-query";
import { getIntegrations, type IntegrationStatus } from "@/lib/ai.functions";
import { useStudio } from "@/lib/studio-store";

/** Integration status for the signed-in user (database mode only). */
export function useIntegrations() {
  const { mode } = useStudio();
  return useQuery<IntegrationStatus>({
    queryKey: ["integrations"],
    queryFn: () => getIntegrations(),
    enabled: mode === "db",
    staleTime: 15_000,
    retry: false,
  });
}

/** A user-facing reason AI can't be used right now, or null when it can. */
export function aiBlockedReason(
  mode: "demo" | "db",
  s: IntegrationStatus | undefined,
): string | null {
  if (mode === "demo") return "AI needs the database. It is unavailable in demo mode.";
  if (!s) return "Checking AI status…";
  if (!s.ai.configured) return "Not connected — the ANTHROPIC_API_KEY secret has not been added.";
  if (!(s.ai.capUsd > 0)) return "Off — set a daily AI budget (USD) in Settings first.";
  if (s.ai.spentUsd >= s.ai.capUsd)
    return "Today's AI budget is used up. Raise it in Settings or wait until tomorrow (UTC).";
  return null;
}
