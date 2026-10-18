import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEVICES, LATENCY_BUDGET_MS, VERSION } from "../src/shared/contract.ts";

describe("the contract", () => {
  it("says the same version as package.json", () => {
    expect(VERSION).toBe((JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version);
  });

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
