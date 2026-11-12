// Proves the books from the raw ledger rows. Used by GET /api/audit/verify.
//
// It recomputes everything instead of trusting stored totals:
//   1. the sum of ALL account balances (customers + external) is exactly 0
//   2. every posted transaction has one debit and one credit of the same amount
//   3. for every account: replaying its entries gives each row's balance_after
//      and ends at the stored balance; no customer balance is negative
//   4. for every account: the hash chain is unbroken (no row edited or removed)
//
// It reads the whole ledger, which is fine at this size; a large system would
// verify incrementally from a checkpoint.
import { query } from '../db.js';
import { entryHash, GENESIS_HASH } from './hash.js';

const MAX_PROBLEMS = 50;

export async function verifyLedger() {
  const problems = [];
  const report = (problem) => {
    if (problems.length < MAX_PROBLEMS) problems.push(problem);
  };

  const accounts = (await query('SELECT id, kind, balance FROM accounts ORDER BY id')).rows;
  const entries = (
    await query(
      `SELECT e.id, e.transaction_id, e.account_id, e.direction, e.amount, e.status,
              e.balance_after, e.prev_hash, e.hash, t.type, t.initiated_by
         FROM entries e JOIN transactions t ON t.id = e.transaction_id
        ORDER BY e.account_id, e.id`,
    )
  ).rows;

  // 1. conservation
  const total = accounts.reduce((sum, account) => sum + account.balance, 0);
  if (total !== 0) report(`sum of all balances is ${total}, expected 0`);

  // 2. double entry
  const unbalanced = await query(
    `SELECT t.id FROM transactions t LEFT JOIN entries e ON e.transaction_id = t.id AND e.status = 'posted'
      WHERE t.status = 'posted'
      GROUP BY t.id, t.amount
     HAVING count(*) FILTER (WHERE e.direction = 'debit' AND e.amount = t.amount) <> 1
         OR count(*) FILTER (WHERE e.direction = 'credit' AND e.amount = t.amount) <> 1
         OR count(e.id) <> 2`,
  );
  for (const row of unbalanced.rows) report(`transaction ${row.id} is not one matching debit and credit`);

  // 3 and 4. replay every account
  const byAccount = new Map(accounts.map((account) => [account.id, []]));
  for (const entry of entries) byAccount.get(entry.account_id)?.push(entry);

  for (const account of accounts) {
    let running = 0;
    let prevHash = GENESIS_HASH;
    for (const entry of byAccount.get(account.id)) {
      if (entry.status === 'posted') running += entry.direction === 'credit' ? entry.amount : -entry.amount;
      if (entry.balance_after !== running) {
        report(`account ${account.id}: entry ${entry.id} shows balance ${entry.balance_after}, replay gives ${running}`);
      }
      const expectedHash = entryHash(prevHash, {
        transactionId: entry.transaction_id,
        type: entry.type,
        initiatedBy: entry.initiated_by,
        accountId: entry.account_id,
        direction: entry.direction,
        amount: entry.amount,
        status: entry.status,
        balanceAfter: entry.balance_after,
      });
      if (entry.prev_hash !== prevHash || entry.hash !== expectedHash) {
        report(`account ${account.id}: hash chain broken at entry ${entry.id}`);
      }
      prevHash = entry.hash;
    }
    if (running !== account.balance) {
      report(`account ${account.id}: stored balance ${account.balance}, entries add up to ${running}`);
    }
    if (account.kind === 'customer' && account.balance < 0) report(`account ${account.id}: negative balance`);
  }

  return {
    ok: problems.length === 0,
    checked: { accounts: accounts.length, entries: entries.length },
    sum_of_all_balances: total,
    problems,
  };
}
