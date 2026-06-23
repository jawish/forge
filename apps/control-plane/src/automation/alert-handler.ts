// Alert-triggered automations (docs/04 Journey C, §10). A Grafana/ClickHouse
// alert (or webhook/cron) → Forge creates a background investigation session with
// the alert payload as context. Runs on the flex tier unless high-priority.
//
// This is the handler for the automation trigger types (docs/12 §3 automation table).
// The session-spawn reuses the DO (§5.2); this is the trigger → session mapping.

import type { ModelTier } from "@forge/domain";

/** The trigger types an automation can have (docs/12 §3 automation table). */
export type AutomationTriggerType = "cron" | "webhook" | "github_event";

/** A registered automation (docs/12 §3 automation table row). */
export interface Automation {
  id: string;
  repoId: string;
  name: string;
  triggerType: AutomationTriggerType;
  /** The trigger config: cron expr / webhook source / GH event filter. */
  triggerConfig: Record<string, unknown>;
  /** The prompt template ({{alert.payload}} etc. interpolated). */
  promptTemplate: string;
  createdByUserId: string;
  enabled: boolean;
}

/** An incoming alert payload (Grafana/ClickHouse → webhook, docs/04 Journey C). */
export interface AlertPayload {
  source: "grafana" | "clickhouse" | "prometheus" | "custom";
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
  /** Structured labels (service, env, alertname). */
  labels?: Record<string, string>;
  /** The raw payload (for the prompt context). */
  raw?: unknown;
}

/** The tier to use for an alert-triggered session (docs/04 Journey C). */
export function tierForAlert(alert: AlertPayload): ModelTier {
  // Critical incidents → frontier (fast path); everything else → flex (background).
  return alert.severity === "critical" ? "frontier" : "flex";
}

/** Interpolate the prompt template with the alert payload (docs/04 Journey C). */
export function interpolatePrompt(template: string, alert: AlertPayload): string {
  return template
    .replaceAll("{{alert.title}}", alert.title)
    .replaceAll("{{alert.message}}", alert.message)
    .replaceAll("{{alert.severity}}", alert.severity)
    .replaceAll("{{alert.source}}", alert.source)
    .replaceAll("{{alert.labels}}", alert.labels ? JSON.stringify(alert.labels) : "")
    .replaceAll("{{alert.payload}}", alert.raw ? JSON.stringify(alert.raw) : "");
}

/** Match an alert to a registered automation (by repo + trigger config). */
export function matchAutomation(
  alert: AlertPayload,
  automations: ReadonlyArray<Automation>,
): Automation | null {
  // Match by the alert's labels → repo mapping in the automation's triggerConfig.
  for (const auto of automations) {
    if (!auto.enabled) continue;
    if (auto.triggerType !== "webhook") continue;
    const sourceMatch = auto.triggerConfig.source === alert.source;
    const labelMatch = auto.triggerConfig.labelKey
      ? alert.labels?.[auto.triggerConfig.labelKey as string] === auto.triggerConfig.labelValue
      : true;
    if (sourceMatch && labelMatch) return auto;
  }
  return null;
}

/**
 * Handle an alert: match → interpolate the prompt → produce a session-spawn
 * request (the caller spawns via the DO, §5.2). Dedup is the caller's job
 * (fingerprint on alert labels, docs/04 Journey C).
 */
export function handleAlert(opts: {
  alert: AlertPayload;
  automations: ReadonlyArray<Automation>;
}): { automation: Automation; prompt: string; tier: ModelTier } | null {
  const auto = matchAutomation(opts.alert, opts.automations);
  if (!auto) return null;
  return {
    automation: auto,
    prompt: interpolatePrompt(auto.promptTemplate, opts.alert),
    tier: tierForAlert(opts.alert),
  };
}

/** The dedup fingerprint for an alert (prevents duplicate sessions, docs/04 Journey C). */
export function alertFingerprint(alert: AlertPayload): string {
  const labels = alert.labels ?? {};
  const parts = [
    alert.source,
    labels.alertname ?? alert.title,
    labels.service ?? "",
    labels.env ?? "",
  ];
  return parts.filter(Boolean).join("|");
}
