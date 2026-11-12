// LedgerLine web client. It is only a convenience: every rule (who may do
// what, the zero floor, exactly-once) is enforced by the server. All text is
// put on the page with textContent, never innerHTML, so data cannot inject HTML.

// ---- small helpers ---------------------------------------------------------

const $ = (id) => document.getElementById(id);

// el('td', { class: 'num', text: '1.00' }, child1, child2)
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
}

// Paise (integer) -> "1,234.50". Uses integer maths only.
function money(paise) {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100).toLocaleString('en-IN');
  return `${sign}₹${rupees}.${String(abs % 100).padStart(2, '0')}`;
}

// "1234.5" -> 123450 paise, or null if it is not a valid amount. No floats.
function toPaise(text) {
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
}

const when = (iso) => new Date(iso).toLocaleString();

let toastTimer;
function toast(message, isError = false) {
  const box = $('toast');
  box.textContent = message;
  box.className = isError ? 'show error' : 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.className = ''; }, 5000);
}

// ---- talking to the server -------------------------------------------------

const session = {
  token: sessionStorage.getItem('token'),
  user: null,
};

async function api(method, path, body, idempotencyKey) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (session.token) headers.Authorization = `Bearer ${session.token}`;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && session.user) {
    logoutLocally();
    toast('Your session has ended. Please log in again.', true);
  }
  return { ok: response.ok, status: response.status, data, replayed: response.headers.get('Idempotent-Replay') === 'true' };
}

// A money form keeps ONE idempotency key until the server has answered. If the
// network fails or the user double-clicks, the retry carries the same key, so
// the server moves the money once. A new key is made only after an answer.
function moneyForm(title, fields, buildRequest, afterSuccess) {
  let key = crypto.randomUUID();
  const inputs = {};
  const button = el('button', { class: 'primary', type: 'submit', text: title });
  const form = el('form', {}, el('h3', { text: title }));
  for (const field of fields) {
    inputs[field.name] = field.options
      ? el('select', {}, ...field.options.map(([value, label]) => el('option', { value, text: label })))
      : el('input', { placeholder: field.placeholder || '', inputmode: field.inputmode || 'text' });
    form.append(el('label', { text: field.label }, inputs[field.name]));
  }
  form.append(button);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, input.value]));
    const request = buildRequest(values);
    if (typeof request === 'string') return toast(request, true);

    button.disabled = true;
    try {
      const result = await api('POST', request.path, request.body, key);
      key = crypto.randomUUID(); // the server answered: the next submit is a new request
      if (result.ok) {
        toast(result.replayed ? 'Already done earlier - nothing moved twice.' : `${title}: done.`);
        for (const input of Object.values(inputs)) if (input.tagName === 'INPUT') input.value = '';
      } else {
        toast(result.data.message || `Refused (${result.status})`, true);
      }
      await afterSuccess();
    } catch {
      toast('Network problem. Press the button again - it is safe, the same request will not be applied twice.', true);
    } finally {
      button.disabled = false;
    }
  });
  return el('div', { class: 'panel' }, form);
}

function amountOrError(text) {
  const paise = toPaise(text);
  return paise && paise > 0 ? paise : null;
}

// ---- login -----------------------------------------------------------------

function logoutLocally() {
  session.token = null;
  session.user = null;
  sessionStorage.removeItem('token');
  render();
}

function loginView() {
  const username = el('input', { autocomplete: 'username' });
  const password = el('input', { type: 'password', autocomplete: 'current-password' });

  async function submit(path) {
    const body = { username: username.value, password: password.value };
    if (path === '/api/auth/register') {
      const registered = await api('POST', path, body);
      if (!registered.ok) return toast(registered.data.message, true);
    }
    const result = await api('POST', '/api/auth/login', body);
    if (!result.ok) return toast(result.data.message || 'Login failed', true);
    session.token = result.data.token;
    session.user = result.data.user;
    sessionStorage.setItem('token', session.token);
    render();
  }

  const form = el('form', {},
    el('h2', { text: 'Log in' }),
    el('label', { text: 'Username' }, username),
    el('label', { text: 'Password' }, password),
    el('button', { class: 'primary', type: 'submit', text: 'Log in' }),
    el('button', { type: 'button', text: 'Register as a new account holder', onclick: () => submit('/api/auth/register') }),
    el('p', { class: 'muted', text: 'Demo users for each role are listed in the README.' }),
  );
  form.addEventListener('submit', (event) => { event.preventDefault(); submit('/api/auth/login'); });
  return el('div', { class: 'panel' }, form);
}

