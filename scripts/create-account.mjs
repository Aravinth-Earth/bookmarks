#!/usr/bin/env node
/**
 * Provision one account on the Worker.
 *
 * The phrase is read from stdin so it does not land in shell history or in `ps`:
 *
 *   node scripts/create-account.mjs --url http://localhost:8792
 *   # paste the 13 words, then Ctrl-D
 *
 * It derives the same account id and auth secret the browser derives, and posts them with the
 * provisioning token. The auth secret logs in and cannot decrypt: the vault key never leaves the
 * browser. Re-running for an existing account reports "already exists" rather than overwriting.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deriveAccount, normalizePhrase } from '../public/w/bookmarks/crypto.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function argument(name, fallback = null) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

function tokenFromDevVars() {
  try {
    const text = readFileSync(join(root, '.dev.vars'), 'utf8');
    for (const line of text.split('\n')) {
      const match = line.match(/^PROVISION_TOKEN=(.*)$/);
      if (match) return match[1].trim();
    }
  } catch {
    /* No local file; the environment may carry the token instead. */
  }
  return null;
}

async function phraseFromStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

const phrase = argument('phrase') ?? (process.stdin.isTTY ? '' : await phraseFromStdin());
if (!phrase) {
  console.error('usage: node scripts/create-account.mjs --url http://localhost:8792 < phrase.txt');
  console.error('       (the phrase is read from stdin so it stays out of shell history)');
  process.exit(1);
}

const base = (argument('url') ?? 'http://localhost:8792').replace(/\/+$/, '');
const token = argument('token') ?? process.env.PROVISION_TOKEN ?? tokenFromDevVars();
if (!token) {
  console.error('no provisioning token: set PROVISION_TOKEN, or put it in .dev.vars, or pass --token');
  process.exit(1);
}

let normalized;
try {
  normalized = normalizePhrase(phrase);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const { accountId, authSecret } = await deriveAccount(normalized);

const response = await fetch(`${base}/w/bookmarks/api/accounts`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`
  },
  body: JSON.stringify({ accountId, authSecret })
});

const body = await response.json().catch(() => ({}));

if (response.status === 201) {
  console.log(`created ${accountId}`);
} else if (response.status === 409) {
  console.log(`already exists: ${accountId}`);
} else {
  console.error(`failed (${response.status}):`, body);
  process.exit(1);
}
