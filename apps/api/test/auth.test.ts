import { describe, expect, it } from "vitest";
import { AuthService, timingSafeStringEqual } from "../src/auth";

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

describe("remembered sessions", () => {
  it("survives a fresh auth service when the session secret is stable", async () => {
    const passwordHash = await AuthService.hashPassword("test-password-123");
    const first = new AuthService({
      OPERATOR_USERNAME: "operator",
      OPERATOR_PASSWORD_HASH: passwordHash,
      SESSION_SECRET: "stable-test-secret",
    } as NodeJS.ProcessEnv);
    const loggedIn = await first.login("operator", "test-password-123", true);
    expect(loggedIn).not.toBeNull();

    const afterRestart = new AuthService({
      OPERATOR_USERNAME: "operator",
      OPERATOR_PASSWORD_HASH: passwordHash,
      SESSION_SECRET: "stable-test-secret",
    } as NodeJS.ProcessEnv);
    expect(afterRestart.validate(loggedIn!.token)).toMatchObject({
      username: "operator",
      csrfToken: loggedIn!.csrfToken,
    });
  });

  it("keeps non-remembered sessions process-local", async () => {
    const passwordHash = await AuthService.hashPassword("test-password-123");
    const first = new AuthService({
      OPERATOR_USERNAME: "operator",
      OPERATOR_PASSWORD_HASH: passwordHash,
      SESSION_SECRET: "stable-test-secret",
    } as NodeJS.ProcessEnv);
    const loggedIn = await first.login("operator", "test-password-123", false);
    expect(loggedIn).not.toBeNull();
    expect(first.validate(loggedIn!.token)).not.toBeNull();

    const afterRestart = new AuthService({
      OPERATOR_USERNAME: "operator",
      OPERATOR_PASSWORD_HASH: passwordHash,
      SESSION_SECRET: "stable-test-secret",
    } as NodeJS.ProcessEnv);
    expect(afterRestart.validate(loggedIn!.token)).toBeNull();
  });
});
