# Install collected links

A guide for one person with one zip. The vault at <https://bookmarks.332321.xyz/> works exactly as it does
without it; the extension only adds a list of the addresses you open, kept on this device, so the ones worth
keeping are one press away.

Brave 116 or newer, or Chrome 116 or newer. The card will say the version it installed — `0.2.5` for this
parcel.

## 1. Put the folder somewhere permanent

Download `bookmarks-extension-0.2.5.zip` and unzip it. Double-clicking is enough on most systems; Windows wants
**Extract All**, and Linux a right-click. Unzip it **into a new folder**, for example
`Documents/bookmarks-extension-0.2.5`.

Two things matter, and both are about the folder rather than the files:

- The folder must contain `manifest.json` itself, not a folder that contains a folder that contains it. If
  **Load unpacked** later says the manifest is missing, this is why: it wants the folder that holds the file.
- The folder must stay where it is. The browser does not copy it; every time the browser starts it reads the
  extension from that path. Move it, rename it, or empty the trash on it, and the card at `brave://extensions`
  goes dead until you load it again from wherever it now lives.

`Downloads` is a fine place to unzip *to*, as long as nothing later cleans it out. A folder in `Documents` is
easier to keep.

## 2. Load it

1. Open `brave://extensions` (Brave) or `chrome://extensions` (Chrome, Edge, Vivaldi — the same page). Type it
   into the address bar; it is not a link.
2. Turn on **Developer mode**: the switch at the top right.
3. Press **Load unpacked** and choose the folder from step 1 — the one with `manifest.json` in it.
4. A card appears: **Bookmarks — collected links**, version `0.2.5`. The card is where it is controlled; there
   is nothing to press in the toolbar.

Nothing has been recorded yet at this point. The next step is the one that turns it on.

## 3. Answer the one question

On a **first** install the extension opens the vault at <https://bookmarks.332321.xyz/?collector=installed>,
which asks before anything is counted:

> "Bookmarks — collected links" is installed. It can keep the address of every page this browser opens, and how
> often you opened it, so the pages you really use are here to keep.

The sheet says what is kept (the address and a count — no titles, no page contents, no referrer), that it stays
on this device, and that all of it can be changed or cleared later. Then there are two buttons:

- **Keep it off** — nothing is counted, ever, and the vault is exactly as it was.
- **Collect on this device** — three questions follow: what a site is recorded as (every page, one row per
  hostname, or one row for the whole site), how long rows are kept, and whether private windows are included.
  **Done** starts the counter.

The answer is written into the sealed vault, not into the extension, so it travels to your other devices with
the phrase and an extension that was reinstalled picks up what the vault already decided. Everything on that
sheet has a home afterwards in the vault's **Settings → Collected links**: the same three defaults, a rule for
one site, a site or a page to leave out, a daily cap, a visit floor, and **Clear collected links**.

An update never asks again, and a reload never asks again: the question belongs to a first install, and the
vault states its policy on every unlock instead.

## What the three permissions mean

Brave and Chrome show these as warnings on the card. Each one is used for one thing, and the extension has no
other code path:

| Permission | The browser calls it | What it is for here |
|---|---|---|
| `tabs` | "Read your browsing history" | Seeing the address of the tab that has just finished loading. There is no narrower permission that lets an extension see a tab's address, so the warning is the one the platform gives, not a description of what this does. |
| `storage` | "Store data locally" | The list itself: one row per address and a count, in this browser profile, as plain text. |
| `alarms` | — (no warning) | One wake-up every six hours, so the retention and the row limit you chose are actually applied. |

Only the address is kept: not the page, not the title, not the text, not the referrer, not what was typed
before the address bar settled. The `#fragment` is dropped, credentials embedded in the address
(`user:pass@`) are removed, and query parameters whose name says they are a credential (`token`, `code`,
`signature`, `session`, `password`, and a short list beside them) are stripped before anything is written. That
list is not complete — a secret in a parameter nobody would guess is stored — which is one more reason the file
never leaves the device.

The extension makes no network request at all. Its pages set `connect-src 'none'`, and `npm run check` in the
repository fails if a `fetch`, an `XMLHttpRequest`, a beacon, a socket or a native message appears in it.

### History is not read

`history` is not among the permissions and there is no code that asks for it. This is a list of addresses seen
from the moment you install it, not a copy of where you have been: nothing from before today is here.

The one way an older address arrives is the vault's own **optional import** — Settings → Import → *A JSON or
HTML file* — where you pick a file you already have (an export from this vault, a browser bookmarks file) and
the vault reads it. That import is a file you choose; the extension is not involved and nothing is scanned.

## Updating

There is no store listing, so there is no automatic update: an unpacked extension never updates itself, and
nothing tells you a newer parcel exists. To move to a new version:

1. Download the newer zip from the release page.
2. Replace what is inside the folder — unzip the new zip over the old files, or delete the old files inside the
   folder and unzip again. Keep the folder itself: the browser is pointed at its path.
3. Open `brave://extensions` (or `chrome://extensions`) and press the circular reload arrow on the card.
4. The version line under the name changes. That is the confirmation.

Your collected list is not in that folder — it lives in the browser profile — so replacing the files keeps it.
Forgetting step 3 is the usual mistake: the old version keeps running and looks identical from the outside.

## If something is wrong

- **"Manifest file is missing or unreadable"** — the folder you picked is not the one holding `manifest.json`,
  or the zip was unzipped one level deep. Pick the folder that has the file directly inside it.
- **The card is red or greyed out** — the folder moved, was renamed or was deleted. Put it back, or load it
  unpacked from its new place.
- **It counts nothing** — check the vault's Settings → Collected links says **Collection: on**. The extension's
  own default is off, and only the vault turns it on. If that sheet has never been answered, open
  <https://bookmarks.332321.xyz/> and answer it there.
- **Something looks broken** — `brave://extensions` → the card's **Errors** button, and **service worker** for
  the console. A count and the policy can be read from that console without printing any of the rows:

  ```js
  chrome.storage.local.get('items').then((v) => Object.keys(v.items ?? {}).length)
  chrome.storage.local.get('policy').then((v) => v.policy)
  ```

## Checking the download

The release notes carry the SHA-256 of the zip, so the file can be shown to be the one that was built. From the
folder you downloaded it to:

```sh
shasum -a 256 bookmarks-extension-0.2.5.zip      # macOS
sha256sum bookmarks-extension-0.2.5.zip          # Linux
certutil -hashfile bookmarks-extension-0.2.5.zip SHA256   # Windows
```

## Removing it

**Remove** on the card. The browser deletes what the extension stored — the collected rows — and the vault is
untouched: the bookmarks are in the vault, not in the extension. **Disabling** it instead deletes nothing, and a
browser profile that is backed up carries its own copy, so removing is a request, not a shredder.
