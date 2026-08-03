# [Medium] `app.mode` in config is ignored — engine mode is fixed at construction from `ENGINE_MODE` env; `shadow` is unreachable

**Labels:** bug, config
**Severity:** Medium

## Summary

The engine's mode is decided **before** config is loaded, exclusively from the `ENGINE_MODE` env var, and only distinguishes `observe` vs `paper`. The validated config field `app.mode` (`observe | paper | shadow | live`) has no effect on the running engine, and `shadow` mode — which the state machine, presets (`presetAllowsMode`), snapshots and docs all support — cannot be reached through any configuration.

## Locations

- `apps/engine/src/main.ts:27` — `new Engine(db, bus, modeEnv === "observe" ? "observe" : "paper")`; the comment admits "env may force observe (read-only) only".
- `apps/engine/src/main.ts:29-32` — `cfgMode` is read but only logged for the observe case; `shadow`/`live` values are silently dropped.
- `apps/engine/src/engine.ts:76-79` — `mode` is a readonly constructor param; `loadConfig()`/`config_reload` never touch it.
- `packages/config/src/index.ts:18` — schema advertises `mode: z.enum(["observe", "paper", "shadow", "live"])`.

## Failure scenario

1. Operator edits the active config version to `app.mode: "shadow"` expecting would-submit-only behavior before going live (the documented validation step: `live.require_shadow_validation: true` implies shadow runs exist).
2. Engine keeps running in `paper` mode: it continues submitting simulated orders and mutating the paper bankroll; the config UI shows `shadow` while `cockpitState.mode` says `paper` — or worse, the operator doesn't notice the discrepancy and treats paper results as shadow validation.
3. Conversely `config_reload` (`engine.ts:182-186`) implies config is hot-reloadable, reinforcing the false expectation that mode follows config.

## Impact

- A validated, documented config knob silently does nothing; the shadow-validation prerequisite for live arming can't actually be exercised via config.
- `live.require_shadow_validation: z.literal(true)` is meaningless when shadow can't be enabled.

## Suggested direction (not implemented)

Honor `cfg.app.mode` at startup (env as override), or restrict the schema enum to what's actually supported and fail validation on `shadow`/`live` until implemented.
