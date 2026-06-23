// Forge session list + stats dashboard (docs/07 §4.4, docs/12 §3 D1 projection).
// Shows the conversion funnel (total / by-status / merge rate / cost) and a
// paginated session table. Clicking a row opens the live-stream view.

import { useState } from "react";
import { trpc } from "../lib/trpc";

interface SessionRow {
  id: string;
  repoId: string;
  branch: string;
  status: string;
  activity: string | null;
  primaryModel: string | null;
  prUrl: string | null;
  createdAt: number;
  endedAt: number | null;
  totalCostUsd: number;
  outcome: string | null;
}

interface Stats {
  total: number;
  byStatus: Record<string, number>;
  mergedCount: number;
  failedCount: number;
  cancelledCount: number;
  totalCostUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
  mergeRate: number;
  avgCostPerSession: number;
}

const STATUS_COLORS: Record<string, string> = {
  queued: "#888",
  active: "#2563eb",
  ready_for_pr: "#7c3aed",
  pr_open: "#7c3aed",
  merged: "#16a34a",
  closed: "#666",
  no_change: "#0891b2",
  failed: "#dc2626",
  cancelled: "#92400e",
};

function statusBadge(status: string): React.CSSProperties {
  return {
    color: STATUS_COLORS[status] ?? "#666",
    fontWeight: 600,
    fontSize: 12,
  };
}

function fmtCost(usd: number): string {
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SessionListScreen({
  onOpenSession,
  onNewSession,
}: {
  onOpenSession: (sessionId: string) => void;
  onNewSession: () => void;
}) {
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [before, setBefore] = useState<number | undefined>(undefined);

  // The caller is scoped automatically (ctx.userId = user_dev_fast in fast).
  const statsQ = trpc.session.stats.useQuery({});
  const listQ = trpc.session.list.useQuery({
    status: statusFilter as
      | "queued"
      | "active"
      | "ready_for_pr"
      | "pr_open"
      | "merged"
      | "closed"
      | "no_change"
      | "failed"
      | "cancelled"
      | undefined,
    beforeCreatedAt: before,
    limit: 50,
  });

  const stats = statsQ.data as Stats | undefined;
  const sessions = (listQ.data as SessionRow[] | undefined) ?? [];

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <h2 style={{ margin: 0 }}>Sessions</h2>
        <button
          onClick={onNewSession}
          style={{
            padding: "8px 16px",
            cursor: "pointer",
            borderRadius: 6,
            border: "1px solid #ccc",
          }}
        >
          + New Session
        </button>
      </div>

      {/* Stats — the conversion funnel + cost rollup (docs/07 §4.4) */}
      <div style={{ display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap" }}>
        <StatCard label="Total" value={stats?.total?.toString() ?? "—"} />
        <StatCard label="Merged" value={stats?.mergedCount?.toString() ?? "—"} color="#16a34a" />
        <StatCard label="Failed" value={stats?.failedCount?.toString() ?? "—"} color="#dc2626" />
        <StatCard
          label="Merge Rate"
          value={stats ? `${(stats.mergeRate * 100).toFixed(0)}%` : "—"}
        />
        <StatCard label="Total Cost" value={stats ? fmtCost(stats.totalCostUsd) : "—"} />
        <StatCard label="Cost / Session" value={stats ? fmtCost(stats.avgCostPerSession) : "—"} />
      </div>

      {/* Status filter pills */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <FilterPill
          label="All"
          active={statusFilter === undefined}
          onClick={() => {
            setStatusFilter(undefined);
            setBefore(undefined);
          }}
        />
        {["active", "queued", "merged", "failed", "cancelled"].map((s) => (
          <FilterPill
            key={s}
            label={s}
            active={statusFilter === s}
            onClick={() => {
              setStatusFilter(s);
              setBefore(undefined);
            }}
          />
        ))}
      </div>

      {/* Session table */}
      {listQ.isLoading ? (
        <p style={{ color: "#888" }}>Loading…</p>
      ) : sessions.length === 0 ? (
        <p style={{ color: "#888" }}>No sessions yet.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr style={{ borderBottom: "2px solid #eee", textAlign: "left" }}>
              <th style={{ padding: "8px" }}>Repo</th>
              <th style={{ padding: "8px" }}>Branch</th>
              <th style={{ padding: "8px" }}>Status</th>
              <th style={{ padding: "8px" }}>Cost</th>
              <th style={{ padding: "8px" }}>Created</th>
              <th style={{ padding: "8px" }}>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr
                key={s.id}
                onClick={() => onOpenSession(s.id)}
                style={{ borderBottom: "1px solid #f0f0f0", cursor: "pointer" }}
              >
                <td style={{ padding: "8px" }}>{s.repoId}</td>
                <td style={{ padding: "8px", fontFamily: "monospace", fontSize: 13 }}>
                  {s.branch}
                </td>
                <td style={{ padding: "8px" }}>
                  <span style={statusBadge(s.status)}>{s.status}</span>
                </td>
                <td style={{ padding: "8px", fontFamily: "monospace" }}>
                  {fmtCost(s.totalCostUsd)}
                </td>
                <td style={{ padding: "8px", color: "#666" }}>{fmtDate(s.createdAt)}</td>
                <td style={{ padding: "8px", color: "#888" }}>{s.outcome ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div
      style={{
        flex: "1 1 120px",
        padding: 12,
        borderRadius: 8,
        background: "#f8f9fa",
        border: "1px solid #eee",
      }}
    >
      <div style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, color: color ?? "#222" }}>{value}</div>
    </div>
  );
}

function FilterPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "4px 12px",
        borderRadius: 16,
        border: "1px solid #ddd",
        background: active ? "#2563eb" : "#fff",
        color: active ? "#fff" : "#444",
        cursor: "pointer",
        fontSize: 13,
        textTransform: "capitalize",
      }}
    >
      {label}
    </button>
  );
}
