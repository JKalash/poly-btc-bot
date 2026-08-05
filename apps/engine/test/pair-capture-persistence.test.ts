import { describe, expect, it } from "vitest";
import { resolveCapturePersistence } from "../src/pair-capture-persistence";

const base = { observerEnabled: true, configured: true, embedded: false } as const;

describe("resolveCapturePersistence", () => {
  it("enables capture for a split-process deployment with the observer on", () => {
    expect(resolveCapturePersistence(base)).toEqual({ enabled: true, reason: "ENABLED" });
  });

  it("disables capture whenever the observer is off, since nothing reads it", () => {
    expect(resolveCapturePersistence({ ...base, observerEnabled: false }))
      .toEqual({ enabled: false, reason: "OBSERVER_DISABLED" });
  });

  it("keeps the observer gate ahead of an explicit on override", () => {
    expect(resolveCapturePersistence({ ...base, observerEnabled: false, override: "on" }))
      .toEqual({ enabled: false, reason: "OBSERVER_DISABLED" });
  });

  it("defaults off on embedded PGlite, where one connection is shared", () => {
    expect(resolveCapturePersistence({ ...base, embedded: true }))
      .toEqual({ enabled: false, reason: "EMBEDDED_DEFAULT_OFF" });
  });

  it("allows an operator to force capture back on in embedded mode", () => {
    expect(resolveCapturePersistence({ ...base, embedded: true, override: "on" }))
      .toEqual({ enabled: true, reason: "FORCED_ON" });
  });

  it("honours the config flag when set to false", () => {
    expect(resolveCapturePersistence({ ...base, configured: false }))
      .toEqual({ enabled: false, reason: "CONFIG_DISABLED" });
  });

  it("lets an off override beat an enabled config", () => {
    expect(resolveCapturePersistence({ ...base, override: "off" }))
      .toEqual({ enabled: false, reason: "CONFIG_DISABLED" });
  });

  it("accepts the usual truthy and falsy override spellings", () => {
    for (const on of ["on", "1", "true", "TRUE", " On "]) {
      expect(resolveCapturePersistence({ ...base, embedded: true, override: on }).enabled).toBe(true);
    }
    for (const off of ["off", "0", "false", "FALSE", " Off "]) {
      expect(resolveCapturePersistence({ ...base, override: off }).enabled).toBe(false);
    }
  });

  it("ignores an unrecognized override rather than guessing", () => {
    expect(resolveCapturePersistence({ ...base, override: "maybe" }))
      .toEqual({ enabled: true, reason: "ENABLED" });
    expect(resolveCapturePersistence({ ...base, embedded: true, override: "maybe" }))
      .toEqual({ enabled: false, reason: "EMBEDDED_DEFAULT_OFF" });
  });
});
