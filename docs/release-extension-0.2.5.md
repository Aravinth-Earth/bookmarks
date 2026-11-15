# Collected links 0.2.5 — the parcel

The optional companion for the bookmark vault at <https://bookmarks.332321.xyz/>, built from this repository and
nothing else. This is the copy to attach to the `extension-v0.2.5` release; the release body is this file with the
heading removed.

| | |
|---|---|
| Version | `0.2.5` (from `extension/manifest.json`) |
| File | `bookmarks-extension-0.2.5.zip` |
| Size | 54,914 bytes, 12 files, stored (uncompressed, fixed timestamps) |
| SHA-256 | `1bbacac071c3f7a3245843acfec90ca3aeaef9a63a95b8f2213c5f2c48e647bb` |
| Built from | `extension/` on the branch `release/extension-0.2.5`, merged as `main` before publishing |
| Browsers | Chromium 116 or newer, unpacked — tested on Brave and Chrome |

## Install

1. Download `bookmarks-extension-0.2.5.zip` and unzip it **into a folder you will keep**. The browser reads the
   extension from that path at every start; moving or deleting it later breaks the install.
2. `brave://extensions` (or `chrome://extensions`) → turn on **Developer mode** → **Load unpacked** → pick the
   unzipped folder, the one holding `manifest.json`.
3. The card reads **Bookmarks — collected links**, version `0.2.5`. On a first install the vault opens and asks
   one question: keep the addresses this browser opens, or keep the extension off. Nothing is counted until it
   is answered.

`INSTALL.md` inside the zip is the same guide with the consent sheet, the three permissions and the update
procedure written out — it is the copy to hand to someone who has never seen this repository.

## What is in it

- Addresses the browser opens, kept as plain text in `chrome.storage.local` on that device and never sent
  anywhere. Only the address and a count: no titles, no page text, no referrer.
- One row per address, folded at read time into a site, a host or a page — so changing how a site is recorded
  never loses a count.
- The vault decides: collection on or off, a record level per site, exclusions for a site, a hostname or one
  path, retention, a row limit, a daily cap, a visit floor, private windows. Every change is sealed into the
  vault and pushed to the extension, so a reinstall picks up what the vault already decided.
- A six-hourly tidy that applies the retention and the row limit, and a toolbar badge that says when the vault
  has not answered yet and stays silent after it has.
- Nothing that reaches the network: the pages set `connect-src 'none'`, and `npm run check` fails on a `fetch`,
  an `XMLHttpRequest`, a beacon, a socket or a native message in the extension.

## Permissions

| Permission | Why |
|---|---|
| `tabs` | To see the address of a tab that has just finished loading. The platform has no narrower permission for that, so the install warning reads "read your browsing history". |
| `storage` | The list itself, in the browser profile. |
| `alarms` | One wake-up every six hours for the tidy. |

The browser's `history` is not requested and not read. Nothing from before the install is here; the vault's own
optional import (Settings → Import) is the only way an older address arrives, and that file is chosen by hand.

## Updating an unpacked copy

There is no store listing and no updater. Unzip a newer parcel over the folder's contents (keep the folder),
then press the reload arrow on the card at `brave://extensions`. The version line changing is the confirmation.
The collected list is in the browser profile, not the folder, so replacing files keeps it.

## Checking the download

```sh
shasum -a 256 bookmarks-extension-0.2.5.zip      # macOS
sha256sum bookmarks-extension-0.2.5.zip          # Linux
```

A rebuild from the same tree is byte-identical, so a mismatch means the file did not arrive as it was built.
To rebuild:

```sh
git worktree add /tmp/parcel extension-v0.2.5
cd /tmp/parcel && npm run package:extension && sha256sum dist/bookmarks-extension-0.2.5.zip
```

## Limits worth knowing

- Unpacked only. There is no Chrome Web Store listing yet; that comes after the first group of testers.
- The extension is opt-in twice: the browser asks at install, and the vault asks before a single address is
  counted.
- Hosted sync is separate from this parcel and still invite-only during the test; the local vault and this
  extension work with no account and no network.
- The credential-shaped query parameters the extension strips are a denylist, not a guarantee. A secret in a
  parameter nobody would guess is still stored, on that device, which is why the file never leaves it.
