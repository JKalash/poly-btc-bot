# [Medium] `feedHealth` reports the age of the first book ever inserted, not the active market's books

**Labels:** bug, telemetry
**Severity:** Medium

## Summary

`Engine.feedHealth()` computes the CLOB book age from `[...this.books.values()][0]` — Map insertion order means this is the **first token's book ever created since process start**, typically an expired market whose feed stopped updating. The cockpit's CLOB lamp (and the `feedHealth` block stored in every decision snapshot) therefore shows a permanently red/ancient book age even while the active market's book is milliseconds old.

## Locations

- `apps/engine/src/engine.ts:875-889`:
  ```ts
  const anyBook = [...this.books.values()][0] ?? null;
  ...
  clob_book: { ageMs: bookAge, healthy: bookAge !== null && bookAge <= this.cfg.feeds.clob.max_book_age_ms * 10 },
  ```
- `this.books` is only ever added to (`bookFor`, `engine.ts:238-242`); entries for expired markets are never removed, so the first entry goes permanently stale after the first 5-minute window rotates.
- Related mislabel: the decision snapshot's DOWN-book block reuses the UP book's age — `apps/engine/src/snapshot.ts:97` (`ageMs: f.bookAgeMs`) and `packages/strategy/src/features.ts:117` (`bookAgeMs` = `upBook.ageMs` only).

## Failure scenario (observed)

After the first market window expires (~5 minutes after boot), the cockpit CLOB-age badge goes red and stays red for the life of the process, while actual decision-time book age (checked per-side in the risk gate) was 23 ms. Operators learn to ignore a red safety lamp — alarm fatigue on exactly the signal that should be trusted.

## Impact

- Cockpit health is wrong within minutes of boot; decision snapshots permanently embed a misleading `feedHealth.clob_book`.
- The real per-side book age *is* correctly gated at decision time (`riskCtx.bookAgeMs` uses the chosen side's book), so this is a telemetry/audit defect, not an order-safety defect — but it poisons the audit record and the operator's trust.

## Suggested direction (not implemented)

Compute `clob_book` health from the active market's UP and DOWN books (worst of the two), and/or prune `books` entries when markets expire (see issue 010 on unbounded maps). Give the snapshot's DOWN block its own age.
