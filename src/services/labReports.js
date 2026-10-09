const pool = require('../db/pool');
const config = require('../config');
const shopify = require('./shopify');
const pipeline = require('./pipelineLog');

const PAGE_HANDLE = 'lab-reports';
// The generated lists replace everything between these two comments in the
// page body. The styling, header and "About Our Testing" banner around them
// stay hand-edited in Shopify.
const START = '<!-- Current Inventory -->';
const END = '<!-- Legend -->';

const TEST_LABELS = {
  sterility: 'Sterility',
  endotoxin: 'Endotoxin',
  heavy_metals: 'Heavy metals',
  other: 'Additional report',
};

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// One entry per lot: its purity + quantity report, plus any other published
// report that is a different file.
function groupLots(rows) {
  const lots = new Map();
  for (const r of rows) {
    let lot = lots.get(r.internal_lot);
    if (!lot) {
      lot = {
        lot: r.internal_lot,
        compound: r.compound,
        mg: r.vial_size_mg === null ? null : Number(r.vial_size_mg),
        receivedAt: r.received_at,
        isCurrent: r.is_current,
        primaryPath: null,
        extras: new Map(),
      };
      lots.set(r.internal_lot, lot);
    }
    if (r.test_type === 'purity_quantity') lot.primaryPath = lot.primaryPath || r.coa_path;
    else if (!lot.extras.has(r.test_type)) lot.extras.set(r.test_type, r.coa_path);
  }
  const list = [...lots.values()].filter((l) => l.primaryPath);
  for (const l of list) {
    for (const [type, path] of l.extras) if (path === l.primaryPath) l.extras.delete(type);
  }
  return list.sort(
    (a, b) =>
      a.compound.localeCompare(b.compound) ||
      (a.mg || 0) - (b.mg || 0) ||
      String(b.receivedAt).localeCompare(String(a.receivedAt))
  );
}

function rowHtml(l, archived) {
  const base = config.portalBaseUrl;
  const name = l.mg ? `${esc(l.compound)} (${l.mg}mg)` : esc(l.compound);
  const href = `${base}/coa/${encodeURIComponent(l.lot)}`;
  const links = [`<a rel="noopener" href="${href}" target="_blank">View COA →</a>`];
  for (const type of l.extras.keys()) {
    links.push(
      `<a rel="noopener" href="${href}?t=${encodeURIComponent(type)}" target="_blank" style="margin-left: 16px;">${esc(TEST_LABELS[type] || 'Additional report')} →</a>`
    );
  }
  return [
    `<div class="coa-row${archived ? ' archived-row' : ''}" id="coa-${slug(l.compound)}-${slug(l.lot)}">`,
    '<div class="coa-product">',
    `<div class="coa-dot ${archived ? 'archived' : 'available'}"><br></div>`,
    `<div class="coa-name">${name} <span class="coa-lot">— Lot ${esc(l.lot)}</span>`,
    '</div>',
    '</div>',
    `<div class="coa-action">${links.join('')}</div>`,
    '</div>',
  ].join('\n');
}

function sectionHtml(title, lots, archived) {
  return [
    `<div class="section-header${archived ? ' archived' : ''}">`,
    `<h2>${title}</h2>`,
    '</div>',
    '<div class="coa-section">',
    '<div class="coa-list">',
    ...lots.map((l) => rowHtml(l, archived)),
    '</div>',
    '</div>',
  ].join('\n');
}

function buildLists(lots) {
  const current = lots.filter((l) => l.isCurrent);
  const previous = lots.filter((l) => !l.isCurrent);
  const parts = [START, sectionHtml('Current Inventory', current, false)];
  if (previous.length > 0) {
    parts.push('<!-- Previous Batches -->', sectionHtml('Previous Batches', previous, true));
  }
  return parts.join('\n') + '\n';
}

// Rewrite the lists on the store's Lab Reports page from published tests.
// What is public is decided by the public_lab_reports view. Refuses to
// touch a page whose body no longer has the two marker comments, rather
// than risk overwriting hand-edited content.
async function syncLabReportsPage({ reason = 'manual' } = {}) {
  const { rows } = await pool.query(
    `SELECT internal_lot, compound, vial_size_mg, received_at, is_current, test_type, coa_path
     FROM public.public_lab_reports ORDER BY tested_at DESC NULLS LAST`
  );
  const lots = groupLots(rows);

  let page;
  try {
    page = await shopify.getPageByHandle(PAGE_HANDLE);
  } catch (err) {
    if (/access denied/i.test(err.message)) {
      throw new Error(
        'Shopify refused the page read. The app needs the read_content and write_content permissions.'
      );
    }
    throw err;
  }
  if (!page) throw new Error(`No Shopify page with handle "${PAGE_HANDLE}"`);

  const start = page.body.indexOf(START);
  const end = page.body.indexOf(END);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(
      `The Lab Reports page is missing its "${START}" or "${END}" marker, so it was left alone.`
    );
  }
  const body = page.body.slice(0, start) + buildLists(lots) + page.body.slice(end);
  const changed = body !== page.body;
  if (changed) await shopify.updatePageBody(page.id, body);

  const result = {
    updated: changed ? 1 : 0,
    checked: lots.length,
    current: lots.filter((l) => l.isCurrent).length,
    previous: lots.filter((l) => !l.isCurrent).length,
  };
  await pipeline.log({
    category: 'inventory',
    eventName: 'lab_reports.page_synced',
    status: changed ? 'ok' : 'skipped',
    message: changed
      ? `Lab Reports page rewritten: ${result.current} current, ${result.previous} previous (${reason})`
      : `Lab Reports page already up to date (${reason})`,
    payload: result,
  });
  return result;
}

// For paths where the page is a side effect: log a failure, never throw.
async function syncQuietly({ reason } = {}) {
  try {
    return await syncLabReportsPage({ reason });
  } catch (err) {
    console.error('[LabReports] page sync failed:', err.message);
    await pipeline.log({
      category: 'inventory',
      eventName: 'lab_reports.page_sync_failed',
      status: 'error',
      errorMessage: err.message,
    });
    return null;
  }
}

module.exports = { syncLabReportsPage, syncQuietly, buildLists, groupLots };
