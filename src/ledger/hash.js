import { createHash } from 'node:crypto';

// Every account has its own hash chain over its ledger entries: each entry
// stores the hash of the previous entry for that account (prev_hash) and its
// own hash, which covers prev_hash plus the facts of the entry. Changing or
// removing an old row breaks every hash after it, so tampering is detectable
// even by someone who can switch off the append-only triggers.
export const GENESIS_HASH = '0'.repeat(64);

export function entryHash(prevHash, entry) {
  const facts = [
    prevHash,
    entry.transactionId,
    entry.type,
    entry.initiatedBy,
    entry.accountId,
    entry.direction,
    entry.amount,
    entry.status,
    entry.balanceAfter,
  ].join('|');
  return createHash('sha256').update(facts).digest('hex');
}
