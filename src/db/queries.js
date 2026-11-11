const pool = require('./pool');

const customers = {
  async findByEmail(email) {
    const { rows } = await pool.query(
      'SELECT * FROM customers WHERE email = $1',
      [email.toLowerCase()]
    );
    return rows[0] || null;
  },

  async findByShopifyId(shopifyCustomerId) {
    const { rows } = await pool.query(
      'SELECT * FROM customers WHERE shopify_customer_id = $1',
      [shopifyCustomerId]
    );
    return rows[0] || null;
  },

  async create({ shopifyCustomerId, squareCustomerId, email }) {
    const { rows } = await pool.query(
      `INSERT INTO customers (shopify_customer_id, square_customer_id, email)
       VALUES ($1, $2, $3)
       ON CONFLICT (shopify_customer_id) DO UPDATE SET
         square_customer_id = EXCLUDED.square_customer_id,
         email = EXCLUDED.email
       RETURNING *`,
      [shopifyCustomerId, squareCustomerId, email.toLowerCase()]
    );
    return rows[0];
  },
};

const orders = {
  async findByShopifyOrderId(shopifyOrderId) {
    const { rows } = await pool.query(
      'SELECT * FROM orders WHERE shopify_order_id = $1',
      [shopifyOrderId]
    );
    return rows[0] || null;
  },

  async findBySquareInvoiceId(squareInvoiceId) {
    const { rows } = await pool.query(
      'SELECT * FROM orders WHERE square_invoice_id = $1',
      [squareInvoiceId]
    );
    return rows[0] || null;
  },

  async create({ shopifyOrderId, shopifyOrderNumber, total, productSubtotal, referralId }) {
    const { rows } = await pool.query(
      `INSERT INTO orders (
         shopify_order_id, shopify_order_number, total,
         product_subtotal, referral_id, status
       )
       VALUES ($1, $2, $3, $4, $5, 'pending')
       ON CONFLICT (shopify_order_id) DO NOTHING
       RETURNING *`,
      [shopifyOrderId, shopifyOrderNumber, total, productSubtotal ?? null, referralId ?? null]
    );
    return rows[0] || null;
  },

  async updateInvoice(shopifyOrderId, squareInvoiceId, squareInvoiceUrl = null) {
    await pool.query(
      `UPDATE orders
          SET square_invoice_id = $1,
              square_invoice_url = COALESCE($2, square_invoice_url),
              status = 'invoiced'
        WHERE shopify_order_id = $3`,
      [squareInvoiceId, squareInvoiceUrl, shopifyOrderId]
    );
  },

  // Take the exclusive right to push this order's invoice URL to GHL.
  //
  // The GHL workflow that sends the invoice iMessage triggers on the invoice
  // URL field changing, so pushing twice texts the customer twice. The guard
  // has to hold against sequential retries (the webhook handler re-running, a
  // manual reprocess) and against two handlers racing, so the claim is a
  // single conditional UPDATE: only the caller that flips NULL → NOW() gets a
  // row back, and only that caller pushes.
  //
  // Returns true if the claim is ours, false if someone already pushed.
  async claimGhlInvoicePush(shopifyOrderId) {
    const { rows } = await pool.query(
      `UPDATE orders
          SET ghl_invoice_pushed_at = NOW()
        WHERE shopify_order_id = $1
          AND ghl_invoice_pushed_at IS NULL
        RETURNING id`,
      [shopifyOrderId]
    );
    return rows.length > 0;
  },

  // Hand the claim back after a failed push, so a reprocess can try again.
  // Without this a transient GHL outage would permanently mark the order as
  // "invoice sent" and the customer would never get the message.
  async releaseGhlInvoicePush(shopifyOrderId) {
    await pool.query(
      `UPDATE orders SET ghl_invoice_pushed_at = NULL WHERE shopify_order_id = $1`,
      [shopifyOrderId]
    );
  },

  async updatePayment(shopifyOrderId, squarePaymentId) {
    await pool.query(
      `UPDATE orders SET square_payment_id = $1, status = 'paid' WHERE shopify_order_id = $2`,
      [squarePaymentId, shopifyOrderId]
    );
  },

  async updateStatus(shopifyOrderId, status) {
    await pool.query(
      'UPDATE orders SET status = $1 WHERE shopify_order_id = $2',
      [status, shopifyOrderId]
    );
  },

  // Product dollars refunded on this order so far, across every refund event
  // Shopify has sent for it.
  async refundedProductToDate(shopifyOrderId) {
    const { rows } = await pool.query(
      'SELECT refunded_product_subtotal FROM orders WHERE shopify_order_id = $1',
      [shopifyOrderId]
    );
    return Number(rows[0]?.refunded_product_subtotal || 0);
  },

  // Record the new cumulative figure. GREATEST so a redelivered webhook can
  // never walk the total backwards and make a reversal look partly undone.
  async recordRefundedProduct(shopifyOrderId, cumulative) {
    await pool.query(
      `UPDATE orders
          SET refunded_product_subtotal = GREATEST(refunded_product_subtotal, $1::numeric)
        WHERE shopify_order_id = $2`,
      [Number(cumulative).toFixed(2), shopifyOrderId]
    );
  },
};

