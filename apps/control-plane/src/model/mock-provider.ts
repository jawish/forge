// MockModelProvider — the fast-profile model (docs/09 §5, checklist §4.4).
// Streams canned fixtures so UI/loop work needs zero credentials and is fully
// deterministic. Implements the same ModelProvider interface as the real AI
// Gateway client (§6.4).
//
// Fixtures are imported as JSON modules (bundled by Vite/wrangler) so the provider
// works in BOTH the node pool (provider unit tests) and the workers pool (seam
// tests / the agent loop) — readFileSync isn't available in the worker runtime.
//
// Fixture selection: routes by a hint in the prompt (complete-pr / input), else
// defaults to the read-and-complete fixture. Deterministic — same input → same
// stream (docs/16 §3).

import type { ModelEvent, ModelProvider, ModelStreamInput } from "./provider";

// Static JSON imports (bundled — no filesystem access needed at runtime).
import readAndComplete from "../test/fixtures/model-responses/read-and-complete.json";
import requestHumanInput from "../test/fixtures/model-responses/request-human-input.json";
import thinkingToolCallCompletion from "../test/fixtures/model-responses/thinking-tool-call-completion.json";

const FIXTURES: Record<string, { name: string; events: ModelEvent[] }> = {
  "read-and-complete": readAndComplete as { name: string; events: ModelEvent[] },
  "request-human-input": requestHumanInput as { name: string; events: ModelEvent[] },
  "thinking-tool-call-completion": thinkingToolCallCompletion as {
    name: string;
    events: ModelEvent[];
  },
};

/** Which fixture to play for a given prompt. */
function selectFixture(input: ModelStreamInput): string {
  const p = input.prompt.toLowerCase();
  if (p.includes("ask") || p.includes("clarif") || p.includes("which branch")) {
    return "request-human-input";
  }
  if (p.includes("no change") || p.includes("explore")) {
    return "thinking-tool-call-completion";
  }
  // Default: the read-and-complete-PR flow (the happy path to ready_for_pr).
  return "read-and-complete";
}

/**
 * The mock model provider. Yields the canned events for the selected fixture
 * with a tiny delay so streaming UX is exercised (not zero-time).
 */
export class MockModelProvider implements ModelProvider {
  readonly name = "mock";

  async *stream(input: ModelStreamInput): AsyncIterable<ModelEvent> {
    const fixture = selectFixture(input);
    const { events } = FIXTURES[fixture]!;
    for (const event of events) {
      // Small yield so streaming is observable; keeps seam tests realistic.
      await new Promise((r) => setTimeout(r, 5));
      yield event;
    }
  }
}