// ---- tables ----------------------------------------------------------------

function table(headers, rows) {
  const head = el('tr', {}, ...headers.map((h) => el('th', { class: h.num ? 'num' : '', text: h.label })));
  const body = rows.map((row) =>
    el('tr', { class: row.refused ? 'refused' : '' },
      ...row.cells.map((cell, i) => {
        const td = el('td', { class: headers[i].num ? 'num' : '' });
        if (cell instanceof Node) td.append(cell); else td.textContent = cell ?? '';
        return td;
      })));
  if (rows.length === 0) body.push(el('tr', {}, el('td', { colspan: String(headers.length), class: 'muted', text: 'Nothing here yet.' })));
  return el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, head), el('tbody', {}, ...body)));
}

function statementTable(entries) {
  return table(
    [{ label: 'When' }, { label: 'Type' }, { label: 'Result' }, { label: 'Debit', num: true }, { label: 'Credit', num: true },
      { label: 'Balance after', num: true }, { label: 'Other account' }, { label: 'Initiated by' }, { label: 'Note' }],
    entries.map((e) => ({
      refused: e.status === 'refused',
      cells: [
        when(e.created_at), e.type,
        e.status === 'refused' ? `REFUSED: ${e.refusal_reason}` : 'posted',
        e.direction === 'debit' ? money(e.amount) : '',
        e.direction === 'credit' ? money(e.amount) : '',
        money(e.balance_after),
        e.other_account_id === 1000 ? 'external' : String(e.other_account_id),
        e.initiated_by, e.memo,
      ],
    })),
  );
}

function transactionTable(transactions) {
  return table(
    [{ label: 'Id' }, { label: 'When' }, { label: 'Type' }, { label: 'Result' }, { label: 'Amount', num: true },
      { label: 'From' }, { label: 'To' }, { label: 'Initiated by' }, { label: 'Note' }],
    transactions.map((t) => ({
      refused: t.status === 'refused',
      cells: [String(t.id), when(t.created_at), t.type, t.status === 'refused' ? `REFUSED: ${t.refusal_reason}` : 'posted',
        money(t.amount), String(t.from_account_id), String(t.to_account_id), t.initiated_by, t.memo],
    })),
  );
}

function eventTable(events) {
  return table(
    [{ label: 'When' }, { label: 'Action' }, { label: 'Who' }, { label: 'Detail' }],
    events.map((e) => ({ cells: [when(e.created_at), e.action, e.actor || '-', JSON.stringify(e.detail)] })),
  );
}

// ---- accounts tab (all roles) ----------------------------------------------

let selectedAccountId = null;

async function accountsView() {
  const root = el('div');
  const role = session.user.role;
  const { data } = await api('GET', '/api/accounts');
  const accounts = data.accounts || [];
  if (!accounts.some((a) => a.id === selectedAccountId)) {
    selectedAccountId = accounts.find((a) => a.kind === 'customer')?.id ?? null;
  }
  const refresh = () => showTab('Accounts');

  const cards = accounts.map((account) =>
    el('div', {
      class: `panel account-card${account.id === selectedAccountId ? ' selected' : ''}`,
      onclick: () => { selectedAccountId = account.id; refresh(); },
    },
    el('div', { class: 'muted', text: `Account ${account.id}${account.owner ? ` - ${account.owner}` : ''}` }),
    el('div', { text: account.name }),
    el('div', { class: 'balance', text: money(account.balance) }),
    account.status === 'frozen' ? el('span', { class: 'tag bad', text: 'frozen' }) : null));
  root.append(el('div', { class: 'grid' }, ...cards));
  if (accounts.length === 0) root.append(el('p', { class: 'muted', text: 'You have no accounts yet. Open one below.' }));

  const forms = el('div', { class: 'grid' });
  if (role === 'holder') {
    const mine = accounts.map((a) => [String(a.id), `${a.id} - ${a.name}`]);
    forms.append(moneyForm('Open account', [{ name: 'name', label: 'Account name', placeholder: 'Savings' }],
      (v) => (v.name.trim() ? { path: '/api/accounts', body: { name: v.name.trim() } } : 'Enter a name'), refresh));
    if (mine.length > 0) {
      forms.append(
        moneyForm('Deposit', [{ name: 'account', label: 'Into', options: mine }, { name: 'amount', label: 'Amount (rupees)', inputmode: 'decimal' }],
          (v) => { const amount = amountOrError(v.amount); return amount ? { path: `/api/accounts/${v.account}/deposit`, body: { amount } } : 'Enter an amount like 250 or 250.50'; }, refresh),
        moneyForm('Withdraw', [{ name: 'account', label: 'From', options: mine }, { name: 'amount', label: 'Amount (rupees)', inputmode: 'decimal' }],
          (v) => { const amount = amountOrError(v.amount); return amount ? { path: `/api/accounts/${v.account}/withdraw`, body: { amount } } : 'Enter an amount like 250 or 250.50'; }, refresh),
        moneyForm('Transfer', [{ name: 'from', label: 'From', options: mine }, { name: 'to', label: 'To account number', inputmode: 'numeric' },
          { name: 'amount', label: 'Amount (rupees)', inputmode: 'decimal' }, { name: 'memo', label: 'Note (optional)' }],
        (v) => {
          const amount = amountOrError(v.amount);
          if (!amount) return 'Enter an amount like 250 or 250.50';
          if (!/^\d+$/.test(v.to.trim())) return 'Enter the destination account number';
          return { path: '/api/transfers', body: { from_account_id: Number(v.from), to_account_id: Number(v.to), amount, memo: v.memo.trim() || undefined } };
        }, refresh));
    }
  }
  root.append(forms);

  if (selectedAccountId) {
    const statement = await api('GET', `/api/accounts/${selectedAccountId}/statement?limit=200`);
    root.append(el('div', { class: 'panel' },
      el('h2', { text: `Statement - account ${selectedAccountId}` }),
      el('p', { class: 'muted', text: 'Newest first. Refused attempts are highlighted; they did not change the balance.' }),
      statementTable(statement.data.entries || [])));
  }
  return root;
}

