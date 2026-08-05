/**
 * Whether full pair-envelope capture may be persisted at all.
 *
 * Capture exists for exactly one consumer: strict observer evaluation, which
 * is released only once an envelope's boundary row commits (§12.6). When the
 * observer is disabled that persistence has no reader, so writing it is pure
 * cost — and on the embedded single-connection PGlite database that cost is
 * paid out of the same connection the API, engine loop and decision path use.
 * A CLOB feed running at a few hundred envelopes per second will monopolize
 * it, which is what took the 22:46Z image into CONTINUITY_UNHEALTHY.
 *
 * Turning capture off therefore also stops the pair observer. That is the
 * intended trade: the directional engine, decisions and dashboard keep
 * running. Re-enable it deliberately once the write path is known to keep up.
 */
export type CapturePersistenceDecision = {
  readonly enabled: boolean;
  readonly reason:
    | "OBSERVER_DISABLED"
    | "EMBEDDED_DEFAULT_OFF"
    | "CONFIG_DISABLED"
    | "FORCED_ON"
    | "ENABLED";
};

export interface ResolveCapturePersistenceInput {
  /** pair.observer_enabled from the validated config. */
  readonly observerEnabled: boolean;
  /** pair.capture_persistence_enabled from the validated config. */
  readonly configured: boolean;
  /** True when engine and API share one process (and one PGlite connection). */
  readonly embedded: boolean;
  /** PAIR_CAPTURE_PERSISTENCE env override: "on" | "off" | undefined. */
  readonly override?: string | undefined;
}

/**
 * Precedence: observer gate, then explicit env override, then config, then the
 * embedded default. The observer gate is first and unconditional — an override
 * must not be able to resurrect writes nothing will ever read.
 */
export function resolveCapturePersistence(input: ResolveCapturePersistenceInput): CapturePersistenceDecision {
  if (!input.observerEnabled) return Object.freeze({ enabled: false, reason: "OBSERVER_DISABLED" as const });

  const override = input.override?.trim().toLowerCase();
  if (override === "off" || override === "0" || override === "false") {
    return Object.freeze({ enabled: false, reason: "CONFIG_DISABLED" as const });
  }
  if (override === "on" || override === "1" || override === "true") {
    return Object.freeze({ enabled: true, reason: "FORCED_ON" as const });
  }

  if (!input.configured) return Object.freeze({ enabled: false, reason: "CONFIG_DISABLED" as const });
  if (input.embedded) return Object.freeze({ enabled: false, reason: "EMBEDDED_DEFAULT_OFF" as const });
  return Object.freeze({ enabled: true, reason: "ENABLED" as const });
}
