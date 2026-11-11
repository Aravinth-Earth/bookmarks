/**
 * Layout: does the vault hold together at the widths people actually use?
 *
 * Every assertion here is a measured box, a scrollWidth, or a computed style read out of the live page. Nothing is
 * judged from a picture: a screenshot shows that something looks wrong, never by how much, and the numbers are what
 * a fix is written against.
 *
 * The content is deliberately hostile — long names, long addresses with no spaces, a full collected section — because
 * a short label fits a narrow column and proves nothing.
 */

import {
  addBookmark,
  closeSettings,
  createVault,
  expect,
  expectCollectedCount,
  openSettings,
  test
} from './fixtures.mjs';

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 }
];

/* Names near the form's own 120-character ceiling, addresses with no space to break at. */
const BOOKMARKS = [
  {
    name: 'Quarterly planning notes, architecture decisions and the payments rollout',
    url: 'https://e2e.local/docs/2026/engineering/architecture/decisions/adr-014-payments-rewrite-of-the-settlement-pipeline'
  },
  {
    name: 'A very long bookmark name that describes the whole incident review for March',
    url: 'https://e2e.local/incidents/2026-03-settlement-outage/postmortem-and-follow-up-actions?session=9f3a2b1c7d&utm_campaign=archive'
  },
  {
    name: 'Release checklist',
    url: 'https://e2e.local/releases/2026/11/checklist-for-the-settlement-pipeline-with-the-full-runbook-linked-at-the-bottom'
  },
  {
    name: 'Runbook',
    url: 'https://e2e.local/runbooks/settlement-pipeline/rollback-and-reconciliation-procedure-for-the-overnight-batch'
  }
];

const COLLECTED = [
  {
    url: 'https://e2e.local/collected/one/a-really-long-path-that-keeps-going-past-the-column-that-holds-it-and-then-keeps-going',
    visits: 12,
    lastSeenAt: '2026-11-09T09:15:00.000Z'
  },
  {
    url: 'https://e2e.local/collected/two/another-long-address-for-the-collected-section-so-the-table-has-something-to-clip',
    visits: 3,
    lastSeenAt: '2026-11-08T18:40:00.000Z'
  },
  {
    url: 'https://e2e.local/collected/three/the-third-address-so-the-bulk-bar-has-more-than-one-row-to-sit-above',
    visits: 1,
    lastSeenAt: '2026-11-07T07:05:00.000Z'
  }
];

/* ------------------------------------------------------------------ settling */

async function settle(page) {
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 0))))
  );
}

async function resize(page, { width, height }) {
  await page.setViewportSize({ width, height });
  await settle(page);
}

async function showView(page, view) {
  const current = await page.locator('#list').getAttribute('data-view');
  if (current !== view) await page.locator('#view-toggle').click();
  await expect(page.locator('#list')).toHaveAttribute('data-view', view);
  await settle(page);
}

/**
 * Fill the collected section.
 *
 * The section is drawn from what the extension answers, and the extension's content script is matched on
 * one loopback port only, so a page served on this suite's port could never hear the real
 * extension. The page and the extension talk over `window.postMessage` with a published protocol, so the harness
 * answers that protocol in the page's own world: the rows are still drawn by the app's own `renderCollected`, which
 * is what the layout is about.
 */
async function fillCollected(page) {
  await page.evaluate((items) => {
    const BRIDGE_SOURCE = 'bookmarks-collector';
    const PAGE_SOURCE = 'bookmarks-page';
    const BRIDGE_VERSION = 1;
    const snapshot = {
      ok: true,
      items,
      policy: {
        enabled: true,
        includeIncognito: false,
        levels: [],
        exclude: [],
        retentionDays: 60,
        maxEntries: 2000,
        dailyCap: 0,
        minVisits: 1
      }
    };

    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== PAGE_SOURCE || data.version !== BRIDGE_VERSION) return;
      window.postMessage(
        {
          source: BRIDGE_SOURCE,
          version: BRIDGE_VERSION,
          id: data.id,
          reply: data.type === 'request' ? snapshot : { ok: true }
        },
        window.location.origin
      );
    });

    /* The page re-reads on a visibility change and on a slow poll; this asks for the first read now. */
    document.dispatchEvent(new Event('visibilitychange'));
  }, COLLECTED);
}

