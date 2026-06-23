import { describe, expect, it } from "vitest";
import { health } from "../src/main.js";

describe("forge-test-ts-service", () => {
  it("health reports ok", () => {
    expect(health()).toEqual({ status: "ok", service: "forge-test-ts-service" });
  });
});
