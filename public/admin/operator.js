/**
 * The operator page.
 *
 * One token, three questions: how much is stored, who has a vault, and which codes are still worth something. The
 * token is kept in this tab's session storage and nowhere else — it is a secret that can spend slots, so it does not
 * belong in the vault, in localStorage, or in a URL.
 */

const TOKEN_KEY = 'bookmarks-operator-token';
const API = '/w/bookmarks/api/admin';

const tokenField = document.querySelector('#token');
const gate = document.querySelector('#gate');
const gateStatus = document.querySelector('#gate-status');
const panel = document.querySelector('#panel');
const errorLine = document.querySelector('#error');

const figureAccounts = document.querySelector('#figure-accounts');
const figureMax = document.querySelector('#figure-max');
const figureBytes = document.querySelector('#figure-bytes');
const figureCodes = document.querySelector('#figure-codes');

const capForm = document.querySelector('#cap-form');
const capField = document.querySelector('#cap');
const mintForm = document.querySelector('#mint-form');
const mintCount = document.querySelector('#mint-count');
const mintDays = document.querySelector('#mint-days');
const minted = document.querySelector('#minted');
const mintedList = document.querySelector('#minted-list');
const accountsBody = document.querySelector('#accounts');
const accountsEmpty = document.querySelector('#accounts-empty');
const invitesBody = document.querySelector('#invites');
const invitesEmpty = document.querySelector('#invites-empty');

let token = '';

/** A short, local formatting of a stamp; the page is not a report and does not need a timezone widget. */
function when(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function size(bytes) {
  const count = Number(bytes) || 0;
  if (count <= 0) return '—';
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`;
  return `${(count / (1024 * 1024)).toFixed(2)} MB`;
}

function cell(text, className) {
  const node = document.createElement('td');
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function showError(message) {
  errorLine.textContent = message;
  errorLine.hidden = message === '';
}

async function call(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(options.headers ?? {})
    }
  });

  if (response.status === 401) throw new Error('That token is not this server’s token.');
  if (response.status === 404) throw new Error('This server has no admin token configured.');

  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ? `${body.error}` : 'The server refused that.');

  return body;
}

function renderAccounts(accounts) {
  accountsBody.replaceChildren();
  accountsEmpty.hidden = accounts.length > 0;

  for (const account of accounts) {
    const row = document.createElement('tr');
    row.append(
      cell(account.id, 'operator-states'),
      cell(size(account.bytes), 'operator-states'),
      cell(String(account.version ?? '—'), 'operator-states'),
      cell(String(account.sessions ?? '—'), 'operator-states'),
      cell(when(account.updatedAt)),
      cell(when(account.createdAt))
    );
    accountsBody.append(row);
  }
}

function renderInvites(invites) {
  invitesBody.replaceChildren();
  invitesEmpty.hidden = invites.length > 0;

  for (const invite of invites) {
    const row = document.createElement('tr');
    const state = document.createElement('span');
    state.className = 'operator-chip';
    state.dataset.state = invite.state;
    state.textContent = invite.state;

    const stateCell = document.createElement('td');
    stateCell.append(state);

    const actionCell = document.createElement('td');
    if (invite.state === 'live') {
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'button button-quiet';
      revoke.textContent = 'Revoke';
      revoke.addEventListener('click', async () => {
        revoke.disabled = true;
        try {
          await call('/invites/revoke', { method: 'POST', body: JSON.stringify({ id: invite.id }) });
          await load();
        } catch (error) {
          showError(error.message);
          revoke.disabled = false;
        }
      });
      actionCell.append(revoke);
    }

    row.append(cell(invite.id, 'operator-states'), stateCell, cell(when(invite.createdAt)), cell(when(invite.expiresAt)), actionCell);
    invitesBody.append(row);
  }
}

async function load() {
  const overview = await call('/overview');

  figureAccounts.textContent = String(overview.totals?.accounts ?? 0);
  figureMax.textContent = String(overview.max ?? '—');
  figureBytes.textContent = size(overview.totals?.bytes);
  const live = (overview.invites ?? []).filter((invite) => invite.state === 'live').length;
  figureCodes.textContent = `${live} live`;

  if (document.activeElement !== capField) capField.value = String(overview.max ?? '');

  renderAccounts(overview.accounts ?? []);
  renderInvites(overview.invites ?? []);
  panel.hidden = false;
  showError('');
}

function open() {
  token = tokenField.value.trim();
  if (token === '') {
    gateStatus.textContent = 'A token is needed.';
    return;
  }
  sessionStorage.setItem(TOKEN_KEY, token);
  load()
    .then(() => {
      gateStatus.textContent = 'Opened.';
      tokenField.value = '';
    })
    .catch((error) => {
      panel.hidden = true;
      gateStatus.textContent = error.message;
      showError(error.message);
    });
}

gate.addEventListener('submit', (event) => {
  event.preventDefault();
  open();
});

document.querySelector('#forget').addEventListener('click', () => {
  sessionStorage.removeItem(TOKEN_KEY);
  panel.hidden = true;
  gateStatus.textContent = 'Token forgotten.';
});

capForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const saved = await call('/settings', {
      method: 'POST',
      body: JSON.stringify({ maxAccounts: Number(capField.value) })
    });
    gateStatus.textContent = `Accounts allowed: ${saved.max}.`;
    await load();
  } catch (error) {
    showError(error.message);
  }
});

mintForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const made = await call('/invites/new', {
      method: 'POST',
      body: JSON.stringify({ count: Number(mintCount.value), days: Number(mintDays.value) })
    });

    mintedList.replaceChildren();
    for (const code of made.codes ?? []) {
      const item = document.createElement('li');
      const text = document.createElement('span');
      text.textContent = code;

      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'button button-quiet';
      copy.textContent = 'Copy';
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(code);
          copy.textContent = 'Copied';
        } catch {
          copy.textContent = 'Select it';
        }
      });

      item.append(text, copy);
      mintedList.append(item);
    }

    minted.hidden = (made.codes ?? []).length === 0;
    gateStatus.textContent = `${(made.codes ?? []).length} code(s) made, ${made.roomLeft ?? 0} slot(s) still spare.`;
    await load();
  } catch (error) {
    showError(error.message);
  }
});

const remembered = sessionStorage.getItem(TOKEN_KEY);
if (remembered) {
  token = remembered;
  load().catch(() => {
    panel.hidden = true;
    gateStatus.textContent = 'The token this tab remembered was not accepted.';
  });
}
