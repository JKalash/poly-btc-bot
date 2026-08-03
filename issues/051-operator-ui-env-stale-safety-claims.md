# [Medium] Operator-facing UI and .env.example still assert "no signing path exists" — on the same page as the live-arming card

**Labels:** bug, safety, web-ui
**Severity:** Medium (supplements issue 003, which covers README/limitations.md/execution.ts)

## Summary

Five additional operator-facing locations repeat the false "no signing path" claim — one of them rendered directly beneath the UI that arms real-money trading — and the canonical secrets template omits the two variables that enable real money.

## Locations

- `apps/web/app/risk/page.tsx:143-144` — "Live trading is disabled in this release regardless of profile: no signing path exists in the codebase." — rendered directly below `LiveArmingCard` (`:11-97`), which arms real-money trading.
- `apps/web/app/page.tsx:181` — "Live trading is disarmed. No signing path exists in this release."
- `apps/web/app/login/page.tsx:30` — same claim on the login screen.
- `.env.example:28-31` — "the adapter is a stub… No private key configuration exists"; omits `HOT_WALLET_PRIVATE_KEY` and the real `LIVE_TRADING_ENABLED === "1"` semantics (`apps/engine/src/live.ts:57-58`); also documents `NEXT_PUBLIC_API_BASE`, which is unused anywhere (grep-confirmed), while omitting `API_PROXY_TARGET`, the variable `next.config.mjs` actually reads (see issue 048); references `docs/live-trading-checklist.md` where the operative doc is `docs/live-trading.md`.
- `fly.toml:7` — "Paper system: no keys, no funds".

## Failure scenario

An operator on the Risk page reads the footnote, concludes the ARM card must be inert theater, types the acknowledgement "to see what happens" — and arms real trading. The UI actively teaches a false safety model at the exact decision point.

## Impact

Safety-claim contradiction at the point of maximum consequence; secrets template misdocuments the deployment surface.

## Suggested direction (not implemented)

Single source of truth for live-capability copy driven by `live.configured` from the API; fix `.env.example` to document the real variables with loud warnings.
