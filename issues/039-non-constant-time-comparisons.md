# [Low] Non-constant-time comparisons for session HMAC and CSRF token

**Labels:** bug, security, defense-in-depth
**Severity:** Low (exploitability negligible in this deployment model)

## Summary

`timingSafeEqual` is correctly used for password verification, but plain `!==` compares the session-token HMAC signature and the CSRF header.

## Locations

- `apps/api/src/auth.ts:103` — `this.sign(raw) !== sig`.
- `apps/api/src/server.ts:53` — `header !== s.csrfToken`.

## Exploitability assessment (why Low)

Forging the HMAC is useless without a valid 256-bit random `raw` that exists in the in-memory session map, and the API binds to 127.0.0.1 by default — so the timing oracle has no practical target. This is a defense-in-depth gap, not a live vulnerability.

## Impact

Textbook hardening miss in an auth file that otherwise gets the details right (random salt, timingSafeEqual on scrypt digest, one-time WS tickets).

## Suggested direction (not implemented)

Use `crypto.timingSafeEqual` (length-guarded) for both comparisons.
