// OTel span names — operation-focused, dotted hierarchy (docs/14 §3).
// Stable, low-cardinality strings. Never interpolate IDs into span names
// (use attributes for cardinality).

export const SPAN = {
  SESSION_SPAWN: "session.spawn",
  SESSION_TRANSITION: "session.transition",
  SESSION_CANCEL: "session.cancel",
  PROMPT_SUBMIT: "prompt.submit",
  PROMPT_STREAM: "prompt.stream",
  TOOL_CALL: "tool.call",
  ARTIFACT_CREATE: "artifact.create",
  SANDBOX_PROVISION: "sandbox.provision",
  SANDBOX_SNAPSHOT: "sandbox.snapshot",
  SANDBOX_RESTORE: "sandbox.restore",
  CLASSIFIER_INTENT: "classifier.intent",
  CLASSIFIER_ROUTE: "classifier.route",
  SANITIZER_REDACT: "sanitizer.redact",
  PIPELINE_AUDIT: "pipeline.audit",
  BOUNDARY_EGRESS: "boundary.egress",
} as const;
export type SpanName = (typeof SPAN)[keyof typeof SPAN];
