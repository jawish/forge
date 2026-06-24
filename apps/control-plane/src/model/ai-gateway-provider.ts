// AI Gateway model client — the real-profile model (docs/08 §6, checklist §6.4).
// Replaces MockModelProvider when FORGE_DEV_PROFILE=real. Implements the same
// ModelProvider interface (stream → AsyncIterable<ModelEvent>).
//
// Routes through CF AI Gateway (unified call surface: caching, rate limits, cost
// tracking, per-provider fallback). Streaming is SSE → ModelEvent translation.
// Needs the AI Gateway endpoint + key (dev-shared, §6.1) to validate.

import type { ModelEvent, ModelProvider, ModelStreamInput } from "./provider";

/** AI Gateway config (from the dev-shared / prod secret binding). */
export interface AiGatewayConfig {
  /** The gateway endpoint, e.g. https://gateway.ai.cloudflare.com/v1/<acct>/<gateway>. */
  endpoint: string;
  /** Gateway API key. */
  apiKey: string;
  /** Default provider to route through (anthropic/openai/google/...). */
  provider: string;
}

/**
 * Parse an SSE stream chunk into model-event deltas. Translates the provider's
 * streaming deltas (thinking text, tool calls, completion) into the typed
 * ModelEvent stream the agent loop consumes (the same shape MockModelProvider
 * yields — docs/16 §3).
 *
 * This is the seam between "provider-specific streaming" and "Forge's typed
 * events". The fast profile's mock yields these directly; this client translates.
 */
export class AiGatewayModelProvider implements ModelProvider {
  readonly name = "ai-gateway";
  private readonly cfg: AiGatewayConfig;

  constructor(cfg: AiGatewayConfig) {
    this.cfg = cfg;
  }

  async *stream(input: ModelStreamInput): AsyncIterable<ModelEvent> {
    // Build the gateway URL: {endpoint}/{provider}/v1/chat/completions
    // The endpoint is the base (https://gateway.ai.cloudflare.com/v1/<acct>/<gateway>).
    // The provider segment (xai/openai/anthropic/etc.) routes to the right backend.
    // For OpenAI-compatible providers (xai, openai, etc.), the path is
    // {endpoint}/{provider}/v1/chat/completions.
    const providerSegment = this.cfg.provider === "anthropic" ? "anthropic" : this.cfg.provider;
    const url = `${this.cfg.endpoint}/${providerSegment}/v1/chat/completions`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.cfg.apiKey}`,
        "content-type": "application/json",
        ...(this.cfg.provider === "anthropic" ? { "anthropic-version": "2023-06-01" } : {}),
      },
      body: JSON.stringify({
        model: input.model,
        messages: [{ role: "user", content: input.prompt }],
        stream: true,
      }),
    });

    if (!res.ok || !res.body) {
      throw new Error(`AI Gateway stream failed: ${res.status}`);
    }

    // Parse the SSE stream line-by-line → ModelEvent deltas.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const event = this.parseSseLine(line);
        if (event) yield event;
      }
    }
    yield { type: "finish", reason: "stop" };
  }

  /**
   * Parse one SSE line into a ModelEvent. The AI Gateway forwards the provider's
   * delta format (OpenAI-compatible content deltas + tool_calls). Translation to
   * Forge's typed events happens here.
   */
  private parseSseLine(line: string): ModelEvent | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return null;
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") return null;
    try {
      const chunk = JSON.parse(data) as {
        choices?: Array<{
          delta?: {
            content?: string;
            tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
          };
          finish_reason?: string | null;
        }>;
      };
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) {
        return { type: "thinking_delta", text: delta.content };
      }
      if (delta?.tool_calls?.length) {
        const tc = delta.tool_calls[0]!;
        return {
          type: "tool_call",
          toolName: tc.function?.name ?? "unknown",
          args: tc.function?.arguments ? JSON.parse(tc.function.arguments) : {},
        };
      }
      const finish = chunk.choices?.[0]?.finish_reason;
      if (finish) {
        return { type: "finish", reason: finish === "length" ? "length" : "stop" };
      }
      return null;
    } catch {
      return null;
    }
  }
}