// ---- admin tab ---------------------------------------------------------------

async function adminView() {
  const refresh = () => showTab('Admin');
  const [{ data: accountData }, { data: userData }] = await Promise.all([api('GET', '/api/accounts'), api('GET', '/api/admin/users')]);
  const customers = (accountData.accounts || []).filter((a) => a.kind === 'customer');
  const accountOptions = customers.map((a) => [String(a.id), `${a.id} - ${a.owner} - ${a.name}`]);
  const holders = (userData.users || []).filter((u) => u.role === 'holder').map((u) => [String(u.id), u.username]);
  const amountField = { name: 'amount', label: 'Amount (rupees)', inputmode: 'decimal' };

  const freezeButton = (account) => el('button', {
    text: account.status === 'frozen' ? 'Unfreeze' : 'Freeze',
    onclick: async () => {
      const action = account.status === 'frozen' ? 'unfreeze' : 'freeze';
      const result = await api('POST', `/api/admin/accounts/${account.id}/${action}`);
      toast(result.ok ? `Account ${account.id}: ${action} done.` : result.data.message, !result.ok);
      refresh();
    },
  });

  return el('div', {},
    el('div', { class: 'grid' },
      moneyForm('Deposit into an account', [{ name: 'account', label: 'Account', options: accountOptions }, amountField],
        (v) => { const amount = amountOrError(v.amount); return amount && v.account ? { path: `/api/accounts/${v.account}/deposit`, body: { amount } } : 'Choose an account and enter an amount'; }, refresh),
      moneyForm('Adjustment', [{ name: 'account', label: 'Account', options: accountOptions },
        { name: 'direction', label: 'Direction', options: [['credit', 'Credit (add)'], ['debit', 'Debit (remove)']] }, amountField,
        { name: 'reason', label: 'Reason (required, shown to the auditor)' }],
      (v) => {
        const amount = amountOrError(v.amount);
        if (!amount || !v.account) return 'Choose an account and enter an amount';
        if (!v.reason.trim()) return 'A reason is required';
        return { path: '/api/admin/adjustments', body: { account_id: Number(v.account), direction: v.direction, amount, reason: v.reason.trim() } };
      }, refresh),
      moneyForm('Open account for a holder', [{ name: 'owner', label: 'Holder', options: holders }, { name: 'name', label: 'Account name' }],
        (v) => (v.name.trim() && v.owner ? { path: '/api/accounts', body: { name: v.name.trim(), owner_id: Number(v.owner) } } : 'Choose a holder and enter a name'), refresh),
      moneyForm('Create user', [{ name: 'username', label: 'Username' }, { name: 'password', label: 'Password (8+ characters)' },
        { name: 'role', label: 'Role', options: [['holder', 'holder'], ['auditor', 'auditor'], ['admin', 'admin']] }],
      (v) => ({ path: '/api/admin/users', body: { username: v.username, password: v.password, role: v.role } }), refresh)),
    el('div', { class: 'panel' }, el('h2', { text: 'All accounts' }),
      table([{ label: 'Account' }, { label: 'Owner' }, { label: 'Name' }, { label: 'Status' }, { label: 'Balance', num: true }, { label: '' }],
        customers.map((a) => ({ cells: [String(a.id), a.owner, a.name, a.status, money(a.balance), freezeButton(a)] })))),
    el('div', { class: 'panel' }, el('h2', { text: 'Users' }),
      table([{ label: 'Id' }, { label: 'Username' }, { label: 'Role' }, { label: 'Active' }],
        (userData.users || []).map((u) => ({ cells: [String(u.id), u.username, u.role, u.is_active ? 'yes' : 'no'] })))));
}

