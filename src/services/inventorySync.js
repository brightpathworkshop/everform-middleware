const pool = require('../db/pool');
const config = require('../config');
const shopify = require('./shopify');
const pipeline = require('./pipelineLog');

// How long an unpaid invoice keeps its claim on stock.
const RESERVE_DAYS = 14;

// Line items of orders that have been invoiced but not yet paid. Their
// stock has not left the portal ledger (that happens at payment), so it is
// held back here to keep a pending order's claim.
async function pendingOrderLines() {
  const { rows } = await pool.query(
    `SELECT shopify_order_id FROM orders
     WHERE status = 'pending' AND square_invoice_id IS NOT NULL
       AND created_at > NOW() - ($1 || ' days')::interval`,
    [String(RESERVE_DAYS)]
  );
  const lines = [];
  for (const row of rows) {
    try {
      const order = await shopify.fetchOrderById(row.shopify_order_id);
      if (order?.cancelled_at) continue;
      for (const li of order?.line_items || []) {
        if (li.variant_id && li.quantity > 0) {
          lines.push({ variant_id: String(li.variant_id), quantity: li.quantity });
        }
      }
    } catch (err) {
      // A pending order we can't read just isn't reserved this round.
      console.error(
        `[InventorySync] Could not read pending order ${row.shopify_order_id}:`,
        err.message
      );
    }
  }
  return lines;
}

// Push the portal's stock picture to Shopify so listings that share vials
// stay in step. The portal ledger is the source of truth: each listing is
// set to what its recipe can make from stock on hand (public.variant_sellable),
// less anything held for unpaid orders. Only listings whose number is wrong
// are written. Throws on failure; callers in a webhook path use syncQuietly.
async function syncShopifyInventory({ reason = 'manual' } = {}) {
  const reserved = await pendingOrderLines();
  const { rows: targets } = await pool.query(
    'SELECT shopify_variant_id, sellable FROM public.variant_sellable($1::jsonb)',
    [JSON.stringify(reserved)]
  );

  let variants;
  try {
    variants = await shopify.listVariantInventory();
  } catch (err) {
    if (/access denied/i.test(err.message)) {
      throw new Error(
        'Shopify refused the inventory read. The app needs the read_products, read_inventory and write_inventory permissions.'
      );
    }
    throw err;
  }
  const byVariant = new Map(variants.map((v) => [v.variantId, v]));

  const changes = [];
  const untracked = [];
  for (const t of targets) {
    const v = byVariant.get(String(t.shopify_variant_id));
    if (!v || !v.inventoryItemId) continue;
    if (!v.tracked) {
      untracked.push(v.variantId);
      continue;
    }
    if (v.inventoryQuantity !== t.sellable) {
      changes.push({
        variantId: v.variantId,
        inventoryItemId: v.inventoryItemId,
        from: v.inventoryQuantity,
        quantity: t.sellable,
      });
    }
  }

  if (changes.length > 0) {
    try {
      await shopify.setAvailableQuantities({
        locationId: config.shopify.locationId,
        quantities: changes,
        referenceUri: `gid://everform-portal/InventorySync/${Date.now()}`,
      });
    } catch (err) {
      if (/access denied/i.test(err.message)) {
        throw new Error(
          'Shopify refused the inventory update. The app needs the write_inventory permission.'
        );
      }
      throw err;
    }
  }

  const result = {
    updated: changes.length,
    checked: targets.length,
    reservedUnits: reserved.reduce((s, l) => s + l.quantity, 0),
    untracked,
    changes: changes.map((c) => ({ variantId: c.variantId, from: c.from, to: c.quantity })),
  };
  await pipeline.log({
    category: 'inventory',
    eventName: 'inventory.shopify_synced',
    status: changes.length > 0 ? 'ok' : 'skipped',
    message:
      changes.length > 0
        ? `Updated ${changes.length} Shopify listing(s) from portal stock (${reason})`
        : `Shopify already matches portal stock (${reason})`,
    payload: result,
  });
  return result;
}

// For webhook paths: a sync failure is logged, never thrown.
async function syncQuietly({ reason, keys = {} } = {}) {
  try {
    return await syncShopifyInventory({ reason });
  } catch (err) {
    console.error('[InventorySync] failed:', err.message);
    await pipeline.log({
      ...keys,
      category: 'inventory',
      eventName: 'inventory.shopify_sync_failed',
      status: 'error',
      errorMessage: err.message,
    });
    return null;
  }
}

module.exports = { syncShopifyInventory, syncQuietly };
