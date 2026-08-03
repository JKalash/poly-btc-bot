# [Medium] Emergency-stop (and resume/refresh) UI swallows failures — the dialog closes as if the stop succeeded

**Labels:** bug, web-ui, safety
**Severity:** Medium

## Summary

The kill-switch confirmation flow has `try { await api(...) } finally { setBusy(false); setConfirming(false); }` — no `catch`, no error state. If the POST fails (API down, network error, CSRF 403, session expired), the rejection is discarded (`void fire()`) and the modal simply closes — indistinguishable from a successful emergency stop.

## Locations

- `apps/web/components/Shell.tsx:68-76` — `fire()` for EMERGENCY STOP.
- `apps/web/app/audit/page.tsx:20-23` — `resume` has the same pattern.
- `apps/web/app/timing-lab/page.tsx:36-44` — `refresh` likewise.
- Contrast: login/config/arm pages all surface errors properly.

## Failure scenario

The API process is hung or restarting during a bad market. The operator hits EMERGENCY STOP; the dialog closes; the operator walks away believing trading is halted. Nothing happened, and nothing on screen says so. (Stacks with issue 027 — where the API itself returns success without the engine hearing the kill — and issue 011.)

## Impact

Silent failure of the operator's last-resort control, in the exact scenario (unhealthy system) where it's most likely to be used.

## Suggested direction (not implemented)

Catch and render failures prominently (keep the dialog open with a red error), and consider requiring a state-change confirmation (engine reports HALTED via `/api/state`) before showing success.
