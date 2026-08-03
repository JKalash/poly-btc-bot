# [Medium] Very-aggressive profile activation requires no server-side acknowledgement — the Risk-page typed ack is decorative

**Labels:** bug, risk-governance, api
**Severity:** Medium

## Summary

The spec requires a typed acknowledgement to activate the very-aggressive profile (`polymarket.fable:435, 798`; README: "requires a typed acknowledgement"). Enforcement exists only as client-side theater:

- `POST /api/config` (`apps/api/src/server.ts:304-328`) accepts `risk.profile: "very_aggressive"` with no acknowledgement field, no re-auth.
- `validateConfig` (`packages/config/src/index.ts:164-188`) has no acknowledgement path.
- The Risk page card (`apps/web/app/risk/page.tsx:149-160`) checks the typed phrase in React state and gates nothing — its own copy admits "activation still requires a config change", and that config change asks for nothing.
- Contrast: live *arming* does enforce its typed phrase server-side (`live.ts:86`) — the pattern exists, it just wasn't applied here.

## Failure scenario

Any authenticated `curl -X POST /api/config` (or a config edit from a second tab, or an automation script) activates the profile whose own description is "five full 10% losses ≈ 59% of capital remaining" without anyone ever typing the acknowledgement the spec mandates.

## Impact

The activation friction for the most dangerous built-in profile doesn't exist at the trust boundary; the UI implies a protection the server doesn't have.

## Suggested direction (not implemented)

Require an acknowledgement string (and re-auth, matching the arm flow) in the config API whenever the profile transitions **to** `very_aggressive`; record it in the config version's audit row.