/** A vault with long names, long addresses, and a collected section that is not empty. */
async function seed(page) {
  await createVault(page);
  for (const bookmark of BOOKMARKS) await addBookmark(page, bookmark);
  await expect(page.locator('#list .row:not(.row-head)')).toHaveCount(BOOKMARKS.length);

  await fillCollected(page);
  await expectCollectedCount(page, COLLECTED.length);
  await settle(page);
}

/* ------------------------------------------------------------------ measuring */

const BOX = `
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      left: +r.left.toFixed(2), right: +r.right.toFixed(2),
      top: +r.top.toFixed(2), bottom: +r.bottom.toFixed(2),
      width: +r.width.toFixed(2), height: +r.height.toFixed(2),
      scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
      scrollHeight: el.scrollHeight, clientHeight: el.clientHeight
    };
  };
  const label = (node) => node.tagName.toLowerCase()
    + (node.id ? '#' + node.id : '')
    + (typeof node.className === 'string' && node.className.trim()
      ? '.' + node.className.trim().split(/\\s+/).join('.')
      : '');
  const shown = (el) => {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
`;

/** The whole page: the document's own scroll width, and every visible box that reaches past it. */
async function pageWide(page) {
  return page.evaluate(
    `(() => {${BOX}
      const doc = document.documentElement;
      const bleeders = [];
      for (const el of document.querySelectorAll('body *')) {
        if (el.closest('.skip') || el.closest('.visually-hidden')) continue;
        if (!shown(el)) continue;
        if (getComputedStyle(el).position === 'fixed') continue;
        const r = el.getBoundingClientRect();
        if (r.right > doc.clientWidth + 0.5 || r.left < -0.5) {
          bleeders.push({ what: label(el), ...box(el) });
        }
      }
      return {
        root: { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, innerWidth },
        body: { scrollWidth: document.body.scrollWidth, clientWidth: document.body.clientWidth },
        bleeders: bleeders.slice(0, 10),
        bleederCount: bleeders.length
      };
    })()`
  );
}

/** The toolbar: how many lines it took, and whether each control stayed inside it. */
async function toolbarBox(page) {
  return page.evaluate(
    `(() => {${BOX}
      const bar = document.querySelector('.toolbar');
      const barBox = box(bar);
      const controls = [...bar.children].filter(shown).map((node) => ({ what: label(node), ...box(node) }));
      /* A line is a band of controls whose vertical extents overlap: controls of different heights share a line when
         their boxes overlap, and a wrapped row starts below every control of the one above it. */
      const bands = [];
      for (const control of controls) {
        const band = bands.find((candidate) => control.top < candidate.bottom - 0.5 && candidate.top < control.bottom - 0.5);
        if (band) {
          band.top = Math.min(band.top, control.top);
          band.bottom = Math.max(band.bottom, control.bottom);
        } else {
          bands.push({ top: control.top, bottom: control.bottom });
        }
      }
      const outside = controls.filter((c) =>
        c.left < barBox.left - 0.5 || c.right > barBox.right + 0.5 ||
        c.top < barBox.top - 0.5 || c.bottom > barBox.bottom + 0.5
      ).map((c) => c.what);
      const clipped = controls.filter((c) => c.scrollWidth > c.clientWidth + 1 && c.clientWidth > 0).map((c) => c.what);
      return {
        bar: barBox,
        controls,
        lines: bands.length,
        outside,
        clipped,
        headerBudget: barBox.bottom,
        style: { overflowX: getComputedStyle(bar).overflowX, flexWrap: getComputedStyle(bar).flexWrap }
      };
    })()`
  );
}

