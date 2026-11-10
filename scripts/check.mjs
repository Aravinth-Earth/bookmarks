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
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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

/* The extension is a second parcel of browser modules. A syntax error there fails only when the worker is loaded,
   which nothing in this repository reaches, so it is parsed here with the page's own modules. */
const extensionDir = join(root, 'extension');
const extensionFiles = existsSync(extensionDir) ? walk(extensionDir) : [];
const extensionNames = extensionFiles.map((path) => relative(extensionDir, path));

/* 0. A scan over nothing proves nothing. */
if (assets.length === 0) {
  console.error(`check failed: no assets found under ${publicDir}`);
  process.exit(1);
}

/* 1. Every browser module must parse. */
for (const file of [...assets, ...extensionFiles].filter((path) => path.endsWith('.js'))) {
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
  'nothing else identifies you',
  /* The old model: a timed free sync. The local vault is free forever and only the hosted copy
     is paid, so copy that puts an end date on sync is a claim the product does not make. */
  '30 days',
  'read-only week',
  'free trial',
  'trial ends',
  'trial has ended',
  'trial period',
  'free sync has ended',
  '7 days read-only'
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

/* 7. Every module the page imports is in the offline shell. A new module that is left out of
   SHELL works on the first visit and then fails once the page is offline, which is the one state
   the page cannot report. Both lists are read from the files rather than written down again. */
try {
  const page = readFileSync(join(publicDir, 'w/bookmarks/app.js'), 'utf8');
  const worker = readFileSync(join(publicDir, 'w/bookmarks/sw.js'), 'utf8');
  const imported = [...page.matchAll(/from '\.\/([\w-]+\.js)'/g)].map((match) => match[1]);
  const shell = new Set([...worker.matchAll(/'\/w\/bookmarks\/([\w-]+\.js)'/g)].map((match) => match[1]));

  if (imported.length === 0) problems.push('shell: no module imports found in app.js');

  for (const name of imported) {
    if (!shell.has(name)) problems.push(`shell: app.js imports ${name}, which sw.js does not cache`);
  }
} catch (error) {
  problems.push(`shell: ${error.message}`);
}

/* 8. The extension is optional, local and silent. Every clause here is a promise made to whoever installs it:
   it asks for nothing beyond the three permissions the feature needs, it declares nothing that would let another
   origin reach it, it contacts nobody, and it names the same bridge as the page. A key this guard does not know
   about is a key nobody reviewed, so the manifest is compared against an allowed set and fails closed. */
try {
  const manifest = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8'));

  if (manifest.manifest_version !== 3) {
    problems.push(`extension: manifest_version is ${manifest.manifest_version}, not 3`);
  }

  const allowedKeys = new Set([
    'manifest_version', 'name', 'version', 'description', 'minimum_chrome_version', 'permissions',
    'background', 'incognito', 'action', 'content_scripts', 'content_security_policy', 'icons', 'author'
  ]);
  const named = new Set(['optional_permissions', 'externally_connectable', 'web_accessible_resources', 'sandbox']);
  for (const key of Object.keys(manifest)) {
    if (!allowedKeys.has(key) && !named.has(key)) {
      problems.push(`extension: manifest declares "${key}", which no guard has reviewed`);
    }
  }

  const allowedPermissions = new Set(['tabs', 'storage', 'alarms']);
  for (const permission of manifest.permissions ?? []) {
    if (!allowedPermissions.has(permission)) {
      problems.push(`extension: manifest asks for "${permission}", which is not in the reviewed set`);
    }
  }
  if ((manifest.permissions ?? []).length === 0) {
    problems.push('extension: manifest declares no permissions, so this guard is inspecting nothing');
  }
  if ((manifest.host_permissions ?? []).length > 0) {
    problems.push('extension: manifest declares host_permissions, which is a warning it does not need');
  }

  /* These four are the ways a manifest widens its own reach after review: a second origin that can message the
     worker, a resource any page may load, or permissions granted later without a reinstall. */
  for (const key of ['optional_permissions', 'externally_connectable', 'web_accessible_resources', 'sandbox']) {
    if (key in manifest) {
      problems.push(`extension: manifest declares "${key}", which widens reach beyond the reviewed surface`);
    }
  }

  if (manifest.background?.type !== 'module') {
    problems.push('extension: the service worker is not declared as a module, so its imports would not load');
  }

  const csp = manifest.content_security_policy?.extension_pages ?? '';
  if (!/\bconnect-src 'none'/.test(csp)) {
    problems.push('extension: the extension pages do not set connect-src \'none\', so a fetch would be allowed');
  }

  /* A content script may only be injected into the vault, and only if the file it names is actually present. */
  const vault = new URL('https://b.332321.xyz/w/bookmarks/');
  const names = extensionNames;
  if (names.length === 0) problems.push('extension: no files found');

  const declared = manifest.content_scripts ?? [];
  for (const script of declared) {
    for (const match of script.matches ?? []) {
      let parsed = null;
      try {
        parsed = new URL(match.replace('*', 'x'));
      } catch {
        parsed = null;
      }
      /* The vault itself, plus the local dev server it is worked on against — the bridge has to be provable
         before it is deployed, and a loopback origin is not another site. */
      const isLoopback = parsed !== null && parsed.hostname === '127.0.0.1';
      const onVault = parsed !== null && parsed.origin === vault.origin;
      if (parsed === null || !(isLoopback || onVault) || !parsed.pathname.startsWith(vault.pathname)) {
        problems.push(`extension: content script matches ${match}, which is not the vault`);
      }
    }
    for (const file of script.js ?? []) {
      if (!names.includes(file)) {
        problems.push(`extension: content script names ${file}, which is not in the extension`);
      }
    }
  }

  /* This host set is deliberately smaller than the page's: the page may talk to its own Worker, the extension
     may talk to nothing. Loopback is not an exception — a local port is still somewhere a URL can be sent. */
  const extensionHosts = new Set(['b.332321.xyz', '332321.xyz', 'www.332321.xyz']);

  /* Calls that would reach the network, whatever they are handed. A literal-URL scan cannot see
     `fetch(\`https://${host}/?u=${url}\`)`, which is the shape exfiltration actually takes. */
  const networkSinks =
    /\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource|importScripts|sendNativeMessage|connectNative)\s*\(/;

  for (const name of names) {
    const text = readFileSync(join(extensionDir, name), 'utf8');
    const flat = text.toLowerCase().replace(/\s+/g, ' ');

    for (const match of text.matchAll(urlPattern)) {
      if (match[0].includes('${')) continue;
      let host;
      try {
        host = new URL(match[0]).hostname.toLowerCase();
      } catch {
        problems.push(`extension/${name}: unparseable URL ${match[0]}`);
        continue;
      }
      /* The one loopback address allowed anywhere in the extension is the local dev server's vault path, in the
         manifest's content-script matches. No module may reach it, which is why this stays a manifest-only rule. */
      const devVault =
        name === 'manifest.json' && host === '127.0.0.1' && new URL(match[0]).pathname.startsWith(vault.pathname);
      if (extensionHosts.has(host) || devVault) continue;
      problems.push(`extension/${name}: external URL ${match[0]}`);
      break;
    }

    if (protocolRelativePattern.test(text)) {
      problems.push(`extension/${name}: protocol-relative URL`);
    }

    if (name.endsWith('.js')) {
      const calls = text.match(networkSinks);
      if (calls) problems.push(`extension/${name}: makes a ${calls[1]} call, and the extension talks to nobody`);
    }

    for (const banned of bannedHosts) {
      if (flat.includes(banned)) problems.push(`extension/${name}: contains "${banned}"`);
    }
  }

  /* A constant is read by shape: the version is a number and the two source tags are quoted strings. */
  const constant = (file, name) => {
    const text = readFileSync(join(root, file), 'utf8');
    const quoted = text.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`));
    if (quoted) return quoted[1];
    const numeric = text.match(new RegExp(`\\b${name}\\s*=\\s*([0-9]+)`));
    return numeric ? numeric[1] : null;
  };

  for (const [file, label] of [
    ['extension/protocol.js', 'extension'],
    ['extension/bridge.js', 'content script'],
    ['public/w/bookmarks/collector.js', 'page']
  ]) {
    if (constant(file, 'BRIDGE_VERSION') === null) {
      problems.push(`bridge: ${label} declares no BRIDGE_VERSION`);
    }
  }

  /* The version is not the whole contract: the two source tags are how each side recognises the other, and a typo
     in one of them makes every message unmatched with nothing to catch it. */
  const sides = ['extension/protocol.js', 'extension/bridge.js', 'public/w/bookmarks/collector.js'];
  for (const name of ['BRIDGE_SOURCE', 'PAGE_SOURCE', 'BRIDGE_VERSION']) {
    const values = sides.map((file) => constant(file, name));
    if (values.some((value) => value === null)) {
      problems.push(`bridge: ${name} is missing in ${sides[values.indexOf(null)]}`);
    } else if (new Set(values).size !== 1) {
      problems.push(`bridge: ${name} differs across the three ends (${values.join(' / ')})`);
    }
  }
} catch (error) {
  problems.push(`extension: ${error.message}`);
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
