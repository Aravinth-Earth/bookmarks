# Collected links — the optional extension

An add-on for the vault at <https://b.332321.xyz/w/bookmarks/>. The vault works exactly as it does without it.
With it, the addresses you open are listed on this device, so you can add the ones worth keeping.

## What it keeps

Each address you open, as plain text in `chrome.storage.local`, on this device. Not encrypted, not in the sealed
vault, and never sent anywhere: the extension makes no network request, and `npm run check` fails if that stops
being true.

Only the address — not the page, not the title, not what you typed. The `#fragment` is dropped, embedded
credentials (`user:pass@`) are removed, and query parameters whose name says they are a credential (`token`,
`code`, `signature`, `session`, `password`, and the rest of a short list) are stripped before anything is written.
That list is not complete; a secret in a parameter nobody would guess is still stored, which is one more reason
the file stays on the device.

## What it asks for

- `tabs` — described by Brave and Chrome as "read your browsing history". There is no narrower permission that
  lets an extension see a tab's address.
- `storage` — the list itself.
- `alarms` — the tidy that runs every six hours and applies the retention you set.

## Install (unpacked)

1. `brave://extensions` → turn on **Developer mode**.
2. **Load unpacked** → choose this `extension/` folder.
3. After editing a file, press the reload arrow on the card. There is no build step.

Installing opens the vault's own page, which is where the one question is asked: *"this device's addresses, kept
here, nothing leaving it — collect?"* Nothing is counted until that is answered, and answering it one way or the
other is the only setup there is. The page is opened from the extension's own registered origin, only on a first
install — an update never interrupts whatever is open, and the vault states its policy again on the next unlock.

After that, **Settings → Collected links** holds everything else: what each site is recorded as, one rule per site
that records it differently, the exclusions, how long rows are kept and how many, the daily limit for new addresses,
the visit floor, and whether private windows are included. Every change is written into the sealed vault and pushed
to this extension.

The vault states that policy again on every unlock, so an extension that was reinstalled or updated picks up what
the vault already decided instead of starting from the defaults.

## Private windows

Off by default, and it takes two steps: allow this extension in Incognito at `brave://extensions` → Details, **and**
turn on **Include private windows** in the vault's Settings → Collected links.

## Checking what it kept

From the service-worker console — a count and the policy, never the rows, because a console is a screen:

```js
chrome.storage.local.get('items').then((v) => Object.keys(v.items ?? {}).length)
chrome.storage.local.get('policy').then((v) => v.policy)
```

`items` is keyed by the canonical address; `policy` is the mirror of the vault's settings.

## Uninstall

Uninstalling asks the browser to delete what the extension stored. *Disabling* it deletes nothing, and a backup of
your browser profile keeps its own copy — uninstalling is a request, not a shredder. The vault is unaffected
either way.