/** One table's cells, row by row, plus whether the text inside each cell had to be cut. */
async function tableBoxes(page, selector) {
  return page.evaluate(
    `(() => {${BOX}
      const list = document.querySelector(${JSON.stringify(selector)});
      if (!list) return null;
      const cellsOf = (row) => {
        const wanted = [
          ['name', row.querySelector('.row-name')],
          ['address', row.querySelector('.row-host')],
          ['uses', row.querySelector('.clicks')],
          ['last-used', row.querySelector('.row-when')],
          ['actions', row.querySelector('.row-actions')]
        ];
        return wanted.filter(([, el]) => el && getComputedStyle(el).display !== 'none').map(([key, el]) => {
          const style = getComputedStyle(el);
          return {
            key,
            ...box(el),
            textOverflow: style.textOverflow,
            overflowX: style.overflowX,
            whiteSpace: style.whiteSpace,
            text: (el.textContent || '').trim().slice(0, 60)
          };
        });
      };
      const rows = [...list.querySelectorAll(':scope > .row')];
      /* A phone does not draw the header row, so there is nothing to line up under it there. */
      const drawn = rows.find((row) => row.classList.contains('row-head'));
      const head = drawn && getComputedStyle(drawn).display !== 'none' ? drawn : null;
      const body = rows.filter((row) => !row.classList.contains('row-head'));
      return {
        list: box(list),
        head: head
          ? {
              row: box(head),
              cells: cellsOf(head),
              /* The header cells are grid items, so their boxes are the column tracks themselves — the only place the
                 column's width can be read, because a body cell is an inline span that shrinks to its own text. */
              columns: [...head.children].filter((node) => getComputedStyle(node).display !== 'none').map((node) => ({
                text: (node.textContent || '').trim(),
                ...box(node)
              }))
            }
          : null,
        rows: body.map((row) => ({ row: box(row), cells: cellsOf(row) }))
      };
    })()`
  );
}

/** Every pill in a list: its own box, and whether it stayed inside the container that wraps it. */
async function pillBoxes(page, selector) {
  return page.evaluate(
    `(() => {${BOX}
      const list = document.querySelector(${JSON.stringify(selector)});
      if (!list) return null;
      const listBox = box(list);
      const style = getComputedStyle(list);
      return {
        list: listBox,
        display: style.display,
        flexWrap: style.flexWrap,
        gap: parseFloat(style.columnGap) || 0,
        pills: [...list.querySelectorAll(':scope > .row:not(.row-head)')].filter(shown).map((row) => {
          const b = box(row);
          return {
            box: b,
            name: box(row.querySelector('.row-name')),
            inside: b.left >= listBox.left - 0.5 && b.right <= listBox.right + 0.5,
            line: Math.round(b.top)
          };
        })
      };
    })()`
  );
}

/* ---------------------------------------------------------------------- tests */

test('no horizontal overflow at phone, tablet and desktop, in either view', async ({ page, context }) => {
  await seed(page);

  for (const viewport of VIEWPORTS) {
    for (const view of ['pills', 'list']) {
      await resize(page, viewport);
      await showView(page, view);
      const wide = await pageWide(page);
      const where = `${viewport.name} ${viewport.width}x${viewport.height}, ${view} view`;

      expect(
        wide.root.scrollWidth,
        `${where}: documentElement.scrollWidth ${wide.root.scrollWidth} vs clientWidth ${wide.root.clientWidth}; ` +
          `first boxes past the edge: ${JSON.stringify(wide.bleeders.slice(0, 3))}`
      ).toBeLessThanOrEqual(wide.root.clientWidth + 1);

      expect(
        wide.body.scrollWidth,
        `${where}: body.scrollWidth ${wide.body.scrollWidth} vs clientWidth ${wide.body.clientWidth}`
      ).toBeLessThanOrEqual(wide.body.clientWidth + 1);

      expect(wide.bleederCount, `${where}: ${wide.bleederCount} boxes reach past the right edge: ${JSON.stringify(wide.bleeders)}`).toBe(0);
    }
  }
});

