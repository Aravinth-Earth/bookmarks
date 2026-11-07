# Bookmarks

An end-to-end encrypted, local-first bookmark vault, served at
<https://www.332321.xyz/w/bookmarks/>.

The vault is sealed in the browser with AES-256-GCM under a key derived from a 13-word phrase.
The Worker holds one ciphertext blob per account and cannot read any of it. Adding, editing,
deleting, searching and importing all work with no network at all; sync only ever moves the
sealed blob.

## What this is not

- **No account, in the email sense.** The phrase is the account: it derives the account id, the
  auth secret and the vault key. Nothing else identifies you, and there is nothing to sign up to.
- **No recovery.** Lose the phrase and the vault is unopenable, by construction. The only backup
  is an export you keep yourself.
- **No third-party anything.** No CDN, no web font, no analytics, no tracker, no vendor icon
  service. The page loads only files this Worker serves.

## Layout

```
src/index.js                  the Worker: security headers, routing, the API
src/vault.js                  one Durable Object per account: nonce, sessions, sealed vault
public/w/bookmarks/crypto.js  phrase -> account id, key and auth secret; seal and open
public/w/bookmarks/vault.js   this device's copy: one sealed blob, a bounded history
public/w/bookmarks/bookmarks.js  the document: add, edit, delete, sort, filter, merge
public/w/bookmarks/sync.js    the client half: sign in, pull, push
public/w/bookmarks/wordlist.js   the 1,296 words a phrase is drawn from
tests/                        node --test, no dependencies
scripts/check.mjs             the guards that run before a deploy
scripts/create-account.mjs    provisions one account on the Worker
```

## Development

```sh
npm install
npm test          # node --test tests/*.test.mjs
npm run check     # guards over public/
npm run dev       # wrangler dev, then open the printed URL
```

A merged commit on `main` is a release: Workers Builds deploys it. There is no manual
`wrangler deploy`, and a branch build only uploads a preview.

## Turning on sync

The server stores one sealed blob per account and cannot read it. There is no public signup:
an account is created once, with a provisioning token.

```sh
# One time, per environment. Locally, .dev.vars already carries this.
npx wrangler secret put PROVISION_TOKEN

# Derive the account from the phrase and create it. The phrase is read from stdin
# so it never lands in shell history.
node scripts/create-account.mjs --url https://www.332321.xyz < phrase.txt
```

Then open the app, go to Settings, and turn **Sync** on. The first run pushes this device's
vault; another device that enters the same phrase pulls it and merges. Re-running the script
for an existing account reports "already exists" and changes nothing.

## Credits

The 13-word phrase is drawn from EFF's short word list, used under
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/):
<https://www.eff.org/files/2016/09/08/eff_short_wordlist_1.txt>

## Licence

[AGPL-3.0-or-later](LICENSE).
