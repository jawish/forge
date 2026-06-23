// MockModelProvider — the fast-profile model (docs/09 §5, checklist §4.4).
// Streams canned fixtures (docs/16 §2 model-responses/) so UI/loop work needs
// zero credentials and is fully deterministic. Implements the same ModelProvider
// interface as the real AI Gateway client (§6.4).
//
// Fixture selection: routes by a hint in the prompt (complete-pr / input), else
// defaults to the read-and-complete fixture. Deterministic — same input → same
// stream, so seam tests are stable (docs/16 §3).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelEvent, ModelProvider, ModelStreamInput } from "./provider";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "test", "fixtures", "model-responses");

type FixtureFile = { name: string; events: ModelEvent[] };

function loadFixture(name: string): FixtureFile {
  const raw = readFileSync(join(fixturesDir, `${name}.json`), "utf8");
  return JSON.parse(raw) as FixtureFile;
}

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
    const { events } = loadFixture(fixture);
    for (const event of events) {
      // Small yield so streaming is observable; keeps seam tests realistic.
      await new Promise((r) => setTimeout(r, 5));
      yield event;
    }
  }
}