/* Known defect: at 390px the masthead and a two-line toolbar take 140px of the screen. */
test('the toolbar keeps its controls inside itself and stays under a phone-sized height budget', async ({ page, context }) => {
  await seed(page);

  for (const viewport of VIEWPORTS) {
    await resize(page, viewport);
    const bar = await toolbarBox(page);
    const where = `${viewport.name} ${viewport.width}px`;

    expect(bar.outside, `${where}: controls outside the toolbar box: ${JSON.stringify(bar.outside)}`).toEqual([]);
    expect(bar.clipped, `${where}: toolbar controls cutting their own text: ${JSON.stringify(bar.clipped)}`).toEqual([]);
    expect(
      bar.bar.scrollWidth,
      `${where}: toolbar scrollWidth ${bar.bar.scrollWidth} vs clientWidth ${bar.bar.clientWidth}`
    ).toBeLessThanOrEqual(bar.bar.clientWidth + 1);
    expect(bar.lines, `${where}: toolbar laid out as ${bar.lines} line(s)`).toBeLessThanOrEqual(2);

    if (viewport.name === 'phone') {
      expect(
        bar.headerBudget,
        `phone: masthead + toolbar reach ${bar.headerBudget.toFixed(1)}px down the screen; budget is 120px ` +
          `(toolbar ${bar.bar.height.toFixed(1)}px tall, ${bar.lines} line(s))`
      ).toBeLessThanOrEqual(120);
    }
  }
});

/* Known defect: at 390px the name and address tracks collapse to 0px and 5px, so rows are unidentified. */
test('the table keeps its five columns apart and readable, in the vault and the collected section', async ({ page, context }) => {
  await seed(page);

  /* Every break is collected rather than thrown at the first one, so a single run reports the whole picture. */
  const problems = [];
  const note = (condition, message) => {
    if (!condition) problems.push(message);
  };

  for (const viewport of VIEWPORTS) {
    await resize(page, viewport);
    await showView(page, 'list');
    const where = `${viewport.name} ${viewport.width}px`;

    for (const [section, table] of [
      ['vault', await tableBoxes(page, '#list')],
      ['collected', await tableBoxes(page, '#collected-list')]
    ]) {
      note(table.rows.length > 0, `${where} ${section}: no rows to measure`);

      for (const [index, entry] of table.rows.entries()) {
        const cells = entry.cells;
        note(
          cells.map((cell) => cell.key).join(',') === 'name,address,uses,last-used,actions',
          `${where} ${section} row ${index}: columns are ${cells.map((cell) => cell.key).join(',')}`
        );

        /* Two cells can only overlap if they are on the same line: a phone puts the address under the name. */
        for (let i = 1; i < cells.length; i += 1) {
          const previous = cells[i - 1];
          const cell = cells[i];
          if (Math.abs(previous.top - cell.top) > 2) continue;
          const overlap = +(previous.right - cell.left).toFixed(2);
          note(
            overlap <= 0.5,
            `${where} ${section} row ${index}: ${previous.key} ends at ${previous.right} and ${cell.key} starts at ` +
              `${cell.left} — ${overlap}px of overlap ("${previous.text}" / "${cell.text}")`
          );
        }

        for (const cell of cells) {
          note(
            cell.left >= entry.row.left - 0.5 && cell.right <= entry.row.right + 0.5,
            `${where} ${section} row ${index}: ${cell.key} spans ${cell.left}..${cell.right}, the row spans ` +
              `${entry.row.left}..${entry.row.right}`
          );
        }

        const name = cells.find((cell) => cell.key === 'name');
        const address = cells.find((cell) => cell.key === 'address');
        note(
          name && name.width > 0 && address && address.width > 0,
          `${where} ${section} row ${index}: the name is ${name ? name.width : 'missing'}px wide and the address ` +
            `${address ? address.width : 'missing'}px — row ${entry.row.left}..${entry.row.right}`
        );
      }

      /* The width of a column is the width of the header cell that names it: header cells are grid items and fill
         their track, where a body cell is an inline span that shrinks to its own text. */
      if (table.head) {
        for (const label of ['Name', 'Address']) {
          const column = table.head.columns.find((node) => node.text === label);
          note(
            column && column.width >= 64,
            `${where} ${section}: the ${label.toLowerCase()} column is ${column ? column.width : 'missing'}px wide`
          );
        }
      }

      /* The header has to sit over the column it names, or the table reads as five unnamed boxes. */
      if (table.head) {
        for (const cell of table.head.cells) {
          const match = table.rows[0].cells.find((body) => body.key === cell.key);
          if (!match) continue;
          note(
            Math.abs(cell.left - match.left) <= 1,
            `${where} ${section}: header "${cell.text}" starts at ${cell.left}, its column at ${match.left}`
          );
        }
      }

      /* One column, one place: every row puts the same cell at the same x, so the eye can follow it down. */
      for (const key of ['name', 'address', 'uses', 'last-used', 'actions']) {
        const lefts = table.rows.map((entry) => entry.cells.find((cell) => cell.key === key)?.left).filter((left) => left !== undefined);
        if (lefts.length < 2) continue;
        const spread = Math.max(...lefts) - Math.min(...lefts);
        note(spread <= 1, `${where} ${section}: the ${key} column starts between ${Math.min(...lefts)} and ${Math.max(...lefts)} (${spread.toFixed(1)}px apart)`);
      }
    }
  }

  expect(problems, `${problems.length} layout problem(s):\n- ${problems.join('\n- ')}`).toEqual([]);
});