// Guard for the tracking iMessage. The GHL workflow fires on the tracking
// number changing, so each distinct number must be pushed exactly once.
const trackingPushes = {
  // Claim the right to push this tracking number. The unique constraint on
  // (order, number) does the work: the first caller inserts and gets a row,
  // every retry conflicts and gets nothing. A different number on the same
  // order — split shipment, or a reship after a lost parcel — is a different
  // key, so it claims and texts as it should.
  //
  // Returns true if the push is ours to make.
  async claim({ shopifyOrderId, trackingNumber }) {
    const { rows } = await pool.query(
      `INSERT INTO ghl_tracking_pushes (shopify_order_id, tracking_number)
       VALUES ($1, $2)
       ON CONFLICT (shopify_order_id, tracking_number) DO NOTHING
       RETURNING id`,
      [shopifyOrderId, trackingNumber]
    );
    return rows.length > 0;
  },

  // Give the claim back after a failed push so a later fulfillment update
  // (or a redelivered webhook) can try again. Without this a transient GHL
  // outage would permanently suppress the tracking text for that parcel.
  async release({ shopifyOrderId, trackingNumber }) {
    await pool.query(
      `DELETE FROM ghl_tracking_pushes
        WHERE shopify_order_id = $1 AND tracking_number = $2`,
      [shopifyOrderId, trackingNumber]
    );
  },
};

const referrals = {
  // Find an open referral attributing this customer to a partner.
  // Prefers shopify_customer_id match; falls back to case-insensitive email.
  // attribution_expires_at IS NULL means the referral is perpetual (e.g.,
  // grandfathered partners). Returns null if no referral matches.
  async findOpenForCustomer({ shopifyCustomerId, email }) {
    const { rows } = await pool.query(
      `SELECT *
         FROM referrals
        WHERE (attribution_expires_at IS NULL OR attribution_expires_at >= CURRENT_DATE)
          AND (
            ($1::text IS NOT NULL AND $1::text <> '' AND shopify_customer_id = $1)
            OR ($2::text IS NOT NULL AND $2::text <> '' AND lower(customer_email) = lower($2))
          )
        ORDER BY signup_date DESC
        LIMIT 1`,
      [shopifyCustomerId || null, email || null]
    );
    return rows[0] || null;
  },
};

// Total commission cap per order (direct + all overrides combined) as a
// fraction of product_subtotal. Under current rates the cap won't trigger
// (max tier 35% + max override chain 15% = 50%), but the logic sits in
// place for future rate changes per the spec.
const TOTAL_COMMISSION_CAP = 0.50;

