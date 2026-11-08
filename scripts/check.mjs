/**
 * Guards for the browser bundle.
 *
 * The promise on the page is "no third-party anything, ever", so an accidental CDN link, font,
 * analytics snippet or vendor icon service has to fail before a deploy rather than ship. Also
 * syntax-checks every module, refuses copy that overclaims, and keeps the word list from being
 * silently truncated.
 *
 * Every absence check is paired with a presence check: a scan that inspects nothing passes
 * vacuously, which is the failure mode this file exists to prevent.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const publicDir = join(root, 'public');

const problems = [];

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

const assets = walk(publicDir);

/* 0. A scan over nothing proves nothing. */
if (assets.length === 0) {
  console.error(`check failed: no assets found under ${publicDir}`);
  process.exit(1);
}

/* 1. Every browser module must parse. */
for (const file of assets.filter((path) => path.endsWith('.js'))) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    problems.push(`${relative(root, file)}: ${String(error.stderr || error.message).trim()}`);
  }
}

/* 2. No outbound requests to anyone but this origin. The host is compared whole, so
   `332321.xyz.attacker.example` and a `localhost` that only appears in a path cannot pass. */
/* The SVG namespace is an identifier, never a request, but the scan cannot tell the difference. */
const allowedHosts = new Set([
  '332321.xyz',
  'www.332321.xyz',
  'localhost',
  '127.0.0.1',
  'www.w3.org'
]);
const urlPattern = /\bhttps?:\/\/[^\s"'<>)]+/gi;
/* `src="//host/x"` loads a third party without ever spelling a scheme. */
const protocolRelativePattern = /\b(?:src|href)\s*=\s*["']\/\/[^"']+/gi;
const bannedHosts = [
  'google-analytics',
  'googletagmanager',
  'gtag(',
  'plausible.io',
  'posthog',
  'sentry.io',
  'cdn.jsdelivr',
  'unpkg.com',
  'cdnjs',
  'goatcounter',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'icons.duckduckgo.com',
  'google.com/s2/favicons',
  'favicon.io',
  'icon.horse'
];
/* Copy that would be a lie: the sealed blob does go to this Worker, the icon route learns a
   hostname, and the server keeps an account record beside the blob. Each sentence below said
   otherwise once; the list keeps the exact wording out of the page. */
const bannedCopy = [
  'no data sent anywhere',
  'no data ever leaves',
  'nothing leaves your device',
  'completely anonymous',
  'nothing is sent anywhere',
  'only ever holds a sealed blob',
  'only ever holds the sealed blob',
  'each site is asked once, by this server',
  'cached at the edge for 30 days',
  'never appears in a url that platform logs record',
  'does not appear in a request path that platform logs record',
  'no third party ever learns that this vault contains that site',
  'no third-party anything',
  'nothing else identifies you'
];
/* Nothing personal belongs in a page strangers load. */
const personal = ['aravinth', '@332321.xyz', 'simplelogin'];

for (const file of assets) {
  const text = readFileSync(file, 'utf8');
  /* Rendered whitespace collapses, so a phrase split across a line break still reads as itself. */
  const flat = text.toLowerCase().replace(/\s+/g, ' ');

  for (const match of text.matchAll(urlPattern)) {
    /* A template literal builds a URL from a variable, so it names no fixed host to check. */
    if (match[0].includes('${')) continue;

    let host;
    try {
      host = new URL(match[0]).hostname.toLowerCase();
    } catch {
      problems.push(`${relative(root, file)}: unparseable URL ${match[0]}`);
      continue;
    }
    if (allowedHosts.has(host)) continue;
    problems.push(`${relative(root, file)}: external URL ${match[0]}`);
    break;
  }

  for (const match of text.matchAll(protocolRelativePattern)) {
    problems.push(`${relative(root, file)}: protocol-relative URL ${match[0].trim()}`);
    break;
  }

  for (const banned of bannedHosts) {
    if (flat.includes(banned)) problems.push(`${relative(root, file)}: contains "${banned}"`);
  }
  for (const phrase of bannedCopy) {
    if (flat.includes(phrase)) problems.push(`${relative(root, file)}: overclaiming copy "${phrase}"`);
  }
  for (const who of personal) {
    if (flat.includes(who)) problems.push(`${relative(root, file)}: personal detail "${who}" in a public asset`);
  }
  /* The CSP has no 'unsafe-inline' for scripts, so an inline handler would simply not run. */
  if (file.endsWith('.html')) {
    const inline = text.match(/\son[a-z]+\s*=/gi);
    if (inline) problems.push(`${relative(root, file)}: inline event handler ${inline[0].trim()}`);
  }
}

/* 3. README.md makes the same promises to a reader who never opens the page, so it is held to
   the same list. It is read directly: a repository with no README fails here rather than
   passing the way an empty scan would. */
try {
  const readme = readFileSync(join(root, 'README.md'), 'utf8').toLowerCase().replace(/\s+/g, ' ');
  for (const phrase of bannedCopy) {
    if (readme.includes(phrase)) problems.push(`README.md: overclaiming copy "${phrase}"`);
  }
} catch (error) {
  problems.push(`README.md: ${error.message}`);
}

/* 4. The word list is the entropy of every vault: a truncated one silently weakens every phrase
   made after the truncation, and nothing else would notice. */
try {
  const { WORDLIST } = await import(join(publicDir, 'w/bookmarks/wordlist.js'));
  if (WORDLIST.length !== 1296) {
    problems.push(`wordlist: expected 1296 words, got ${WORDLIST.length}`);
  }
  if (new Set(WORDLIST).size !== WORDLIST.length) {
    problems.push('wordlist: a word repeats');
  }
} catch (error) {
  problems.push(`wordlist: ${error.message}`);
}

/* 5. The request limits the Worker counts are the ones wrangler.toml declares. A binding renamed
   or a threshold edited in one file only would deploy, and would count nothing. */
try {
  const { LIMITS } = await import(join(root, 'src/index.js'));
  const config = readFileSync(join(root, 'wrangler.toml'), 'utf8');
  const blocks = config
    .split('[[ratelimits]]')
    .slice(1)
    .map((part) => part.split('\n[[')[0]);
  const namespaces = new Set();

  for (const rule of Object.values(LIMITS)) {
    const block = blocks.find((text) => text.includes(`name = "${rule.binding}"`));
    if (!block) {
      problems.push(`limits: wrangler.toml has no [[ratelimits]] binding named ${rule.binding}`);
      continue;
    }

    const number = (field) =>
      Number(block.match(new RegExp(`\\b${field}\\s*=\\s*([0-9_]+)`))?.[1]?.replace(/_/g, ''));
    const limit = number('limit');
    const period = number('period');
    if (limit !== rule.limit || period !== rule.period) {
      problems.push(
        `limits: ${rule.binding} is limit=${limit} period=${period} in wrangler.toml, ` +
          `limit=${rule.limit} period=${rule.period} in src/index.js`
      );
    }

    const namespace = block.match(/\bnamespace_id\s*=\s*"([0-9]+)"/)?.[1];
    if (!namespace) problems.push(`limits: ${rule.binding} has no namespace_id`);
    else if (namespaces.has(namespace)) problems.push(`limits: namespace ${namespace} repeats`);
    else namespaces.add(namespace);
  }
} catch (error) {
  problems.push(`limits: ${error.message}`);
}

/* 6. Invocation logging must stay off. Every account route carries `/a/<accountId>/`, and the
   invocation line is written from the request path, so a config edit that turns it back on
   publishes the id that `src/events.js` digests on purpose. The event stream is the intended
   record, and it costs nothing to keep this true. */
try {
  const config = readFileSync(join(root, 'wrangler.toml'), 'utf8');
  const observability = config.match(/^\[observability\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1] ?? '';
  const logs = config.match(/^\[observability\.logs\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1] ?? '';

  if (!observability) {
    problems.push('logs: wrangler.toml has no [observability] block');
  } else if (!/^\s*enabled\s*=\s*true\s*$/m.test(observability)) {
    problems.push('logs: [observability] is not enabled = true, so refusals are not recorded');
  }

  if (!logs) {
    problems.push('logs: wrangler.toml has no [observability.logs] block');
  } else if (!/^\s*invocation_logs\s*=\s*false\s*$/m.test(logs)) {
    problems.push(
      'logs: [observability.logs] does not set invocation_logs = false, ' +
        'so the account id in an /a/<id>/ path would be logged with every request'
    );
  }
} catch (error) {
  problems.push(`logs: ${error.message}`);
}

if (problems.length) {
  console.error('check failed:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `check passed: ${assets.length} assets, no third-party references, no overclaiming copy, ` +
    `1296 words, request limits match wrangler.toml`
);