test('pills wrap inside their container instead of overflowing it', async ({ page, context }) => {
  await seed(page);

  for (const viewport of VIEWPORTS) {
    await resize(page, viewport);
    await showView(page, 'pills');
    const where = `${viewport.name} ${viewport.width}px`;

    for (const [section, selector] of [
      ['vault', '#list'],
      ['collected', '#collected-list']
    ]) {
      const pills = await pillBoxes(page, selector);
      expect(pills.display, `${where} ${section}: pills view is ${pills.display}`).toBe('flex');
      expect(pills.flexWrap, `${where} ${section}: pills container flex-wrap ${pills.flexWrap}`).toBe('wrap');
      expect(pills.pills.length, `${where} ${section}: no pills`).toBeGreaterThan(0);

      const outside = pills.pills.filter((pill) => !pill.inside);
      expect(
        outside.map((pill) => pill.box),
        `${where} ${section}: ${outside.length} pill(s) outside the container ${JSON.stringify(pills.list)}`
      ).toEqual([]);

      for (const [index, pill] of pills.pills.entries()) {
        expect(
          pill.box.scrollWidth,
          `${where} ${section} pill ${index}: scrollWidth ${pill.box.scrollWidth} vs clientWidth ${pill.box.clientWidth}`
        ).toBeLessThanOrEqual(pill.box.clientWidth + 1);
      }

      /* Wrapping, not overflow: when the pills together are wider than the container, they have to occupy more than
         one line rather than run past its edge. */
      const lines = new Set(pills.pills.map((pill) => pill.line));
      const rowWidth = pills.pills.reduce((sum, pill) => sum + pill.box.width, 0) + pills.gap * (pills.pills.length - 1);
      if (rowWidth > pills.list.clientWidth) {
        expect(
          lines.size,
          `${where} ${section}: ${pills.pills.length} pills measuring ${rowWidth.toFixed(1)}px in a ` +
            `${pills.list.clientWidth}px container sat on ${lines.size} line(s)`
        ).toBeGreaterThan(1);
      }

      for (const [i, a] of pills.pills.entries()) {
        for (const b of pills.pills.slice(i + 1)) {
          const overlaps = a.box.left < b.box.right - 0.5 && b.box.left < a.box.right - 0.5 &&
            a.box.top < b.box.bottom - 0.5 && b.box.top < a.box.bottom - 0.5;
          expect(overlaps, `${where} ${section}: two pills overlap ${JSON.stringify(a.box)} / ${JSON.stringify(b.box)}`).toBe(false);
        }
      }
    }
  }
});

