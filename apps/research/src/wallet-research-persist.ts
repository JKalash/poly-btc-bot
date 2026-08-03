import { walletResearchSnapshots, type DbHandle } from "@b5p/db";
import type { WalletResearchSnapshot } from "@b5p/domain";

/**
 * Persist one wallet-research snapshot. Idempotent by construction: the id is
 * content-addressed over (wallet, window, records, marks, versions) — see
 * walletSnapshotId — so re-running the same input upserts the same row.
 * correlationId is set on first insert and never rewritten (persist.ts pattern).
 */
export async function persistWalletResearchSnapshot(
  handle: DbHandle,
  snapshot: WalletResearchSnapshot,
): Promise<{ id: string }> {
  const row = { ...snapshot };
  const { id: _id, correlationId: _corr, ...set } = row;
  await handle.db.insert(walletResearchSnapshots).values(row)
    .onConflictDoUpdate({ target: walletResearchSnapshots.id, set });
  return { id: snapshot.id };
}
