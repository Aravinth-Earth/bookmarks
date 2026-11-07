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
src/index.js                  the Worker: security headers, routing, the API, the icon proxy
src/vault.js                  one Durable Object per account: nonce, sessions, sealed vault
src/registry.js               one Durable Object that caps how many accounts may exist
public/w/bookmarks/crypto.js  phrase -> account id, key and auth secret; seal and open
public/w/bookmarks/vault.js   this device's copy: one sealed blob, a bounded history
public/w/bookmarks/bookmarks.js  the document: add, edit, delete, sort, filter, merge
public/w/bookmarks/sync.js    the client half: sign in, pull, push
public/w/bookmarks/wordlist.js   the 1,296 words a phrase is drawn from
tests/                        node --test, no dependencies
scripts/check.mjs             the guards that run before a deploy
```

## Development

```sh
npm install
npm test          # node --test tests/*.test.mjs
npm run check     # guards over public/
npm run dev       # wrangler dev, then open the printed URL
```

A merged commit on `main` is a release: Workers Builds is connected to this repository, so a
merge to `main` builds and deploys. A manual `wrangler deploy` is break-glass only; prove what
is live with

```sh
curl -s https://www.332321.xyz/w/bookmarks/api/health   # {"ok":true,"version":"0.1.0"}
```

If a merge does not appear live within five minutes, check the build in the Cloudflare dashboard
before doing anything else — a hand deploy is not the first response to a slow build.

A branch build only uploads a preview version; it never takes production traffic.

## Turning on sync

The server stores one sealed blob per account and cannot read it. There is no signup form and
no provisioning step: the first sync that names an account creates it, first write wins, from
the same phrase-derived secrets the login uses.

Open the app, create a vault (or unlock one), then Settings → **Sync**. The first run creates
the account and pushes this device's vault; another device that enters the same phrase pulls it
and merges.

Creation is open but bounded: one Registry object caps how many accounts may exist. The cap
is **1 while the service is being tested** — set in `wrangler.toml` as `MAX_ACCOUNTS`, falling
back to 50 in `src/registry.js` when the var is absent. At the cap the server answers
`429 {error:"full"}`.

## Secrets

There are none. No token is needed in any environment, and nothing in this repository is a
credential. The vault key is derived in the browser and never reaches the server; the auth
secret it derives can log in and cannot decrypt.

## Icons

Each icon is fetched once by the Worker — from the site's own `/favicon.ico`, or from the
`<link rel="icon">` the page declares — cached at the edge for 30 days, downscaled to 32px in
the browser, and stored inside the sealed vault as a data URI.

The browser never contacts a bookmarked site. The hostname travels in a request header and the
URL carries only its SHA-256, so the domain does not appear in a request path that platform
logs record. A site that cannot be reached, or that answers with something that is not an
image, simply keeps its lettered tile.

## Credits

The 13-word phrase is drawn from EFF's short word list, used under
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/):
<https://www.eff.org/files/2016/09/08/eff_short_wordlist_1.txt>

## Licence

[AGPL-3.0-or-later](LICENSE).