test('the settings modal fits the viewport and scrolls inside itself', async ({ page, context }) => {
  await seed(page);

  for (const viewport of VIEWPORTS) {
    await resize(page, viewport);
    await openSettings(page);
    await settle(page);

    const modal = await page.evaluate(
      `(() => {${BOX}
        const root = document.querySelector('.modal-backdrop');
        const boxed = root.querySelector('.modal');
        const actions = boxed.querySelector('.modal-actions');
        return {
          viewport: { width: innerWidth, height: innerHeight },
          backdrop: box(root),
          modal: box(boxed),
          overflowY: getComputedStyle(boxed).overflowY,
          actions: box(actions),
          lastItem: box([...boxed.querySelectorAll('.settings-item')].pop())
        };
      })()`
    );

    const where = `${viewport.name} ${viewport.width}x${viewport.height}`;

    expect(modal.backdrop.left, `${where}: the backdrop starts at ${modal.backdrop.left}`).toBeLessThanOrEqual(0);
    expect(modal.modal.left, `${where}: modal starts at ${modal.modal.left}`).toBeGreaterThanOrEqual(0);
    expect(modal.modal.right, `${where}: modal ends at ${modal.modal.right}, viewport is ${modal.viewport.width}`).toBeLessThanOrEqual(modal.viewport.width + 0.5);
    expect(modal.modal.top, `${where}: modal starts at ${modal.modal.top}`).toBeGreaterThanOrEqual(0);
    expect(modal.modal.bottom, `${where}: modal ends at ${modal.modal.bottom}, viewport is ${modal.viewport.height}`).toBeLessThanOrEqual(modal.viewport.height + 0.5);
    expect(
      modal.modal.scrollWidth,
      `${where}: modal scrollWidth ${modal.modal.scrollWidth} vs clientWidth ${modal.modal.clientWidth}`
    ).toBeLessThanOrEqual(modal.modal.clientWidth + 1);

    const scrolls = modal.modal.scrollHeight > modal.modal.clientHeight + 1;
    if (scrolls) {
      expect(['auto', 'scroll'], `${where}: modal is taller than its box but overflow-y is ${modal.overflowY}`).toContain(modal.overflowY);
    }

    /* The way out of the dialog has to be reachable without leaving the page. */
    await page.evaluate(() => {
      const modal = document.querySelector('.modal');
      modal.scrollTop = modal.scrollHeight;
      return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    });

    const reachable = await page.evaluate(
      `(() => {${BOX}
        const boxed = document.querySelector('.modal');
        const footer = boxed.querySelector('.modal-actions');
        return {
          actions: footer ? box(footer) : null,
          lastItem: box([...boxed.querySelectorAll('.settings-item')].pop()),
          scrollTop: boxed.scrollTop,
          maxScroll: boxed.scrollHeight - boxed.clientHeight
        };
      })()`
    );

    expect(
      reachable.lastItem.top,
      `${where}: after scrolling to ${reachable.scrollTop}/${reachable.maxScroll}, the last setting starts at ${reachable.lastItem.top}`
    ).toBeGreaterThanOrEqual(-0.5);
    expect(
      reachable.lastItem.bottom,
      `${where}: after scrolling, the last setting ends at ${reachable.lastItem.bottom}`
    ).toBeLessThanOrEqual(modal.viewport.height + 0.5);
    if (reachable.actions) {
      expect(
        reachable.actions.bottom,
        `${where}: after scrolling, the actions end at ${reachable.actions.bottom}`
      ).toBeLessThanOrEqual(modal.viewport.height + 0.5);
    }

    await closeSettings(page);
  }
});

