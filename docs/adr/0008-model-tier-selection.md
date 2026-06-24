# ADR-0008: Model tier selection methodology

**Date**: 2026-06-23
**Status**: Proposed (eval framework built; live eval run pending AI Gateway provisioning — §6.1)
**Checklist**: §7.3

## Context

Forge uses a 5-tier model router (`packages/domain/src/model-router.ts`) to route
each request to the right model for cost/quality optimization (docs/08 §6):

| Tier | Purpose | Cost sensitivity | Quality sensitivity |
|---|---|---|---|
| `frontier` | Complex multi-step planning, architecture | Low | Critical |
| `default` | Workhorse for most coding sessions | Medium | High |
| `flex` | Cheap background — summarization, title gen | High | Medium |
| `specialist` | Coding specialist when default isn't best | Medium | High |
| `classifier` | Token-light routing + embeddings | Critical | Low |

The router (`routeModel`) picks a model from the tier's routing table, falling
back through preferences on failure. But **which specific model IDs fill each tier**
is a decision that must be made via evaluation, not guessing (docs/08 §18).

## Decision

Select tier model IDs via a **scored eval suite** (`packages/domain/src/model-eval.ts`)
with these criteria:

### Eval methodology

1. **Eval cases**: a curated set of representative tasks per tier (coding challenges
   for `default`/`specialist`, summarization for `flex`, intent classification for
   `classifier`, architecture problems for `frontier`). Each case has a ground-truth
   pass/fail + a quality rubric (0–1).

2. **Scoring** (`scoreCandidate`): a composite of quality + cost + latency:
   - **Quality** (0–1): rubric score averaged across cases
   - **Cost**: normalized $/1M tokens relative to the tier's cost ceiling
   - **Latency**: P95 time-to-first-token for the tier's latency budget
   - **Composite**: `quality × (1 - costWeight) + (1 - normalizedCost) × costWeight`
     where `costWeight` is 0.1 (frontier), 0.2 (default/specialist), 0.3 (flex),
     0.5 (classifier)

3. **Selection**: the highest-composite-score candidate per tier wins. Ties broken
   by preference order in the routing table.

### Initial tier IDs (pending live eval)

These are the **starting candidates** to evaluate via the AI Gateway once provisioned.
The eval will confirm or replace them:

| Tier | Candidate models | Rationale |
|---|---|---|
| `frontier` | claude-opus-4-1, gpt-5, gemini-3-pro | Strongest reasoning for architecture |
| `default` | claude-sonnet-4-6, gpt-5-mini, deepseek-v4 | Best quality/cost for daily coding |
| `flex` | claude-haiku-4, gemini-3-flash, gpt-5-nano | Cheap fast summarization |
| `specialist` | claude-sonnet-4-6 (if default differs) | Coding-specialist tier |
| `classifier` | llama-4-scout, gemini-3-flash | Cheapest viable intent/embedding |

### Live eval prerequisites

- AI Gateway endpoint provisioned (§6.1)
- Eval corpus (10–20 cases per tier, human-graded)
- `RunEvalSuite` implementation pointing at the Gateway

## Consequences

- **Positive**: model selection is data-driven, not guesswork. Re-runs on new model
  releases are a single `evaluateTier` call per tier.
- **Positive**: cost/quality tradeoff is explicit per tier (the composite weights).
- **Negative**: eval corpus maintenance — needs refreshing as task patterns evolve.
- **Risk**: the eval corpus may not capture real-session distribution. Mitigated by
  re-running quarterly on sampled production sessions (Phase 2 analytics v2).

## Open items

- Live eval run (blocked on §6.1 AI Gateway provisioning)
- Quarterly re-eval cadence (Phase 2)
- Per-repo model preference overrides (`.forge/config.toml` `[model]` — already parsed)
