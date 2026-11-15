# The friend kit

Everything needed to put one person in front of a working vault, and nothing that has to be written twice.
Copy the message, fill two blanks, send it. One message per person, one code each.

## Before sending: fill these in

| Placeholder | What goes there |
|---|---|
| `{{URL}}` | `https://bookmarks.332321.xyz/` — this and only this. The short address that once sat beside it is retired and routes nowhere; a link to it is a dead end, not a redirect. |
| `{{CODE}}` | That person's own invite code, from the operator page. One code opens one account. |

A code lasts **seven days** from the moment it is minted, opens **one** account, and is spent by the creation
that uses it. It is not a password, it is not the phrase, and it is not reusable: a friend who needs it again
needs a new one. Never send the same code to two people, and never put a code in a place more than one person
can read. Dashes, spaces and lower case do not matter when it is pasted; hand-typed is fine.

The hosted service is at a cap of a small number of accounts while it is being tested, so the codes are the
only way in. A code that is refused as *used* or *expired* is one to replace, not to argue with.

## The message

> Hi — here's the bookmark vault I've been building: {{URL}}
>
> It's a bookmark list that stays encrypted on your own device. No account, no email, no password reset — the
> thirteen words it shows you once are the whole key.
>
> Four steps:
> 1. Open {{URL}} → **New vault**, and write the thirteen words down before you press **Create vault**. Tick
>    the box once they are somewhere safe. There is no recovery: nobody, including me, can open the vault
>    without them.
> 2. **Settings → Export → Sealed backup** and keep the file. That is the only copy that restores the vault if
>    this device is lost.
> 3. **Settings → Sync**, turn it on. When the server says it needs a code, paste this one into the **Invite
>    code** field and press **Use this code**:
>
>    `{{CODE}}`
>
> 4. Optional, and the part I most want tested: the little extension that lists what you open, so you can keep
>    the pages you actually use. Zip:
>    <https://github.com/Aravinth-Earth/bookmarks/releases/tag/extension-v0.2.5>
>    — download it, unzip it into a folder you'll keep, then `brave://extensions` → **Developer mode** →
>    **Load unpacked** → pick that folder. The vault asks once whether to collect; the answer is yours.
>
> Anything broken or confusing, mail me at aravinth@332321.xyz — and please never send the thirteen words, not
> even to me.
>
> One code, yours, expires in a week.

The extension link is a **draft** release until it is published: it answers 404 to anyone but the owner.
Publish it before the message goes out, or leave the extension part out of the first message and send it after.

## What happens on the other side, click by click

This is the path the message describes, written out in the order the screens appear, so a question can be
answered without opening the app.

1. **{{URL}}** → the vault asks for thirteen words. There are none yet: press **New vault**.
2. A sheet titled **Your new vault** shows thirteen words and says they are shown once. **Copy phrase** or write
   them on paper. They are the vault: the account id, the sign-in secret and the key are all derived from them,
   so the same words on a second device open the same vault, and no other words do.
3. Tick **I have saved these thirteen words somewhere safe**, then **Create vault**. The list opens.
4. **Settings → Export → Sealed backup** — saves one encrypted file to the computer. It restores with the same
   thirteen words, so it is not a second secret, but it is the difference between "the device died" and "the
   vault is gone". Keep it somewhere other than the device.
5. **Settings → Server → Sync: off** → press it, confirm, and the switch reads **Sync: on**. On a vault that has
   never synced, the sheet asks for the thirteen words once, then creates the account and pushes this device's
   copy.
6. If the server wants a code, the sheet says *"This server needs an invite code to create an account."* and an
   **Invite code** field appears in that same section — under the Sync switch, not on another page. Paste
   `{{CODE}}`, press **Use this code**. It reads *"Sync is on for this vault."* and the code is gone: it was
   spent on the account and is not kept anywhere.
7. **Settings → Server → Sync: now** is the manual reconcile. It is not needed in normal use; it is how to prove
   a second device has caught up.

A second device, or a reinstall, takes the other door: enter the same thirteen words on the first screen and the
vault opens — or, on a device that holds nothing, it offers to load the copy the server keeps. No code is asked
for then. A code is for the creation of an account, once.

## What to tell them about the thirteen words

- There is no recovery, no reset, no "forgot phrase" link. Anyone with the words can read the vault; anyone
  without them, including the server, cannot.
- They are shown once. If they are lost before the sealed backup is made, the vault is gone — nothing on the
  server can be turned back into it.
- Never send them in a chat, a mail, a screenshot or a support request. If a message needs the account, it is
  the **Account id** from Settings: it names the account and cannot log in.

## Feedback

A short reply is worth more than a long one, and a specific one is worth more than a compliment. Ask for this:

```
What I did:
What I expected:
What happened:
Browser (Brave/Chrome/Safari) and version:
Phone or computer:
Sync on or off?
```

Two rules for the reply, worth saying in the message: **never the thirteen words**, and no screenshot of them.
`aravinth@332321.xyz` is the address for all of it — bugs, confusion, "I don't get what this row means".

## The first day

The point of the first day is not to be impressed; it is to find the sentence that does not make sense. Ask
them to try, in roughly this order:

1. Add five sites they actually use, by hand, from the vault — the address bar at the top of the list.
2. Search for one of them, open it, and use the browser's own back button rather than the app's controls.
3. Lock the vault (**Lock**, or close the tab), then unlock it with the thirteen words. It should look the same.
4. Install the extension if they want it, answer the consent sheet, then open a handful of pages and watch them
   appear under **Collected links**. Add one of them to the vault. Reload a page twice and see the count move.
5. If there is a second device — a phone and a laptop is the good case — open {{URL}} there, enter the same
   thirteen words, and check the five sites arrive. Add one on the phone, press **Sync now** on the laptop, and
   check it is there. That round trip is the whole product.
6. Export a sealed backup and keep it. Delete nothing until the backup is somewhere else.
7. Change one setting that matters to them — a site left out of collection, a shorter retention, a bigger text
   size — and see that it survives a lock and unlock.

What to watch for, because it is the useful part of the report: a row that shows the wrong site, a count that
moves without a page being opened, an address kept that should not be, a sync that says it worked and did not,
and any sentence on screen that needs reading twice.

## After the first week

- A code that expires unused is not a problem: mint another. Nothing was spent.
- A vault that was created and never used is released after a day and its slot goes back to the cap. A vault
  that has been signed in to or written is kept for as long as the service holds it.
- The local vault has no expiry and needs no account; sync is the part that is being tested. If sync is
  switched off, everything already in the vault still works, offline, for good.