test('the collected bulk bar and header row sit above the rows, never on top of them', async ({ page, context }) => {
  await seed(page);

  for (const viewport of VIEWPORTS) {
    await resize(page, viewport);
    await showView(page, 'list');
    await settle(page);

    const bar = await page.evaluate(
      `(() => {${BOX}
        const section = document.querySelector('#collected');
        const bar = document.querySelector('#collected-bar');
        const list = document.querySelector('#collected-list');
        const rows = [...list.querySelectorAll(':scope > .row')];
        const head = rows.find((row) => row.classList.contains('row-head'));
        const first = rows.find((row) => !row.classList.contains('row-head'));
        return {
          hidden: bar.hidden || getComputedStyle(bar).display === 'none',
          section: box(section),
          bar: box(bar),
          list: box(list),
          head: head && getComputedStyle(head).display !== 'none' ? box(head) : null,
          first: first ? box(first) : null,
          title: box(document.querySelector('#collected-title')),
          count: rows.length
        };
      })()`
    );

    const where = `${viewport.name} ${viewport.width}px`;

    expect(bar.hidden, `${where}: the collected list has ${bar.count} rows but the bulk bar is hidden`).toBe(false);
    expect(bar.count, `${where}: collected list is empty, nothing to measure`).toBeGreaterThan(1);

    expect(
      bar.bar.top,
      `${where}: the bulk bar starts at ${bar.bar.top}, above the section title ending at ${bar.title.bottom}`
    ).toBeGreaterThanOrEqual(bar.title.bottom - 0.5);

    expect(
      bar.bar.bottom,
      `${where}: the bulk bar ends at ${bar.bar.bottom}, the list starts at ${bar.list.top}`
    ).toBeLessThanOrEqual(bar.list.top + 0.5);

    if (bar.head) {
      expect(
        bar.head.top,
        `${where}: the header row starts at ${bar.head.top}, the bar ends at ${bar.bar.bottom}`
      ).toBeGreaterThanOrEqual(bar.bar.bottom - 0.5);

      expect(
        bar.first.top,
        `${where}: the first row starts at ${bar.first.top}, the header row ends at ${bar.head.bottom}`
      ).toBeGreaterThanOrEqual(bar.head.bottom - 0.5);
    }

    expect(
      bar.bar.right,
      `${where}: the bar ends at ${bar.bar.right}, the section at ${bar.section.right}`
    ).toBeLessThanOrEqual(bar.section.right + 0.5);
  }
});

test('row text is clipped with an ellipsis, never mid-glyph, and the name column keeps room', async ({ page, context }) => {
  await seed(page);

  for (const viewport of VIEWPORTS) {
    await resize(page, viewport);
    await showView(page, 'list');
    const where = `${viewport.name} ${viewport.width}px`;
    const table = await tableBoxes(page, '#list');

    for (const [index, entry] of table.rows.entries()) {
      for (const cell of entry.cells) {
        const cut = cell.scrollWidth > cell.clientWidth + 1;
        if (!cut) continue;
        const designed = cell.overflowX === 'hidden' && cell.textOverflow === 'ellipsis';
        expect(
          designed,
          `${where} vault row ${index}: "${cell.text}" is cut (scrollWidth ${cell.scrollWidth} vs clientWidth ` +
            `${cell.clientWidth}) without an ellipsis — overflow-x ${cell.overflowX}, text-overflow ${cell.textOverflow}`
        ).toBe(true);
      }
    }

    /* The page must not scroll sideways to read a row: the row's own box is the bound. */
    for (const entry of table.rows) {
      expect(
        entry.row.scrollWidth,
        `${where}: a row's scrollWidth ${entry.row.scrollWidth} exceeds its clientWidth ${entry.row.clientWidth}`
      ).toBeLessThanOrEqual(entry.row.clientWidth + 1);
    }
  }
});

/**
 * Two readings that agree, or a give-up: a measurement taken while a stylesheet is still applying is a measurement of
 * the wrong page, and under a busy machine that is exactly when it happens.
 */
async function settleLayout(page) {
  let previous = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const now = await page.evaluate(() => {
      const root = document.documentElement;
      const name = document.querySelector('#list .row:not(.row-head) .row-name');
      return `${root.scrollWidth}:${root.clientWidth}:${Math.round(name?.getBoundingClientRect().width ?? 0)}`;
    });
    if (now === previous) return now;
    previous = now;
    await page.waitForTimeout(150);
  }
  return previous;
}

