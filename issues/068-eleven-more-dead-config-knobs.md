# [Medium] Eleven more config knobs with zero runtime consumers (beyond those already filed)

**Labels:** bug, config, spec-gap
**Severity:** Medium (several are safety/realism knobs)

## Summary

Grep-verified dead fields (definition sites only), excluding those already filed (001 calibration, 009 app.mode, 014 min EV, 022/023 parsing/bounds, 065 profile-ignored limits):

| Field | Spec promise | Reality |
|---|---|---|
| `paper.adverse_selection_penalty` | simulate adverse selection (fable:949, :102) | conservative queue model exists but this flag switches nothing |
| `paper.partial_fill_model` (:948) | toggle partial fills | unconditionally on |
| `paper.current_fee_schedule` (:950) | — | never read |
| `execution.permit_partial_fills` (:940) | — | never read |
| `execution.time_in_force` (:938) | GTC/GTD selection | paper hardcodes GTD (`paper.ts:127`); live derives TIF from expiry presence (`live.ts:186`) |
| `execution.reconcile_after_every_fill` (:943) | per-fill reconciliation | no such reconciliation exists anywhere |
| `strategy.maker_only` (:915) | maker-only enforcement | only `allow_taker` is consulted (`engine.ts:587`) |
| `strategy.volatility_model` (:918) | `empirical_ewma` vs `sqrt_time` | estimator always EWMA×√t (`features.ts:100-106`) |
| `market.duration_seconds` (:889) | window length | 300s hardcoded in slot math (`main.ts:76`) |
| `feeds.binance.required` (:898) | Binance staleness gates entries | nothing gates on it; only the health lamp uses `max_age_ms` |
| `research.rolling_windows_days` (:961) | rolling stats windows | Timing-Lab refresh hardcodes `[7, 14, 30]` (`server.ts:278`); configured 60/90-day windows never computed |

(Also decorative in the safe direction: `app.bind_host`, `app.require_auth`, `live.kill_switch_hotkey`, `research.multiple_testing_correction`.)

## Impact

A documented configuration surface that promises behavior and silently delivers none. `feeds.binance.required: true` is the sharpest: an operator relying on Binance confirmation as an entry requirement gets no such gate.

## Suggested direction (not implemented)

For each: implement, or remove from the schema so validation honestly reflects the supported surface. A CI check that every config field has ≥1 non-definition reference would prevent recurrence.
