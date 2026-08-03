# [Low] Playwright smoke test cannot pass: login inputs have no label association for `getByLabel`

**Labels:** bug, tests, accessibility
**Severity:** Low

## Summary

The e2e smoke test locates the login fields with `page.getByLabel(/username/i)`, but the login form's `<label>` elements have no `htmlFor`/`id` association, don't wrap their inputs, and the inputs carry no `aria-label`. `getByLabel` therefore resolves to nothing and the first step times out — the repo's only e2e test (login → cockpit → timing lab → emergency-stop visibility) is permanently red or never run. The same missing association makes the login form inaccessible to screen readers.

## Locations

- `apps/web/e2e/smoke.spec.ts:5-6`.
- `apps/web/app/login/page.tsx:31-36`.

## Impact

Advertised e2e coverage does not exist; anything it would have caught (including several staged UI issues) ships unverified.

## Suggested direction (not implemented)

Add `htmlFor`/`id` pairs (fixes both the test and accessibility); run the smoke test in CI.
