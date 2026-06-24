/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, expect, it, vi } from "vitest";

// Mock @cloudflare/puppeteer at the top level (vi.mock is hoisted). The real
// module needs the CF Browser Rendering service; tests use a fake browser.
vi.mock("@cloudflare/puppeteer", () => ({
  launch: async () => ({
    newPage: async () => ({
      goto: async () => {},
      screenshot: async () => Buffer.from("fake-png-data"),
      close: async () => {},
    }),
  }),
}));

// Import after the mock is set up.
import { captureScreenshots } from "../src/agent/verification";

// Seam 8.2a — Browser Run screenshot capture (docs/01 closed-loop verification,
// checklist §8.2). Tests the screenshot → R2 → artifact-record flow.

describe("captureScreenshots (§8.2)", () => {
  it("returns empty when no browser binding is present (fast profile)", async () => {
    const results = await captureScreenshots({
      urls: [{ label: "home", url: "http://localhost:3000" }],
      uploadArtifact: async () => "r2://test/1",
      recordArtifact: async () => ({ artifactId: "a_1" }),
      browser: undefined,
    });
    expect(results).toEqual([]);
  });

  it("captures screenshots, uploads to R2, records artifacts, returns URIs", async () => {
    const uploadedKeys: string[] = [];
    const recordedArtifacts: Array<{ type: string; storageUri: string }> = [];

    const results = await captureScreenshots({
      urls: [
        { label: "home", url: "http://localhost:3000" },
        { label: "settings", url: "http://localhost:3000/settings" },
      ],
      async uploadArtifact(key, _content, _contentType) {
        uploadedKeys.push(key);
        return `r2://forge-artifacts/${key}`;
      },
      async recordArtifact(artifact) {
        recordedArtifacts.push(artifact);
        return { artifactId: `a_${recordedArtifacts.length}` };
      },
      // A non-undefined browser triggers the puppeteer.launch mock path.
      browser: {} as Fetcher,
    });

    expect(results).toHaveLength(2);
    expect(results[0].uri).toMatch(/screenshots\/home-\d+\.png/);
    expect(results[1].uri).toMatch(/screenshots\/settings-\d+\.png/);
    expect(uploadedKeys).toHaveLength(2);
    expect(recordedArtifacts).toHaveLength(2);
    expect(recordedArtifacts.every((a) => a.type === "screenshot")).toBe(true);
  });
});
