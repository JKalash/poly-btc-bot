import { describe, expect, it } from "vitest";
import { timingSafeStringEqual } from "../src/auth";

describe("timingSafeStringEqual", () => {
  it("accepts equal strings", () => {
    expect(timingSafeStringEqual("0123456789abcdef", "0123456789abcdef")).toBe(true);
  });

  it("rejects unequal strings of the same byte length", () => {
    expect(timingSafeStringEqual("0123456789abcdef", "0123456789abcdee")).toBe(false);
  });

  it("rejects strings with different byte lengths", () => {
    expect(timingSafeStringEqual("short", "a-longer-secret")).toBe(false);
  });
});
