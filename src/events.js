/**
 * The one place a line goes to the platform's log.
 *
 * Observability is on for this Worker (`[observability]` in wrangler.toml), and `console.log` is
 * what it records. Every security-relevant refusal writes exactly one JSON line through this
 * helper, so a refused sign-in, a lockout, a refused creation, a rate-limit refusal, a blocked
 * proxy fetch and an unhandled exception each leave a trace that can be counted afterwards:
 *
 *   {"event":"signin_failed","route":"signin","reason":"bad_proof","account":"9f2c1ab04d7e"}
 *
 * The shape, one line per event and no nested object:
 *
 *   event        signin_failed | signin_locked | create_refused | rate_limited |
 *                proxy_refused | server_error
 *   route        the class the route is counted as — signin, fetch or vault — or `api` when the
 *                exception surfaced before a class was known
 *   reason       the fixed code the refusing branch answered with: bad_proof,
 *                challenge_expired, no_account, too_large, cap_full, invalid, mismatch, locked,
 *                throttled, over_limit, bad_host, blocked_host, bad_hash, timeout, fetch_failed,
 *                unhandled
 *   account      the first 12 hex characters of SHA-256(account id). Present when the branch
 *                holds the account, absent when it does not. Never the id itself.
 *   source       the first 12 hex characters of SHA-256 over the source digest the Worker
 *                forwarded. Present when the branch counted a sign-in against a source.
 *   retry_after  whole seconds; only on `rate_limited` and `signin_locked`
 *
 * Deliberately absent, and never accepted as a field: the account id, the phrase, the auth
 * secret, a proof, a nonce, a session token, a sealed vault blob, a hostname, or a caller's
 * address. Callers pass a fixed code and at most an account id, and the id leaves only as a
 * digest prefix. The rate limiter already keys on its own digest; that value never arrives here.
 * `source` is digested here too, so a value that was not already a digest could still not be
 * written as one.
 *
 * A refused request writes one line and a served one writes none, so the volume follows how
 * rare the event is rather than how much traffic there is. Nothing here returns a value or may
 * throw: a log line is observation, and observation must not change the answer the caller gets.
 */

/* 48 bits of the digest: enough to group one account's events, useless for recovering the id. */
export const ACCOUNT_REF_HEX = 12;

const encoder = new TextEncoder();

function hexPrefix(bytes, length) {
  let text = '';
  for (const byte of bytes) {
    text += byte.toString(16).padStart(2, '0');
    if (text.length >= length) break;
  }
  return text.slice(0, length);
}

/**
 * The SHA-256 of a value, as lowercase hex.
 *
 * One digest implementation for the Worker and the account object: the sign-in lockout keys a
 * failure on a digest, and a second spelling of the same hash would be a second thing to keep
 * right.
 */
export async function digestHex(value, length = 64) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(value)));
  return hexPrefix(new Uint8Array(digest), length);
}

/**
 * A stable, one-way handle for an account.
 *
 * Events about one account have to be groupable without the log holding the id that routes
 * requests to it, so the id is digested and only a prefix of the digest leaves.
 */
export async function accountRef(accountId) {
  return digestHex(accountId, ACCOUNT_REF_HEX);
}

/**
 * Write one event as one JSON line.
 *
 * `sink` is the injection seam: it defaults to `console.log`, which is what observability
 * captures, and a test may pass its own collector instead of reading the console.
 */
export async function logEvent(name, fields = {}, sink = console.log) {
  const line = { event: String(name) };
  if (typeof fields.route === 'string') line.route = fields.route;
  if (typeof fields.reason === 'string') line.reason = fields.reason;

  if (fields.account !== undefined && fields.account !== null && fields.account !== '') {
    try {
      line.account = await accountRef(fields.account);
    } catch {
      /* An id that cannot be digested is left out rather than written raw. */
    }
  }

  if (typeof fields.source === 'string' && fields.source !== '') {
    try {
      line.source = await digestHex(fields.source, ACCOUNT_REF_HEX);
    } catch {
      /* A source that cannot be digested is left out rather than written raw. */
    }
  }

  if (Number.isInteger(fields.retry_after)) line.retry_after = fields.retry_after;

  try {
    sink(JSON.stringify(line));
  } catch {
    /* A sink that fails is not a request that fails. */
  }
}
