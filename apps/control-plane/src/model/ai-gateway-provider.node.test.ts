import { describe, expect, it, vi } from "vitest";
import { AiGatewayModelProvider } from "./ai-gateway-provider";
import type { ModelEvent } from "./provider";

// AI Gateway model client (docs/08 §6, checklist §6.4). Tests the SSE → ModelEvent
// translation with a fake fetch returning canned SSE. (The real provider needs
// the AI Gateway endpoint + key to validate against live traffic — §6.)

async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

/** A fake SSE body from a list of data lines. */
function sseBody(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`data: ${line}\n`));
      controller.close();
    },
  });
}

describe("AiGatewayModelProvider — SSE → ModelEvent translation (§6.4)", () => {
  it("translates content deltas to thinking_delta events", async () => {
    const fakeLines = [
      JSON.stringify({ choices: [{ delta: { content: "Hello" } }] }),
      JSON.stringify({ choices: [{ delta: { content: " world" } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    ];
    const provider = new AiGatewayModelProvider({
      endpoint: "https://gw.example.com",
      apiKey: "k",
      provider: "anthropic",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(sseBody(fakeLines), { status: 200 }),
    );
    const events = await collect(provider.stream({ prompt: "hi", model: "claude-sonnet-4-6" }));
    expect(events.filter((e) => e.type === "thinking_delta")).toHaveLength(2);
    expect(events.find((e) => e.type === "finish")).toBeDefined();
  });

  it("translates tool_calls deltas to tool_call events", async () => {
    const fakeLines = [
      JSON.stringify({
        choices: [
          { delta: { tool_calls: [{ function: { name: "rg", arguments: '{"pattern":"foo"}' } }] } },
        ],
      }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_use" }] }),
    ];
    const provider = new AiGatewayModelProvider({ endpoint: "x", apiKey: "k", provider: "p" });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(sseBody(fakeLines), { status: 200 }),
    );
    const events = await collect(provider.stream({ prompt: "x", model: "m" }));
    const tool = events.find((e) => e.type === "tool_call");
    expect(tool).toBeDefined();
    if (tool?.type === "tool_call") {
      expect(tool.toolName).toBe("rg");
      expect(tool.args).toEqual({ pattern: "foo" });
    }
  });

  it("ignores [DONE] and malformed lines", async () => {
    const provider = new AiGatewayModelProvider({ endpoint: "x", apiKey: "k", provider: "p" });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        sseBody([
          "[DONE]",
          "{not json",
          JSON.stringify({ choices: [{ delta: { content: "ok" } }] }),
        ]),
        {
          status: 200,
        },
      ),
    );
    const events = await collect(provider.stream({ prompt: "x", model: "m" }));
    expect(events.filter((e) => e.type === "thinking_delta")).toHaveLength(1);
  });

  it("throws on a non-200 response", async () => {
    const provider = new AiGatewayModelProvider({ endpoint: "x", apiKey: "k", provider: "p" });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("err", { status: 500 }));
    await expect(collect(provider.stream({ prompt: "x", model: "m" }))).rejects.toThrow(
      /AI Gateway/,
    );
  });

  it("always emits a finish event at end of stream", async () => {
    const provider = new AiGatewayModelProvider({ endpoint: "x", apiKey: "k", provider: "p" });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(sseBody([JSON.stringify({ choices: [{ delta: { content: "x" } }] })]), {
        status: 200,
      }),
    );
    const events = await collect(provider.stream({ prompt: "x", model: "m" }));
    expect(events[events.length - 1]!.type).toBe("finish");
  });
});

describe("AiGatewayModelProvider.name", () => {
  it("reports ai-gateway", () => {
    const provider = new AiGatewayModelProvider({ endpoint: "x", apiKey: "k", provider: "p" });
    expect(provider.name).toBe("ai-gateway");
  });
});
