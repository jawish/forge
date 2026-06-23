import { describe, expect, it } from "vitest";
import { MockModelProvider } from "./mock-provider";
import type { ModelEvent } from "./provider";

// MockModelProvider — fast-profile model (docs/09 §5, checklist §4.4).
// Unit tests: the canned fixtures stream the expected events deterministically.

async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe("MockModelProvider (fast profile)", () => {
  it("defaults to the read-and-complete-PR fixture (drives to ready_for_pr)", async () => {
    const provider = new MockModelProvider();
    const events = await collect(provider.stream({ prompt: "fix the bug", model: "mock" }));
    const types = events.map((e) => e.type);
    expect(types).toContain("thinking_delta");
    expect(types).toContain("tool_call");
    expect(types).toContain("complete_pr");
    expect(types[types.length - 1]).toBe("finish");
  });

  it("routes to the request-human-input fixture for ambiguous prompts", async () => {
    const provider = new MockModelProvider();
    const events = await collect(
      provider.stream({ prompt: "which branch should this target?", model: "mock" }),
    );
    const input = events.find((e) => e.type === "request_human_input");
    expect(input).toBeDefined();
    expect(types(events)).toContain("request_human_input");
  });

  it("routes to the thinking-tool-call-completion fixture for exploratory prompts", async () => {
    const provider = new MockModelProvider();
    const events = await collect(
      provider.stream({ prompt: "explore the repo, no change needed", model: "mock" }),
    );
    expect(types(events)).toContain("thinking_delta");
    expect(types(events)).toContain("tool_call");
    expect(types(events)).not.toContain("complete_pr");
  });

  it("is deterministic — same prompt yields the same event sequence", async () => {
    const provider = new MockModelProvider();
    const a = await collect(provider.stream({ prompt: "fix it", model: "mock" }));
    const b = await collect(provider.stream({ prompt: "fix it", model: "mock" }));
    expect(a.map((e) => e.type)).toEqual(b.map((e) => e.type));
  });

  it("complete_pr events carry a diffSummary + commitSha", async () => {
    const provider = new MockModelProvider();
    const events = await collect(provider.stream({ prompt: "fix it", model: "mock" }));
    const complete = events.find(
      (e): e is Extract<ModelEvent, { type: "complete_pr" }> => e.type === "complete_pr",
    );
    expect(complete).toBeDefined();
    expect(complete!.diffSummary.length).toBeGreaterThan(0);
    expect(complete!.commitSha.length).toBeGreaterThan(0);
  });
});

function types(events: ModelEvent[]): string[] {
  return events.map((e) => e.type);
}
