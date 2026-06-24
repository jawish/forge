import { describe, expect, it } from "vitest";
import {
  alertFingerprint,
  handleAlert,
  interpolatePrompt,
  matchAutomation,
  tierForAlert,
  type AlertPayload,
  type Automation,
} from "./alert-handler";

// Alert-triggered automations (docs/04 Journey C, §10).

const AUTOMATIONS: Automation[] = [
  {
    id: "auto_1",
    repoId: "repo_monolith",
    name: "Error spike investigation",
    triggerType: "webhook",
    triggerConfig: { source: "grafana", labelKey: "service", labelValue: "checkout" },
    promptTemplate:
      "Investigate this alert: {{alert.title}} — {{alert.message}} ({{alert.severity}})",
    createdByUserId: "user_1",
    enabled: true,
  },
  {
    id: "auto_2",
    repoId: "repo_docs",
    name: "Disabled automation",
    triggerType: "webhook",
    triggerConfig: { source: "grafana" },
    promptTemplate: "x",
    createdByUserId: "user_1",
    enabled: false,
  },
];

const ALERT: AlertPayload = {
  source: "grafana",
  severity: "critical",
  title: "Error rate spike",
  message: "checkout 5xx at 12%",
  labels: { service: "checkout", env: "prod", alertname: "HighErrorRate" },
};

describe("tierForAlert (docs/04 Journey C)", () => {
  it("critical → frontier (fast path); else → flex (background)", () => {
    expect(tierForAlert({ ...ALERT, severity: "critical" })).toBe("frontier");
    expect(tierForAlert({ ...ALERT, severity: "warning" })).toBe("flex");
    expect(tierForAlert({ ...ALERT, severity: "info" })).toBe("flex");
  });
});

describe("interpolatePrompt", () => {
  it("substitutes the alert fields into the template", () => {
    const prompt = interpolatePrompt(
      "{{alert.title}} — {{alert.message}} ({{alert.severity}})",
      ALERT,
    );
    expect(prompt).toContain("Error rate spike");
    expect(prompt).toContain("5xx at 12%");
    expect(prompt).toContain("critical");
  });
  it("handles missing labels gracefully", () => {
    expect(interpolatePrompt("{{alert.labels}}", { ...ALERT, labels: undefined })).toBe("");
  });
});

describe("matchAutomation", () => {
  it("matches by source + label", () => {
    expect(matchAutomation(ALERT, AUTOMATIONS)?.id).toBe("auto_1");
  });
  it("skips disabled automations", () => {
    const disabled = matchAutomation({ ...ALERT, labels: {} }, AUTOMATIONS);
    expect(disabled).toBeNull();
  });
  it("returns null when no match", () => {
    expect(matchAutomation({ ...ALERT, source: "custom" }, AUTOMATIONS)).toBeNull();
  });
});

describe("handleAlert (docs/04 Journey C)", () => {
  it("produces the session-spawn request (automation + interpolated prompt + tier)", () => {
    const result = handleAlert({ alert: ALERT, automations: AUTOMATIONS });
    expect(result).not.toBeNull();
    expect(result!.automation.id).toBe("auto_1");
    expect(result!.prompt).toContain("Error rate spike");
    expect(result!.tier).toBe("frontier");
  });
  it("returns null when no automation matches", () => {
    expect(
      handleAlert({ alert: { ...ALERT, source: "custom" }, automations: AUTOMATIONS }),
    ).toBeNull();
  });
});

describe("alertFingerprint (dedup, docs/04 Journey C)", () => {
  it("fingerprints by source + alertname + service + env", () => {
    expect(alertFingerprint(ALERT)).toContain("grafana");
    expect(alertFingerprint(ALERT)).toContain("HighErrorRate");
    expect(alertFingerprint(ALERT)).toContain("checkout");
    expect(alertFingerprint(ALERT)).toContain("prod");
  });
  it("same alert → same fingerprint (dedup key)", () => {
    expect(alertFingerprint(ALERT)).toBe(alertFingerprint({ ...ALERT }));
  });
  it("different alert → different fingerprint", () => {
    expect(alertFingerprint(ALERT)).not.toBe(
      alertFingerprint({
        ...ALERT,
        labels: { service: "billing", env: "prod", alertname: "HighErrorRate" },
      }),
    );
  });
});
