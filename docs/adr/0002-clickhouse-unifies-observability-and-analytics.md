# ADR-0002: ClickHouse unifies observability + analytics lake (Tempo/Loki/Prometheus dropped)

**Status**: accepted — supersedes the initial "Grafana + Tempo/Loki/Prometheus" recommendation made earlier in the same interview.

Forge uses ClickHouse Cloud with the ClickStack OTel-native ingest stack as the single backend for traces, metrics, logs, AND the sanitized analytics lake. Grafana remains the dashboard layer, pointed at ClickHouse instead of Tempo/Loki/Prometheus.

## Why

At the data level, **observability IS a subset of analytics**. An OTel span recording "tool call X took 800ms, cost $0.003" and an analytics-lake row recording "tool call X happened" are the *same fact* stored twice. The Ramp-style "data flywheel" the docs describe is literally "every session fully traced, query the traces." One store — ClickHouse with ClickStack — serves both, at 10–100× the aggregation performance of Postgres at Forge's target volume (10M+ rows/day).

## Considered options

- **Grafana + Tempo/Loki/Prometheus + separate ClickHouse lake** — the "standard" observability stack. Chosen initially. Rejected after reflection because traces in Tempo aren't analytically queryable, so the Ramp flywheel would require duplicating data into ClickHouse and reconciling drift between "what happened" (Tempo) and "what we analyze" (CH).
- **ClickHouse everywhere (incl. control-plane OLTP via CH Managed Postgres)** — cleanest vendor story but CH Managed PG is newer (2025) and less proven than D1 for the OLTP side.
- **Postgres-only** — simplest, but hits the OLAP wall at Forge's target volume, forcing a painful migration later.

## Consequences

- Team learns ClickHouse SQL (minor — it's ANSI-SQL-ish with columnar extensions).
- One OLAP store replaces three (Tempo, Loki, Prometheus all dropped). Fewer things to operate.
- Grafana's ClickHouse datasource plugin is first-class, so the dashboard UX is unchanged from the user's perspective.
- ClickHouse Cloud is regionally pinned while CF is global; analytics writes are async via Pipelines (acceptable latency, documented trade-off).
