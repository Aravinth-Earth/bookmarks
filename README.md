# Bookmarks

An end-to-end encrypted, local-first bookmark vault, served at
<https://b.332321.xyz/w/bookmarks/>.

The vault is sealed in the browser with AES-256-GCM under a key derived from a 13-word phrase.
The Worker holds one ciphertext blob per account and cannot read any of it; beside the blob it
keeps an account record — creation and last-seen dates, plan, sealed size, and the devices
signed in. Adding, editing, deleting, searching and importing all work with no network at all;
sync only ever moves the sealed blob.

## What this is not

- **No account, in the email sense.** The phrase is the account: it derives the account id, the
  auth secret and the vault key. The id is a hash of the phrase, not an address, and there is
  nothing to sign up to.
- **No recovery.** Lose the phrase and the vault is unopenable, by construction. The only backup
  is an export you keep yourself.
- **No third-party code.** No CDN, no web font, no analytics, no tracker, no vendor icon
  service. The page loads only files this Worker serves.

## Layout

```
src/index.js                  the Worker: security headers, routing, the API, the icon proxy
src/vault.js                  one Durable Object per account: nonce, sessions, sealed vault
src/registry.js               one Durable Object that caps how many accounts may exist
src/events.js                 the one shape a logged event has, and the digest it names an account by
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

The server stores one sealed blob per account and an account record of dates, plan, size and
signed-in devices; it cannot read the blob. There is no signup form and no provisioning step:
the first sync that names an account creates it, first write wins, from the same phrase-derived
secrets the login uses.

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

## Request limits

Each route class is counted per source, and a source that has spent a class's ceiling is
answered `429 {"error":"rate_limited"}` with a `retry-after` header and no other effect: no
storage write and no outbound fetch happens for it.

The counters live at the edge location that answers a request, so the ceiling applies per
location: a caller whose requests are answered by several locations can reach a multiple of it
within one window, and a caller kept on one location is held to the number exactly. The
counters are a brake on one source spending the service, not a quota.

| Class | Routes | Ceiling per source |
|---|---|---|
| Sign-in | `/account`, `/challenge`, `/login` | 10 per minute |
| Fetch | `/icon`, `/title` | 30 per ten seconds |
| Vault | `/vault`, `/sessions`, `/logout` | 60 per minute |

Sign-in and fetch are the two classes that write storage or contact another host; the vault
class is the app's own traffic and is the most permissive of the three.

The source is the caller's address, counted as a SHA-256 digest and never stored raw. The
counts are Cloudflare's rate limiting bindings (`[[ratelimits]]` in `wrangler.toml`), so they
are held per Cloudflare location and are approximate. `npm run check` fails when the thresholds
in that file and the `LIMITS` table in `src/index.js` disagree.

A challenge is valid for 60 seconds, and asking for one again during that time returns the same
nonce. A sign-in that is already in progress therefore completes whatever else arrives.

### Sign-in lockout

A wrong proof is counted against the source it came from, never against the account, so no one
who knows an account id can shut its owner out by failing five times. The Worker derives the
source from the caller's address, forwards only its SHA-256, and replaces any value the caller
sent; the account object stores a second digest over that and the account. Five wrong proofs
from one source lock that source for **15 minutes** and nothing else — another source, the
owner's included, still signs in. A correct proof clears that source's count at once, and a
count older than fifteen minutes is forgotten.

One account remembers at most **64 sources**. A new source is admitted only by evicting the
oldest entry, so inventing sources cannot grow the record, and an evicted entry can only forget
failures: a lock lives inside its entry and nowhere else.

A distributed attempt is met by a whole-account counter that throttles rather than locks. Inside
a minute, the first **20** failures cost nothing — more than four sources can spend, since each
is locked at five. Each failure after that answers `429 {"error":"throttled"}` with a
`retry-after` that doubles from **1 second** and stops at **30 seconds**, and a correct proof
clears the counter. The wait is written at most thirty seconds ahead and is never a stored
deadline an attacker can extend, so the owner's worst case is a thirty-second retry, not a
lockout.

## Events

Observability is on for the Worker, and each refusal is written as one JSON line through
`console.log`, which is what it captures. A request that is served writes nothing, so a line
means something was refused or failed:

```json
{"event":"signin_failed","route":"signin","reason":"bad_proof","account":"9f2c1ab04d7e"}
```

| Field | Value |
|---|---|
| `event` | `signin_failed`, `signin_locked`, `create_refused`, `rate_limited`, `proxy_refused`, `server_error` |
| `route` | The class the route is counted as — `signin`, `fetch` or `vault` — or `api` when an exception surfaced before a class was known |
| `reason` | The code the refusing branch answered with: `bad_proof`, `challenge_expired`, `no_account`, `too_large`, `cap_full`, `invalid`, `mismatch`, `locked`, `throttled`, `over_limit`, `bad_host`, `blocked_host`, `bad_hash`, `timeout`, `fetch_failed`, `unhandled` |
| `account` | The first 12 hex characters of SHA-256(account id), present when the branch holds the account. The id itself is never written. |
| `source` | The first 12 hex characters of SHA-256 over the source digest the Worker forwarded, present when the sign-in was counted against a source. Never an address. |
| `retry_after` | Whole seconds; on `rate_limited` and `signin_locked` only |

The shape is defined once, in `src/events.js`, and `logEvent` is the only writer. It takes an
event name, a fixed reason code and at most an account id, and the id leaves only as that digest
prefix. The phrase, the auth secret, a proof, a nonce, a session token, a sealed blob, a
hostname and the caller's address are not fields and never appear; the rate limiter keys on a
digest of its own and never passes it here.

The account object writes `signin_failed`, `signin_locked` and `create_refused`. The Worker
writes `rate_limited`, `proxy_refused` and `server_error`. `tests/events.test.mjs` reads the
lines the way the platform would — by capturing the console — and checks both the fields and the
absence of anything identifying.

## Secrets

`OWNER_ACCOUNT_ID` is the only configured value, and it is optional: it names the account that
is the owner. It is not a bearer token — it cannot log in, create accounts or read anything.
Nothing in this repository is a credential. The vault key is derived in the browser and never
reaches the server; the auth secret it derives can log in and cannot decrypt.

## Icons

The Worker fetches each icon from the site's own `/favicon.ico`, or from the
`<link rel="icon">` the page declares. A site that yields neither is asked again a week later;
the automatic run covers up to twenty hosts per launch. The image is downscaled to 32px in the
browser and stored inside the sealed vault as a data URI.

The browser never contacts a bookmarked site; this Worker does, and the site learns only that
this Worker asked it for an icon, at that moment. The request names the host in a header, and the
URL path carries only its SHA-256. A site that cannot be reached, or that answers with something
that is not an image, simply keeps its lettered tile.

## Credits

The 13-word phrase is drawn from EFF's short word list, used under
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/):
<https://www.eff.org/files/2016/09/08/eff_short_wordlist_1.txt>

## Licence

[AGPL-3.0-or-later](LICENSE).
