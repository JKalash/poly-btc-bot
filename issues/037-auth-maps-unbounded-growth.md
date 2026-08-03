# [Low] Auth service in-memory maps grow without bound: unredeemed WS tickets, expired sessions, login-attempt entries

**Labels:** bug, api, reliability
**Severity:** Low

## Summary

Three auth-service maps are pruned only on the happy path:
- WS tickets are deleted only when a redemption is attempted; tickets that are never redeemed (WS connect fails, tab closed) stay forever despite their 30s validity.
- Sessions are removed only if that exact token is validated after expiry; abandoned sessions persist.
- Per-IP login-attempt entries are never pruned.

## Locations

- `apps/api/src/auth.ts:124-138` (tickets), `:104-110` (sessions), `:74-83` (loginAttempts).

## Failure scenario

A dashboard left open for weeks with flaky connectivity re-fetches WS tickets on every reconnect attempt; each failed connect leaks one map entry in a long-lived API process (the same process hosting the embedded engine in dev/Fly mode).

## Impact

Slow memory leak only; expiry is still enforced at redemption, so there is no security effect.

## Suggested direction (not implemented)

Periodic sweep (or lazy sweep on insert) removing expired tickets/sessions/attempt records.
