import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/auth/AuthProvider";

export interface ExportUsage {
  unlimited: boolean;
  used: number | null;
  limit: number | null;
  period: string;
}

interface ConsumeResult {
  allowed: boolean;
  usage: ExportUsage | null;
}

interface UseExportUsageResult {
  /** Current usage for this calendar month, or null until first loaded. */
  usage: ExportUsage | null;
  loading: boolean;
  /** Re-reads usage without consuming an export. */
  refresh: () => Promise<void>;
  /**
   * The actual enforcement point: attempts to consume one export via the
   * `increment_export_usage` RPC (SECURITY DEFINER — the plan check and
   * 1x/month FREE limit happen server-side, not in this client code).
   * Must be called right before an export actually runs, never only from
   * button styling. Returns { allowed: false } once a FREE account has
   * already used its export for the month; PRO is always allowed and
   * never counted.
   */
  consumeExport: () => Promise<ConsumeResult>;
}

/**
 * Tracks the FREE-plan export limit (1x/calendar month) using a Supabase
 * counter that lives server-side — never localStorage, and never trusted
 * from a client-computed value. See supabase/sql/export_usage.sql and
 * supabase/sql/export_usage_1x_update.sql.
 */
export function useExportUsage(): UseExportUsageResult {
  const { user, isPro } = useAuth();
  const [usage, setUsage] = useState<ExportUsage | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!supabase || !user) {
      setUsage(null);
      return;
    }
    setLoading(true);
    try {
      const { data, error } = await supabase.rpc("get_export_usage");
      if (!error && data) setUsage(data as ExportUsage);
    } catch {
      // Network/RPC hiccup: leave previous usage as-is; the real
      // enforcement happens in consumeExport() regardless of this display
      // value being stale.
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void refresh();
  }, [refresh, isPro]);

  const consumeExport = useCallback(async (): Promise<ConsumeResult> => {
    if (!supabase || !user) {
      // No session / not configured: never silently allow an export whose
      // usage we can't actually record.
      return { allowed: false, usage: null };
    }

    const { data, error } = await supabase.rpc("increment_export_usage");
    if (error || !data) {
      // eslint-disable-next-line no-console
      console.warn("[FontSeru] increment_export_usage RPC failed:", error?.message);
      return { allowed: false, usage: null };
    }

    const result = data as ExportUsage & { allowed: boolean };
    const nextUsage: ExportUsage = {
      unlimited: result.unlimited,
      used: result.used,
      limit: result.limit,
      period: result.period,
    };
    setUsage(nextUsage);
    return { allowed: result.allowed, usage: nextUsage };
  }, [user]);

  return { usage, loading, refresh, consumeExport };
}
