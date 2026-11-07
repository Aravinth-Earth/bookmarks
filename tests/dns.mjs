/**
 * A stand-in for the DNS-over-HTTPS resolver the proxies ask before every fetch.
 *
 * A stubbed `fetch` for a proxied route now also sees the two resolver queries that route makes
 * (A and AAAA, in parallel). This wrapper answers them before the stub runs, so a stub still
 * describes only the traffic it is about and its recorded URL list stays exactly what the route
 * contacted. The default answer is a public pair, so an ordinary host behaves as it did; a
 * fixture for one name changes what that name resolves to.
 *
 * Fixtures are keyed by hostname and carry either addresses per type or a `kind` that breaks the
 * answer on purpose:
 *
 *   { a: ['127.0.0.1'], aaaa: ['::1'] }   the addresses the name answers with
 *   { kind: 'http500' }                   a resolver that is not answering
 *   { kind: 'garbage' }                   a 200 whose body is not DNS JSON
 *   { kind: 'status' }                    Status 2, a resolver failure
 *   { kind: 'noanswer' }                  Status 0 and no Answer for either type
 *   { kind: 'badaddress' }                an answer whose data is not an address
 */

const ENDPOINT = 'https://cloudflare-dns.com/dns-query';

const PUBLIC = { a: ['93.184.216.34'], aaaa: ['2606:4700:4700::1111'] };

/** Every resolver query made since the last reset, in order, so a cache can be observed. */
export const dnsQueries = [];

function json(body) {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/dns-json' }
  });
}

function answer(url, dns) {
  const at = new URL(url);
  const name = at.searchParams.get('name') ?? '';
  const type = at.searchParams.get('type') === 'AAAA' ? 'aaaa' : 'a';
  dnsQueries.push({ name, type });

  const fixture = dns?.[name];
  if (fixture?.kind === 'http500') return new Response('unavailable', { status: 500 });
  if (fixture?.kind === 'garbage') {
    return new Response('<html>not dns</html>', {
      headers: { 'content-type': 'text/html' }
    });
  }
  if (fixture?.kind === 'status') return json({ Status: 2, Answer: [] });
  if (fixture?.kind === 'noanswer') return json({ Status: 0 });
  if (fixture?.kind === 'badaddress') {
    return json({
      Status: 0,
      Answer: [{ name, type: type === 'aaaa' ? 28 : 1, TTL: 60, data: 'not-an-address' }]
    });
  }

  const addresses = fixture?.[type] ?? PUBLIC[type];
  if (addresses.length === 0) return json({ Status: 0 });

  return json({
    Status: 0,
    Answer: addresses.map((data) => ({ name, type: type === 'aaaa' ? 28 : 1, TTL: 60, data }))
  });
}

/** Wrap a fetch stub so the resolver queries never reach it. */
export function withDns(implementation, dns) {
  return async (url, init) => {
    const target = String(url);
    if (target.startsWith(ENDPOINT)) return answer(target, dns);
    return implementation(url, init);
  };
}

/** Run `run` with `fetch` replaced, answering resolver queries from `dns`. */
export async function withFetch(implementation, run, dns) {
  const original = globalThis.fetch;
  globalThis.fetch = withDns(implementation, dns);
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}
