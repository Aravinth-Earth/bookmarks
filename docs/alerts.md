# Sign-in failure alerts

A sustained set of failed sign-ins for one account raises exactly one notification. The rule that
does it is `alerts/signin-failures.json`, beside `wrangler.toml`; this page says what it counts, why
its numbers are the ones the code already uses, where it is created, and what to do when it fires.

## What it counts

`signin_failed` and `signin_locked` — the two lines `src/events.js` writes when a sign-in is refused
(README, "Events"). Each line names the account as the first 12 hex characters of its digest, so the
rule groups by `account` and a lockout on one account is one series, whether one source spent it or
twenty did.

For one account, the rule counts those lines inside a trailing fifteen-minute window. The first
evaluation where the count reaches five raises the notification. While the same set keeps arriving
the monitor stays quiet, so a source hammering a door that is already locked does not produce a
stream of them, and a new set after a window of silence is a new notification.

Five and fifteen minutes are not chosen here: five wrong proofs from one source is the lockout the
account object enforces (`MAX_FAILURES` and `LOCKOUT_MS` in `src/vault.js`), and a source's failures
are forgotten after that same quarter of an hour (`FAILURE_WINDOW_MS`). The threshold is therefore
the smallest sustained set that also locks a source, and the window is the period in which those
failures still count. One wrong phrase never reaches it; a distributed attempt does, because the
account-level throttle writes `signin_locked` too.

`every_seconds` is the monitor's execution interval and `repeat_seconds` the shortest gap between
repeats while the set stays above the threshold. The interval is no longer than the window, which is
the constraint the platform states, and the repeat is no shorter than the window, which is what
makes "one set, one notification" true rather than a guess.

## Where it is created

The lines come from Workers Logs: `[observability] enabled = true` in `wrangler.toml` records each
refusal, and the monitor reads the `logs.workersLogs` dataset for the `bookmarks` Worker. The policy
itself is created in the dashboard, because nothing in this repository is a credential and a deploy
cannot carry a destination:

Observability → Alerts → Add, dataset scope this account, dataset Workers Logs, filter `event` in
`signin_failed` and `signin_locked`, metric `COUNT`, evaluation window 15 minutes, comparison
greater than or equal to 5, execution interval 1 minute, repeat interval 1 hour, destination the
owner's email or a webhook. Preview the query against retained logs before saving: the preview shows
the field names this account's dataset uses, and they are the ones to enter.

`npm run check` refuses a deploy where this rule and the code disagree: an event the rule counts
that `src/` no longer writes, a threshold that is not the lock count, a window that is not the
lockout's, an execution interval longer than the window, or a rule that stopped grouping by the
account digest. The written rule cannot quietly become the wrong rule.

## When it fires

Read the account's `signin_locked` lines for the moment. `reason: "locked"` with a `source` means
one source spent five proofs and is out for fifteen minutes; `reason: "throttled"` means more than
twenty failures arrived across sources inside a minute and the account is answering with a wait that
doubles from a second and stops at thirty. Neither is a reason to end the account or change the
phrase: a correct proof from the owner still signs in and clears the count at once, and no source
can lock another.

If the notifications continue while the owner says they were not signing in, the account is under a
distributed attempt and the throttle is doing its job; the same account digest in every notification
is how the two are told apart without the log holding the id.
