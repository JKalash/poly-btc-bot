# Threat model

Scope: single-operator, localhost-bound research/paper system. No funds are at risk in this
release (no keys, no signing path). The model below covers both the current state and the
assumptions a future live adapter must not break.

| Threat | Current exposure | Mitigations |
|---|---|---|
| Browser compromise (XSS → API) | Dashboard can send API mutations | CSP headers, no inline event handlers from data, CSRF double-submit token on all mutations, HTTP-only session cookie, API bound to 127.0.0.1 |
| Stolen database | Research/paper data only | No secrets in DB by design; backups contain no key material because none exists |
| Malicious dependency | Real risk (npm supply chain) | Pinned exact versions + pnpm lockfile; small dependency surface (no heavy client SDKs); review before upgrading |
| Replayed order request | None live; paper orders idempotent | Idempotency keys derived from decision id; duplicate keys rejected by the risk engine and a unique DB index |
| Duplicated engine process | Double paper orders | Restart reconciliation cancels orphans; single-process embedded mode; documented single-engine invariant for split mode |
| Stale/lying feeds | Wrong decisions | Fail-closed staleness gates on every decision; price-to-beat continuity check; local-vs-official resolution cross-check halts the engine on mismatch |
| Operator error (fat-finger config) | Bad limits | Schema validation, absolute 10% cap in code + tests, versioned config with diffs and rollback data, typed acknowledgement for very-aggressive |
| Operator self-harm (tilt) | Aggressive settings | Consecutive-loss stops with no auto re-arm, session/daily stops, cooling-off support, ruin math displayed before activation |
| Credential theft from disk | Password hash only | scrypt (N=16384) hash in `.env`; no plaintext storage; sessions die on restart |
| Future: key theft | N/A now | Live checklist requires dedicated low-balance hot wallet + OS keychain/libsodium storage; keys must never enter the browser or logs |

## Pair subsystem boundary

The pair subsystem is counterfactual research/paper code with a structural no-live boundary.
Its public package and API contain no credential, private-key, signing, authenticated CLOB, or
on-chain transaction capability. Pair API routes are authenticated `GET` routes only, exact
economic values are emitted as decimal strings, and unknown records return bounded errors without
stack traces. All simulated effects use deterministic idempotency keys, a durable outbox/inbox,
observe-before-retry recovery, immutable event evidence, and startup reconciliation. Unknown
outcomes and reconciliation mismatches retain exposure and require review; they never become a
synthetic fill or profit. A shared database CAS guard is composed into pair group creation and the
real directional paper/live order-position lifecycle, preventing simultaneous directional and
pair ownership of one market. Unknown external acknowledgements retain conservative ownership
until reconciliation. Production pair scheduling remains disabled while the final atomic
facade/account/outbox lifecycle adapter is incomplete.
