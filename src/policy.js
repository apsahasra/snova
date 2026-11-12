// EVERY authorisation decision about accounts and money is in this file.
// Routes and the ledger engine ask these functions; they never decide themselves.
//
// Roles:
//   admin   - operates the system: opens accounts for holders, pays external
//             deposits into any account, makes adjustments (with a reason),
//             freezes accounts. Cannot withdraw or transfer customers' money.
//   holder  - owns accounts. Can deposit into, withdraw from and transfer out
//             of their OWN accounts only. Can transfer to any active account.
//   auditor - read-only. Sees everything, can change nothing.
//
// `user` is always req.user, which the login middleware loaded from the
// database - never something the client sent.

const owns = (user, account) => account.kind === 'customer' && account.owner_id === user.id;

export function canViewAccount(user, account) {
  if (user.role === 'admin' || user.role === 'auditor') return true;
  return user.role === 'holder' && owns(user, account);
}

// May `user` open a new account that will belong to `ownerId`?
export function canOpenAccountFor(user, ownerId) {
  if (user.role === 'admin') return true;
  return user.role === 'holder' && ownerId === user.id;
}

// May `user` make this money movement? `from` and `to` are account rows that
// the engine has already locked. Returns true or false.
export function canMoveMoney(user, type, from, to) {
  switch (type) {
    // Money arriving from outside: external -> customer.
    case 'deposit':
      if (from.kind !== 'external' || to.kind !== 'customer') return false;
      return user.role === 'admin' || (user.role === 'holder' && owns(user, to));

    // Money leaving to outside: customer -> external. Only the owner.
    case 'withdrawal':
      if (from.kind !== 'customer' || to.kind !== 'external') return false;
      return user.role === 'holder' && owns(user, from);

    // Between two customer accounts. Only the owner of the SOURCE account.
    case 'transfer':
      if (from.kind !== 'customer' || to.kind !== 'customer') return false;
      return user.role === 'holder' && owns(user, from);

    // A correction against the external account, in either direction. Admin only.
    case 'adjustment':
      if ((from.kind === 'external') === (to.kind === 'external')) return false;
      return user.role === 'admin';

    default:
      return false;
  }
}
