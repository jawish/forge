# Forge — Grafana dashboards

The 5 standard Forge dashboards (docs/14 §6), built on the ClickHouse datasource
(`forge.session_event` — docs/12 §5; `forge.session_outcome_daily_table` — docs/12 §5 MV).

| Dashboard | File | Panels |
|---|---|---|
| **Session overview** | `dashboards/session-overview.json` | Active/queued/failed counts, sessions-per-status time series, p50/p99 TTI, cost per session |
| **Agent behavior** | `dashboards/agent-behavior.json` | Tool-call distribution (top 20), stuck-rate, model usage by tier, tool retry rate |
| **Cost** | `dashboards/cost.json` | Spend per repo/model, budget-burn rate (daily) + anomaly alert, cost per merged PR |
| **Reliability** | `dashboards/reliability.json` | Error rate by category (docs/15 §2), error-code breakdown, SANDBOX_PROVISIONING_FAILED, PROVIDER_ERROR |
| **Audit** | `dashboards/audit.json` | Session outcome rollup, PR-merge rate, no-change rate, outcomes per repo/day, cost per merged PR by repo |

All dashboards are filterable by `forge.repo.id`, `forge.user.id`, `forge.session.status`, and `environment` (docs/14 §6) via the templating variables.

## Provisioning

`provisioning/dashboards/forge.yml` auto-loads these into a `Forge` folder. Apply by:

- Mounting `dashboards/` into Grafana's provisioning path (local), OR
- The Pulumi Grafana provider at §6.6 widening (prod).

The datasource `forge-clickhouse` is the ClickStack ClickHouse datasource (provisioned §6/prod via the unified OTel-native ingest — docs/08 §14, docs/14 §5).

## Queries

Queries use ClickHouse SQL against the sanitized analytics tables (docs/18 Part A — projection-first; only safe structural fields + redacted content). The `payload` column carries per-event fields like `tool_name`, `error_category`, `error_code`, `error_message_truncated`.
