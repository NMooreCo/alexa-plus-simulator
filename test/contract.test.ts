import { describe, expect, it } from "vitest";
import { DEVICES, LATENCY_BUDGET_MS } from "../src/shared/contract.ts";

describe("the contract", () => {
  it("has Alexa's two screen sizes and a device with no screen", () => {
    expect(new Set(DEVICES.map((d) => d.surface))).toEqual(new Set(["small", "large", "none"]));
    for (const d of DEVICES) {
      if (d.surface === "none") expect(d.width).toBeUndefined();
      else expect(d.width! > 0 && d.height! > 0).toBe(true);
    }
  });

  it("holds calls to Alexa's 500 ms round trip", () => {
    expect(LATENCY_BUDGET_MS).toBe(500);
  });
});
