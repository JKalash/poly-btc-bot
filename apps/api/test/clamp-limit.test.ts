import { describe, expect, it } from "vitest";
import { clampLimit } from "../src/server";

describe("clampLimit", () => {
  it("uses the default when a positive fraction floors below one", () => {
    expect(clampLimit("0.5", 50)).toBe(50);
    expect(clampLimit("0.999", 100)).toBe(100);
  });

  it("floors usable fractional limits", () => {
    expect(clampLimit("1", 50)).toBe(1);
    expect(clampLimit("12.9", 50)).toBe(12);
  });

  it("clamps large limits to the global maximum", () => {
    expect(clampLimit("500", 50)).toBe(500);
    expect(clampLimit("501.9", 50)).toBe(500);
  });

  it("uses the default for missing, non-finite, and non-positive limits", () => {
    expect(clampLimit(undefined, 25)).toBe(25);
    expect(clampLimit("not-a-number", 25)).toBe(25);
    expect(clampLimit("Infinity", 25)).toBe(25);
    expect(clampLimit("0", 25)).toBe(25);
    expect(clampLimit("-3", 25)).toBe(25);
  });
});
