# Bookmarks

An end-to-end encrypted, local-first bookmark vault, served at
<https://b.332321.xyz/w/bookmarks/>.

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

## Hosting

The app is served from **b.332321.xyz**, its own origin. IndexedDB belongs to a host, not a
path, so the remembered key cannot be read by any other page on the site. The old
`www.332321.xyz/w/bookmarks/` path redirects here.

The host needs one proxied DNS record in the Cloudflare zone (an AAAA to `100::`, or a CNAME to
the apex); the Worker route does the rest.

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
curl -s https://b.332321.xyz/w/bookmarks/api/health   # {"ok":true,"version":"0.1.0"}
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

## Plans and limits

| Plan | Sync | Vault | How it is chosen |
|---|---|---|---|
| Owner | no expiry | 100 units (~1 MB) | The account id set as `OWNER_ACCOUNT_ID` |
| Free | 30 days, then 7 days read-only | ~11 units (~120 KB) | Everyone else |
| Paid | no expiry | the units bought | Planned |

One unit is about ten bookmarks (14,000 sealed characters). The countdown is shown in the app.
When a free trial ends the server copy becomes read-only for a week and is then deleted; **the
bookmarks stay on the device throughout**, and a sealed backup can be exported at any time. The
Registry releases the slot on deletion, so the cap frees itself.

The limit is bytes, not bookmarks: the vault is sealed, and the server cannot count entries
without breaking the encryption.

### Naming the owner

Ownership is named, never positional. Copy the Account id from Settings, then set it once:

```sh
npx wrangler secret put OWNER_ACCOUNT_ID   # paste the id from Settings
```

The id routes requests to the account and cannot log in. If the account already exists as free,
the next login upgrades it to the owner plan. No one can become the owner by arriving first.

## Secrets

`OWNER_ACCOUNT_ID` is the only configured value, and it is optional: it names the account that
is the owner. It is not a bearer token — it cannot log in, create accounts or read anything.
Nothing in this repository is a credential. The vault key is derived in the browser and never
reaches the server; the auth secret it derives can log in and cannot decrypt.

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
