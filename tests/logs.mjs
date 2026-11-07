/**
 * Reading the event lines a test caused.
 *
 * The events are written with `console.log`, because that is what Workers observability
 * captures, so a test reads them the way the platform would: by capturing the console. The
 * capture is the same save-and-restore the fetch stubs in these files use.
 */

/** Run `run`, collect every line written to the console, and return both. */
export async function withEvents(run) {
  const lines = [];
  const original = console.log;

  console.log = (...args) => {
    for (const arg of args) lines.push(String(arg));
  };
  try {
    return { result: await run(), lines };
  } finally {
    console.log = original;
  }
}

/** The parsed lines, which is how every assertion here reads them. */
export function parsed(lines) {
  return lines.map((line) => JSON.parse(line));
}

/**
 * Drop event lines for a whole file whose tests are about something else.
 *
 * The tests in this directory that exercise a refusal are not about the log line it writes, and
 * a few hundred TAP comments saying so is noise, not evidence. The file that is about the lines
 * captures them instead.
 */
export function quiet() {
  console.log = () => {};
}
