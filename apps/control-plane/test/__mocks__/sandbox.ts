// Test stub for @cloudflare/sandbox. The real package has bundled deps that
// break the miniflare test pool. Tests don't need the real Sandbox class —
// it's only used at deploy time. This stub provides the minimum exports
// needed for type resolution.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class Sandbox extends (globalThis as any).DurableObject ?? class {} {}

export function getSandbox() {
  throw new Error("getSandbox is not available in tests");
}

export function proxyToSandbox() {
  return null;
}

export function parseSSEStream() {
  return (async function* () {})();
}
