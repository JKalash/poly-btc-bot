# [Low] Spec-conformance rollup: promised capabilities absent and NOT listed in docs/limitations.md

**Labels:** spec-gap, documentation
**Severity:** Low (individually); filed as one rollup because the common defect is the limitations doc's completeness promise

## Summary

`docs/limitations.md` opens as the spec-mandated explicit list of what is stubbed or partial. These spec'd capabilities are absent **and missing from that list**, so the limitation doc's own contract ("explicit, per spec's final build step") is broken:

1. **Shadow-fill comparison** (`polymarket.fable:111`): shadow mode is supposed to compare would-submit orders against subsequent book activity. The engine records the intent and returns to OBSERVING (`engine.ts:706-711`); no hypothetical fill tracking exists. (limitations.md defers only shadow *wallet reads*.)
2. **Alerting** (`:1083-1087`): browser notifications, optional email/webhook, severity tiers, "critical alert for any live reconciliation mismatch" — none exist (no Notification API usage, no webhook/email adapter). Health events land in a DB table and a WS lamp only; an unattended live-armed deployment has no push path for critical events.
3. **Export** (`:1052-1053`): "Export any backtest or trade audit to JSON/CSV/Parquet" — no export endpoint or UI exists; all API routes are capped JSON list views.
4. **Timing-Lab / P&L analytics depth** (`:640-646, 809-823`): spread/depth/maker-fill-rate by bucket, calibration by price and seconds-remaining, realized EV by bucket after fee, rolling-window stability, P&L by strategy version / maker-taker / vol regime, Brier score, profit factor, UTC/local display toggle — none implemented (current: outcome rates + Wilson + corrections + quarter-hour comparison + drawdown/streaks).
5. **Dashboard sections** (`:760-772, 838-850`): market ladder with book + post-only price chooser, per-profile position-sizing card, "one loss erases N wins" cockpit card (present only in the tutorial), dedicated system-health page — absent.

## Impact

Individually feature gaps, not bugs; collectively they mean the "explicit limitations" doc materially understates what is unbuilt — the same failure mode as issue 003/067, applied to the rest of the spec surface. Anyone scoping production-readiness from limitations.md gets a rosier picture than the code supports.

## Suggested direction (not implemented)

Add each gap to docs/limitations.md (cheap, honest), and implement selectively as needed — the alerting gap (item 2) deserves priority if live arming is ever used unattended.
