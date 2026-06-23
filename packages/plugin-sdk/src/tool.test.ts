import { describe, expect, it } from "vitest";
import { defineMcpServer, definePermissions, defineTool, toMcpToolList, z } from "./index";

// @forge/plugin-sdk — MCP author SDK (docs/19 §10, ADR-0007).

describe("defineTool — typed MCP tool", () => {
  it("defines a tool with a zod input + handler", () => {
    const echo = defineTool({
      name: "echo",
      description: "Echo the input",
      input: z.object({ message: z.string() }),
      handler: (input) => ({ echoed: input.message }),
    });
    expect(echo.name).toBe("echo");
    expect(echo.input.safeParse({ message: "hi" }).success).toBe(true);
  });

  it("the handler is type-safe (validated input)", async () => {
    const add = defineTool({
      name: "add",
      description: "Add two numbers",
      input: z.object({ a: z.number(), b: z.number() }),
      handler: (input) => ({ sum: input.a + input.b }),
    });
    const parsed = add.input.parse({ a: 2, b: 3 });
    const result = await add.handler(parsed, { sessionId: "s", repoId: "r", log: () => {} });
    expect(result.sum).toBe(5);
  });
});

describe("definePermissions — Outbound Workers manifest (docs/18 §5)", () => {
  it("declares the egress allowlist + credential refs", () => {
    const manifest = definePermissions({
      egress: [{ host: "api.linear.app:443", credential: "linear_token" }],
      paths: { read: ["./data"], write: [] },
    });
    expect(manifest.egress[0]!.host).toBe("api.linear.app:443");
    expect(manifest.egress[0]!.credential).toBe("linear_token");
    expect(manifest.paths?.read).toEqual(["./data"]);
  });
});

describe("defineMcpServer + toMcpToolList — MCP composition", () => {
  const linear = defineMcpServer({
    id: "linear",
    displayName: "Linear",
    description: "Query Linear issues",
    version: "1.0.0",
    tools: [
      defineTool({
        name: "list_issues",
        description: "List Linear issues",
        input: z.object({ team: z.string() }),
        handler: () => ({ issues: [] }),
      }),
    ],
    permissions: definePermissions({
      egress: [{ host: "api.linear.app:443", credential: "linear_token" }],
    }),
  });

  it("composes the server metadata + tools + permissions", () => {
    expect(linear.id).toBe("linear");
    expect(linear.tools).toHaveLength(1);
    expect(linear.permissions.egress).toHaveLength(1);
  });

  it("toMcpToolList emits the MCP-protocol tool shape", () => {
    const list = toMcpToolList(linear);
    expect(list[0]).toMatchObject({ name: "list_issues", description: "List Linear issues" });
    expect(list[0]!.inputSchema).toBeDefined();
  });
});