// Compute the maximum possible direct commission rate for a partner so we
// can evaluate the 50% cap at write time (direct commission's actual amount
// isn't locked until the end-of-month finalize job runs). Conservative — we
// assume the direct partner earns their highest tier for the month.
function maxDirectRate(partner) {
  if (!partner) return 0;
  if (partner.commission_type === 'flat') {
    return Number(partner.commission_rate || 0);
  }
  const tiers = partner.tier_scheme?.tiers || [];
  return tiers.reduce((max, t) => Math.max(max, Number(t.rate || 0)), 0);
}

// Adds `months` calendar months to a Date, preserving day-of-month where
// possible. Used for override window expiry computation.
function addMonthsUTC(date, months) {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

const commissions = {
  // Write the direct commission row for a paid order, plus (if applicable)
  // the Recruiting Partner override commission rows earned by ancestors in
  // the recruitment chain. Multi-level per the RECRUITING_PARTNER_SYSTEM
  // spec: each ancestor's rate comes from their own `override_structure`
  // JSONB config on the partners row — nothing hardcoded here.
  //
  // Chain walk (Phase 2 of the spec):
  //   1. Start at Direct Partner.
  //   2. Walk to recruited_by_partner_id one step at a time, tracking depth.
  //   3. At each ancestor: check ancestor status is 'active', check that the
  //      intermediate between ancestor and Direct Partner is 'active', check
  //      window (currentPartner.approved_at + ancestor.override_window_months
  //      >= order_date). Any failure BREAKS the chain — no further ancestors
  //      earn (per Brandon's call on the "chain-break-on-inactive" open Q).
  //   4. If ancestor's override_structure has an entry for the current level,
  //      compute rate × subtotal and queue an override row.
  //   5. If no entry at this level, ancestor doesn't earn but keep walking —
  //      a higher ancestor with deeper structure might still earn.
  //
  // 50% cap: after all overrides are computed, project total commission
  // (max_direct_rate + sum(override_amounts)). If over 50% of subtotal,
  // reduce override amounts starting from highest level downward until under.
  // Direct is never reduced.
  //
  // Uniqueness: composite index over
  //   (shopify_order_id, partner_id, COALESCE(override_level, 0))
  // allows multiple override rows (different levels) plus a direct row (level
  // NULL → 0) per order per partner. All inserts ON CONFLICT DO NOTHING for
  // webhook retry idempotency.
  //
  // Returns the direct commission row inserted on THIS call (or null if it
  // already existed on retry) to preserve squareWebhook.js's caller contract.
  async createForPaidOrder({ orderRow }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Direct commission row.
      const directInsert = await client.query(
        `INSERT INTO commissions (
           partner_id, referral_id, shopify_order_id, shopify_order_number,
           customer_email, order_date, product_subtotal, statement_period,
           is_override, override_level
         )
         SELECT
           r.partner_id, r.id, $1, $2, r.customer_email,
           $3::date, $4, to_char($3::date, 'YYYY-MM'), false, NULL
         FROM referrals r
         WHERE r.id = $5
         ON CONFLICT (shopify_order_id, partner_id, (COALESCE(override_level, 0))) DO NOTHING
         RETURNING *`,
        [
          orderRow.shopify_order_id,
          orderRow.shopify_order_number,
          orderRow.created_at,
          orderRow.product_subtotal,
          orderRow.referral_id,
        ]
      );

      let directRow = directInsert.rows[0] || null;
      if (!directRow) {
        const lookup = await client.query(
          `SELECT c.*
             FROM commissions c
             JOIN referrals r ON r.id = c.referral_id
            WHERE c.shopify_order_id = $1
              AND (c.override_level IS NULL OR c.override_level = 0)
              AND r.id = $2
            LIMIT 1`,
          [orderRow.shopify_order_id, orderRow.referral_id]
        );
        directRow = lookup.rows[0] || null;
      }

      if (!directRow) {
        // No direct commission (referral disappeared?). Bail cleanly.
        await client.query('COMMIT');
        return null;
      }

      // 2. Pull the recruitment chain from Direct Partner upward. Single
      //    recursive CTE — chain depths are 2-4 in practice, safety cap 10.
      const chainQuery = await client.query(
        `WITH RECURSIVE chain AS (
           SELECT id, status, approved_at, recruited_by_partner_id,
                  override_structure, override_window_months,
                  commission_type, commission_rate, tier_scheme,
                  0 AS depth
             FROM partners
            WHERE id = $1
           UNION ALL
           SELECT p.id, p.status, p.approved_at, p.recruited_by_partner_id,
                  p.override_structure, p.override_window_months,
                  p.commission_type, p.commission_rate, p.tier_scheme,
                  chain.depth + 1
             FROM partners p
             JOIN chain ON p.id = chain.recruited_by_partner_id
            WHERE chain.depth < 10
         )
         SELECT * FROM chain ORDER BY depth`,
        [directRow.partner_id]
      );
      const chain = chainQuery.rows;
      const directPartner = chain[0];

      // 3. Walk the chain, collect overrides.
      const orderDate = new Date(orderRow.created_at);
      const subtotal = Number(orderRow.product_subtotal || 0);
      const overrides = [];

      // Direct partner inactive → no overrides at all (chain-break-on-inactive
      // starting from the base).
      const walkChain = directPartner && directPartner.status === 'active' && subtotal > 0;

      if (walkChain) {
        for (let i = 1; i < chain.length; i++) {
          const ancestor = chain[i];
          const intermediate = chain[i - 1]; // the ancestor's direct recruit in this chain
          const level = i;

          // Chain break: ancestor inactive.
          if (ancestor.status !== 'active') break;
          // Chain break: intermediate (i>1) inactive — for i=1 that's the
          // direct partner, already validated above.
          if (i > 1 && intermediate.status !== 'active') break;

          // Window check: intermediate must be within ancestor's override
          // window relative to their approval date. Null approved_at treated
          // as valid (perpetual — matches the perpetual-attribution pattern
          // used elsewhere in the system).
          if (intermediate.approved_at) {
            const windowMonths = ancestor.override_window_months || 24;
            const windowExpires = addMonthsUTC(intermediate.approved_at, windowMonths);
            if (orderDate > windowExpires) break;
          }

          // Look up ancestor's rate for this level. If they don't have one,
          // they don't earn this order but the chain continues upward for
          // higher ancestors with deeper structures.
          const structure = ancestor.override_structure;
          if (!Array.isArray(structure)) continue;
          const entry = structure.find((e) => Number(e.level) === level);
          if (!entry) continue;

          const rate = Number(entry.rate);
          if (!(rate > 0)) continue;
          const amount = subtotal * rate;

          overrides.push({
            ancestorId: ancestor.id,
            level,
            rate,
            amount,
          });
        }
      }

      // 4. 50% total commission cap. We can't know the exact direct amount
      //    at write time (tier finalize hasn't run), so use the partner's
      //    max possible tier rate as an upper bound.
      const projectedDirect = subtotal * maxDirectRate(directPartner);
      const overrideTotal = overrides.reduce((sum, o) => sum + o.amount, 0);
      const projectedTotal = projectedDirect + overrideTotal;
      const maxAllowed = subtotal * TOTAL_COMMISSION_CAP;
      if (projectedTotal > maxAllowed) {
        let excess = projectedTotal - maxAllowed;
        // Reduce highest-level overrides first.
        const sortedForCap = [...overrides].sort((a, b) => b.level - a.level);
        for (const o of sortedForCap) {
          if (excess <= 0) break;
          const reduction = Math.min(o.amount, excess);
          o.amount -= reduction;
          excess -= reduction;
        }
      }

      // 5. Insert override rows with positive amounts. Zero-or-negative
      //    (fully capped out) rows are skipped to keep the data clean.
      for (const o of overrides) {
        if (o.amount <= 0) continue;
        await client.query(
          `INSERT INTO commissions (
             partner_id, referral_id, shopify_order_id, shopify_order_number,
             customer_email, order_date, product_subtotal, statement_period,
             is_override, source_commission_id,
             override_level, recruited_partner_id,
             commission_rate_applied, commission_amount
           )
           VALUES (
             $1, $2, $3, $4, $5,
             $6::date, $7, to_char($6::date, 'YYYY-MM'),
             true, $8,
             $9, $10,
             $11::numeric, $12::numeric
           )
           ON CONFLICT (shopify_order_id, partner_id, (COALESCE(override_level, 0))) DO NOTHING`,
          [
            o.ancestorId,
            directRow.referral_id,
            orderRow.shopify_order_id,
            orderRow.shopify_order_number,
            directRow.customer_email,
            orderRow.created_at,
            orderRow.product_subtotal,
            directRow.id,
            o.level,
            directPartner.id,
            o.rate,
            o.amount,
          ]
        );
      }

      await client.query('COMMIT');
      return directInsert.rows[0] || null;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
};

// Refund handling on commissions. Cascades the reversal from the direct
// commission row (partner) to every override row generated from it (any
// ancestor Recruiting Partners). The direct row is identified by
// (shopify_order_id, is_override = false); overrides trace back via
// source_commission_id. Idempotent: an already-refunded row (refund_adjustment
// >= commission_amount) is untouched.
// Reverse the commission on a refunded order.
//
// UNITS. refund_adjustment is denominated in SUBTOTAL dollars, not commission
// dollars — the schema says so: net_subtotal is a generated column equal to
// product_subtotal - refund_adjustment. The previous version of this function
// mixed the two, writing commission_amount * fraction (commission dollars)
// into that column whenever the row had been locked, which silently
// under-reversed: on a fully refunded $500 order at 25%, it removed $125 of
// subtotal instead of $500, leaving the row reading as if only a quarter of
// the order came back.
//
// OPEN vs LOCKED. A period that is still open is reversed in place: reducing
// net_subtotal feeds the monthly retroactive tier calculation, so both the
// tier volume and the commission fall out correctly with no separate
// arithmetic. A period that is already locked is never touched — reopening it
// would restate a statement the partner has been paid against — so the
// reversal is carried forward into the current open period as a
// commission_adjustments row, in commission dollars, which is the rule
// Brandon set: carry it forward, don't reopen closed periods.
//
// Returns counts of what it did, split by mechanism, so the caller can log
// which partners had a closed period carried forward.
async function refundCommissionsForOrder({ shopifyOrderId, refundFraction = 1 }) {
  const fraction = Math.max(0, Math.min(1, Number(refundFraction) || 0));
  if (fraction <= 0) {
    return { direct: 0, overrides: 0, carried_forward: 0, skipped_locked: 0 };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT id, partner_id, is_override, override_level, commission_rate_applied,
              commission_amount, product_subtotal, refund_adjustment,
              statement_period, statement_locked_at, shopify_order_number
         FROM public.commissions
        WHERE shopify_order_id = $1
        ORDER BY is_override, override_level NULLS FIRST
        FOR UPDATE`,
      [shopifyOrderId]
    );
    if (rows.length === 0) {
      await client.query('COMMIT');
      return { direct: 0, overrides: 0, carried_forward: 0, skipped_locked: 0 };
    }

    // The period a carried-forward reversal lands in. If this month later
    // locks, the adjustment simply becomes part of that locked month, which is
    // correct — it was earned against it.
    const openPeriod = new Date().toISOString().slice(0, 7);

    let direct = 0;
    let overrides = 0;
    let carriedForward = 0;

    for (const row of rows) {
      const subtotal = Number(row.product_subtotal || 0);
      const currentRefund = Number(row.refund_adjustment || 0);

      if (!row.statement_locked_at) {
        // Still open: reverse in place, in subtotal dollars.
        const target = Math.min(subtotal, subtotal * fraction);
        if (target <= currentRefund + 0.005) continue; // already at or past this
        await client.query(
          `UPDATE public.commissions SET refund_adjustment = $2 WHERE id = $1`,
          [row.id, target.toFixed(2)]
        );

        // Override rows carry their commission_amount from write time and the
        // finalize job only locks them, so unlike a direct row their money
        // does not get recomputed later. Recompute it here off the reduced
        // net subtotal, using the flat per-level rate stored on the row.
        if (row.is_override && row.commission_rate_applied != null) {
          const net = subtotal - target;
          const amount = Math.round(net * Number(row.commission_rate_applied) * 100) / 100;
          await client.query(
            `UPDATE public.commissions SET commission_amount = $2 WHERE id = $1`,
            [row.id, amount.toFixed(2)]
          );
        }

        if (row.is_override) overrides += 1;
        else direct += 1;
        continue;
      }

      // Locked. Leave the row alone and carry the reversal forward. The
      // reversal is in commission dollars because that is what was locked and
      // paid against — there is no tier to recompute after the fact.
      const locked = Number(row.commission_amount || 0);
      const reversal = Math.round(locked * fraction * 100) / 100;
      if (reversal <= 0) continue;

      // Deliberately an upsert keyed on the original row: a redelivered
      // webhook cannot double-reverse, and a partial refund that later becomes
      // a full one tops the same adjustment up rather than adding a second.
      // GREATEST means a smaller later fraction never gives money back by
      // accident.
      await client.query(
        `INSERT INTO public.commission_adjustments (
           partner_id, statement_period, amount, reason,
           shopify_order_id, shopify_order_number,
           source_commission_id, origin_period, notes
         ) VALUES ($1, $2, $3, 'order_refund', $4, $5, $6, $7, $8)
         ON CONFLICT (source_commission_id, reason)
           WHERE source_commission_id IS NOT NULL
         DO UPDATE SET
           amount = LEAST(public.commission_adjustments.amount, EXCLUDED.amount),
           notes = EXCLUDED.notes,
           updated_at = NOW()`,
        [
          row.partner_id,
          openPeriod,
          (-reversal).toFixed(2),
          shopifyOrderId,
          row.shopify_order_number,
          row.id,
          row.statement_period,
          `Refund on order #${row.shopify_order_number} (${row.statement_period}, already closed) at ${(
            fraction * 100
          ).toFixed(0)}%${row.is_override ? ` — level ${row.override_level} override` : ''}`,
        ]
      );
      carriedForward += 1;
    }

    await client.query('COMMIT');
    return {
      direct,
      overrides,
      carried_forward: carriedForward,
      skipped_locked: carriedForward,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Best-effort logger for Square webhook events. Insert-on-receive so we
// always have a record even if the handler crashes; update-after-handler
// records the outcome. Idempotent on square_event_id via the unique
// partial index — a Square replay of the same event no-ops on the insert.
const squareWebhookEvents = {
  async insertReceived({
    squareAccountId,
    squareEventId,
    eventType,
    objectId,
    merchantId,
    payload,
  }) {
    try {
      const { rows } = await pool.query(
        `INSERT INTO public.square_webhook_events
           (square_account_id, square_event_id, event_type, object_id, merchant_id, payload)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (square_event_id) DO NOTHING
         RETURNING id`,
        [
          squareAccountId,
          squareEventId || null,
          eventType,
          objectId || null,
          merchantId || null,
          payload ? JSON.stringify(payload) : null,
        ]
      );
      return rows[0]?.id || null;
    } catch (err) {
      console.error('[db.squareWebhookEvents.insertReceived] failed:', err.message);
      return null;
    }
  },

  async markProcessed(id, { processedOk, error }) {
    if (!id) return;
    try {
      await pool.query(
        `UPDATE public.square_webhook_events
            SET processed_ok = $2, processing_error = $3
          WHERE id = $1`,
        [id, processedOk, error ? String(error).slice(0, 2000) : null]
      );
    } catch (err) {
      console.error('[db.squareWebhookEvents.markProcessed] failed:', err.message);
    }
  },
};

commissions.refundForOrder = refundCommissionsForOrder;

module.exports = {
  customers,
  orders,
  trackingPushes,
  referrals,
  commissions,
  squareWebhookEvents,
};