test('200% zoom, as the layout sees it: no sideways scroll and no crushed columns', async ({ page, context }) => {
  await seed(page);
  await showView(page, 'list');

  /* Browser zoom halves the CSS viewport: a 1280px window at 200% lays out as 640px. */
  await resize(page, { width: 640, height: 450 });
  await settleLayout(page);
  const zoomed = await pageWide(page);
  expect(
    zoomed.root.scrollWidth,
    `200% of 1280x900 (640x450 CSS px): documentElement.scrollWidth ${zoomed.root.scrollWidth} vs clientWidth ` +
      `${zoomed.root.clientWidth}; ${JSON.stringify(zoomed.bleeders)}`
  ).toBeLessThanOrEqual(zoomed.root.clientWidth + 1);
  expect(zoomed.bleederCount, `640px: ${JSON.stringify(zoomed.bleeders)}`).toBe(0);

  const table = await tableBoxes(page, '#list');
  const name = table.rows[0].cells.find((cell) => cell.key === 'name');
  expect(
    name.width,
    `200% of 1280 (640px CSS): the name column is ${name.width}px wide, text "${name.text}"`
  ).toBeGreaterThanOrEqual(64);

  /* And the same zoom applied as CSS zoom over the full-width layout. */
  await resize(page, { width: 1280, height: 900 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = '2';
    return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
  await settleLayout(page);

  const cssZoom = await page.evaluate(
    `(() => {${BOX}
      const doc = document.documentElement;
      const bleeders = [];
      for (const el of document.querySelectorAll('body *')) {
        if (el.closest('.skip') || el.closest('.visually-hidden')) continue;
        if (!shown(el)) continue;
        if (getComputedStyle(el).position === 'fixed') continue;
        const r = el.getBoundingClientRect();
        if (r.right > doc.clientWidth + 0.5) bleeders.push({ what: label(el), ...box(el) });
      }
      return {
        root: { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth },
        body: { scrollWidth: document.body.scrollWidth, clientWidth: document.body.clientWidth, width: document.body.getBoundingClientRect().width },
        innerWidth,
        bleeders: bleeders.slice(0, 6),
        bleederCount: bleeders.length
      };
    })()`
  );

  expect(
    cssZoom.root.scrollWidth,
    `CSS zoom 2 at 1280px: documentElement scrollWidth ${cssZoom.root.scrollWidth} vs clientWidth ` +
      `${cssZoom.root.clientWidth}; body ${cssZoom.body.width}px wide in a ${cssZoom.innerWidth}px viewport; ` +
      `${JSON.stringify(cssZoom.bleeders)}`
  ).toBeLessThanOrEqual(cssZoom.root.clientWidth + 1);
});

/* TEMPORARY DIAGNOSTIC — removed before the file is finished. */
/* 320 CSS pixels is a 640px window at 200% zoom, and WCAG 1.4.10 asks that content reflow rather than scroll
   sideways at that size. Known defect: the same fixed tracks that collapse at 390px push the row past 320px. */
test('320 CSS pixels reflows without scrolling sideways', async ({ page }) => {
  await createVault(page);
  await addBookmark(page, { url: 'https://e2e.local/a-page-with-a-rather-long-address', name: 'A name long enough to matter' });
  await page.locator('#view-toggle').click();

  await page.setViewportSize({ width: 320, height: 568 });
  await page.waitForTimeout(300);

  const measured = await page.evaluate(() => {
    const root = document.documentElement;
    const past = [...document.querySelectorAll('#list .row')]
      .map((node) => Math.round(node.getBoundingClientRect().right))
      .filter((right) => right > root.clientWidth);
    return { scroll: root.scrollWidth, client: root.clientWidth, past };
  });

  expect(measured.scroll, `rows reaching past the viewport: ${measured.past.join(', ') || 'none'}`)
    .toBeLessThanOrEqual(measured.client);
});
