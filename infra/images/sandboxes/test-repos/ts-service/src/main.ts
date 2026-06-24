/**
 * Forge TS test repo service (docs/16 §2 fixture). Minimal HTTP service for the
 * sandbox/image-build tests + agent harness verification (§7.2).
 */
export function health(): { status: string; service: string } {
  return { status: "ok", service: "forge-test-ts-service" };
}

// When run directly (node dist/main.js), print the health payload.
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(health()));
}
