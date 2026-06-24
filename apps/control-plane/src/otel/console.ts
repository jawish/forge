// OTel console exporter — the fast/real local profile (docs/14 §7).
// Every span logs to the terminal with forge.* attrs (14 §1). In staging/prod
// this is replaced by the ClickStack OTel exporter; locally the console is the
// dev-feedback loop (no ClickHouse/Grafana needed — docs/09 §5).
//
// Minimal by design: a start/end span helper that records attributes and prints.
// Not a full OTel SDK — Workers has its own tracing; this is the inner-loop dev
// surface. The ATTR/SPAN/SERVICE constants come from @forge/domain (single source).

import { ATTR, SERVICE, SPAN, type ServiceName, type SpanName } from "@forge/domain";

export interface SpanAttrs {
  [key: string]: string | number | boolean | undefined;
}

/** A span — started, attributed, ended. */
export interface Span {
  readonly name: SpanName | string;
  readonly attrs: SpanAttrs;
  readonly startedAt: number;
  end(extra?: SpanAttrs): void;
  setAttribute(key: string, value: string | number | boolean): void;
  /** Record an error on this span (sets forge.error.* attrs). */
  recordError(category: string, code: string | undefined, message: string): void;
}

let correlationCounter = 0;

/** A correlation/trace id generator (cheap, monotonic-ish for local). */
export function newCorrelationId(): string {
  correlationCounter += 1;
  return `trace_${Date.now().toString(36)}_${correlationCounter}`;
}

interface ConsoleExporterConfig {
  enabled: boolean;
  service: ServiceName;
}

const config: ConsoleExporterConfig = {
  enabled: true,
  service: SERVICE.CONTROL_PLANE,
};

/** Configure the exporter (e.g. disable in tests). */
export function configureConsoleExporter(opts: Partial<ConsoleExporterConfig>): void {
  Object.assign(config, opts);
}

/**
 * Start a span. Returns a Span that logs to console on end (docs/14 §7).
 * Usage:
 *   const span = startSpan(SPAN.SESSION_SPAWN, { [ATTR.SESSION_ID]: id });
 *   ... do work ...
 *   span.end();
 */
export function startSpan(name: SpanName | (string & {}), attrs: SpanAttrs = {}): Span {
  const startedAt = Date.now();
  const allAttrs: SpanAttrs = { ...attrs };
  const span: Span = {
    name,
    attrs: allAttrs,
    startedAt,
    setAttribute(key, value) {
      allAttrs[key] = value;
    },
    recordError(category, code, message) {
      allAttrs[ATTR.ERROR_CATEGORY] = category;
      if (code) allAttrs[ATTR.ERROR_CODE] = code;
      allAttrs["error.message"] = message;
    },
    end(extra) {
      if (extra) Object.assign(allAttrs, extra);
      const durationMs = Date.now() - startedAt;
      if (config.enabled) {
        // Compact one-line span log: service | span | dur | attrs
        const attrStr = Object.entries(allAttrs)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(" ");
        // eslint-disable-next-line no-console
        console.log(`[otel] ${config.service} | ${name} | ${durationMs}ms | ${attrStr}`);
      }
    },
  };
  return span;
}

export { ATTR, SPAN, SERVICE };
