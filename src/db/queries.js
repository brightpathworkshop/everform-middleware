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

  async updateInvoice(shopifyOrderId, squareInvoiceId) {
    await pool.query(
      `UPDATE orders SET square_invoice_id = $1, status = 'invoiced' WHERE shopify_order_id = $2`,
      [squareInvoiceId, shopifyOrderId]
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

module.exports = { customers, orders, referrals, commissions };
