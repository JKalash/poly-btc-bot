# [Medium] Config schema is non-strict: unknown keys are silently stripped, so a typo'd field silently reverts to its default

**Labels:** bug, config
**Severity:** Medium

## Summary

No object in `AppConfigSchema` uses `.strict()`. Zod's default object mode **strips** unrecognized keys, so a typo'd field name passes validation with the typo dropped and the real field back at its default — no error, no warning. The API then persists a config version the operator did not intend.

## Locations

- `packages/config/src/index.ts:14-145` — all objects use default (strip) mode.
- Consumer: `apps/api/src/server.ts:304-321` — `POST /api/config` validates and persists.

## Failure scenario

Operator edits config JSON, typos `consecutve_loss_limit: 10` (or `alow_taker: true`, or `paper_entry_cutoff_secondss: 5`). `validateConfig` returns `ok: true`; the real `consecutive_loss_limit` silently reverts to default `2`. The only trace is the diff list *if* the operator notices the unexpected reversion entry. In the safety-critical direction (e.g., typo'd `session_loss_limit` reverting from a tightened value to the looser default), risk limits silently loosen.

## Impact

Silent misconfiguration in the safety-critical config path; violates the package's stated purpose ("zod schema, validation").

## Suggested direction (not implemented)

Use `.strict()` on all config objects (or `z.strictObject`) so unknown keys are validation errors surfaced to the operator.