// ---- audit tab (admin and auditor) -------------------------------------------

async function auditView() {
  const [verify, flags, transactions, events] = await Promise.all([
    api('GET', '/api/audit/verify'), api('GET', '/api/audit/flags'),
    api('GET', '/api/audit/transactions?limit=100'), api('GET', '/api/audit/events?limit=100'),
  ]);
  const v = verify.data;
  const f = flags.data;

  return el('div', {},
    el('div', { class: 'panel' },
      el('h2', { text: 'Ledger integrity' }),
      el('p', { class: v.ok ? 'good' : 'bad', text: v.ok ? 'PASS - the books balance and no ledger row has been altered.' : 'FAIL - see problems below.' }),
      el('p', { class: 'muted', text: `Checked ${v.checked?.accounts} accounts and ${v.checked?.entries} entries. Sum of all balances (customers + external): ${v.sum_of_all_balances}. It must be 0.` }),
      el('pre', { text: (v.problems || []).join('\n') })),
    el('div', { class: 'panel' }, el('h2', { text: 'Flag: unauthorised attempts' }), transactionTable(f.unauthorised_attempts || [])),
    el('div', { class: 'panel' }, el('h2', { text: 'Flag: admin adjustments' }), transactionTable(f.adjustments || [])),
    el('div', { class: 'panel' }, el('h2', { text: 'Flag: large movements (Rs 1,00,000 and above)' }), transactionTable(f.large_movements || [])),
    el('div', { class: 'panel' }, el('h2', { text: 'Flag: duplicate requests (replayed, not applied twice)' }), eventTable(f.replayed_requests || [])),
    el('div', { class: 'panel' }, el('h2', { text: 'Flag: idempotency key reused for a different request' }), eventTable(f.key_mismatches || [])),
    el('div', { class: 'panel' }, el('h2', { text: 'Flag: failed logins' }), eventTable(f.failed_logins || [])),
    el('div', { class: 'panel' }, el('h2', { text: 'All transactions (latest 100)' }), transactionTable(transactions.data.transactions || [])),
    el('div', { class: 'panel' }, el('h2', { text: 'Audit events (latest 100)' }), eventTable(events.data.events || [])));
}

// ---- page shell ----------------------------------------------------------------

const TABS = {
  Accounts: { roles: ['admin', 'holder', 'auditor'], view: accountsView },
  Admin: { roles: ['admin'], view: adminView },
  Audit: { roles: ['admin', 'auditor'], view: auditView },
};
let currentTab = 'Accounts';

async function showTab(name) {
  currentTab = name;
  const tabs = Object.entries(TABS).filter(([, tab]) => tab.roles.includes(session.user.role));
  $('tabs').replaceChildren(...tabs.map(([tabName]) =>
    el('button', { class: tabName === name ? 'active' : '', text: tabName, onclick: () => showTab(tabName) })));
  try {
    const view = await TABS[name].view();
    if (session.user && currentTab === name) $('main').replaceChildren(view);
  } catch {
    toast('Could not load this page. Check your connection and try again.', true);
  }
}

async function render() {
  if (session.token && !session.user) {
    const me = await api('GET', '/api/auth/me').catch(() => null);
    if (me?.ok) session.user = me.data.user;
    else { session.token = null; sessionStorage.removeItem('token'); }
  }
  if (!session.user) {
    $('who').replaceChildren();
    $('tabs').replaceChildren();
    $('main').replaceChildren(loginView());
    return;
  }
  $('who').replaceChildren(
    el('span', { text: `${session.user.username} (${session.user.role})` }),
    el('button', { text: 'Log out', onclick: async () => { await api('POST', '/api/auth/logout').catch(() => {}); logoutLocally(); } }));
  currentTab = 'Accounts';
  showTab(currentTab);
}

render();
