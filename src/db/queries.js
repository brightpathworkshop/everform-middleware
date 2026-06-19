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

const RECRUITING_OVERRIDE_RATE = 0.10;

const commissions = {
  // Write the direct commission row for a paid order, plus (if applicable)
  // the Recruiting Partner override commission row per Addendum A.
  //
  // Both rows for the same order can coexist because the UNIQUE constraint is
  // (shopify_order_id, partner_id, is_override) — direct commission and
  // override commission belong to different partners.
  //
  // Direct row leaves commission_rate_applied + commission_amount NULL until
  // the end-of-month finalize job runs (tier math).
  // Override row is flat 10% per the addendum, so rate + amount are locked
  // at write time; only statement_locked_at flips at month close.
  //
  // Override conditions (Addendum A Sections 2, 3, 7):
  //   - The Sub-Partner has recruited_by_partner_id set (attribution exists).
  //   - recruiting_override_terminated_at is NULL (override hasn't been killed).
  //   - order_date is on or before recruiting_override_ends_at (24-month window
  //     hasn't closed).
  //
  // Returns the direct commission row (or null if it already existed) to
  // preserve the existing caller contract in squareWebhook.js.
  async createForPaidOrder({ orderRow }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Direct commission row. ON CONFLICT preserves idempotency on retries.
      const directInsert = await client.query(
        `INSERT INTO commissions (
           partner_id, referral_id, shopify_order_id, shopify_order_number,
           customer_email, order_date, product_subtotal, statement_period,
           is_override
         )
         SELECT
           r.partner_id, r.id, $1, $2, r.customer_email,
           $3::date, $4, to_char($3::date, 'YYYY-MM'), false
         FROM referrals r
         WHERE r.id = $5
         ON CONFLICT (shopify_order_id, partner_id, is_override) DO NOTHING
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
        // Idempotent path: direct row already existed. Look it up so the
        // override step can still run if it was missed previously (e.g.,
        // because the recruiter relationship was added after the first paid
        // order). source_commission_id needs the direct row's id.
        const lookup = await client.query(
          `SELECT c.*
             FROM commissions c
             JOIN referrals r ON r.id = c.referral_id
            WHERE c.shopify_order_id = $1
              AND c.is_override = false
              AND r.id = $2
            LIMIT 1`,
          [orderRow.shopify_order_id, orderRow.referral_id]
        );
        directRow = lookup.rows[0] || null;
      }

      // 2. Override row, gated on Sub-Partner having an active recruiter
      //    relationship and the order falling inside the 24-month window.
      //    All four termination triggers in Addendum A Section 7 enforced
      //    live: status flips on either partner kill the next override
      //    without needing a separate update pass.
      if (directRow) {
        await client.query(
          `INSERT INTO commissions (
             partner_id, referral_id, shopify_order_id, shopify_order_number,
             customer_email, order_date, product_subtotal, statement_period,
             is_override, source_commission_id,
             commission_rate_applied, commission_amount
           )
           SELECT
             recruiter.id, $1, $2, $3, $4,
             $5::date, $6, to_char($5::date, 'YYYY-MM'),
             true, $7,
             $8::numeric, ($6::numeric * $8::numeric)
           FROM partners sub
           JOIN partners recruiter ON recruiter.id = sub.recruited_by_partner_id
           WHERE sub.id = $9
             AND sub.status = 'active'
             AND sub.recruiting_override_terminated_at IS NULL
             AND (sub.recruiting_override_ends_at IS NULL
                  OR sub.recruiting_override_ends_at >= $5::date)
             AND recruiter.status = 'active'
             AND recruiter.recruiting_addendum_signed_at IS NOT NULL
           ON CONFLICT (shopify_order_id, partner_id, is_override) DO NOTHING`,
          [
            directRow.referral_id,
            orderRow.shopify_order_id,
            orderRow.shopify_order_number,
            directRow.customer_email,
            orderRow.created_at,
            orderRow.product_subtotal,
            directRow.id,
            RECRUITING_OVERRIDE_RATE,
            directRow.partner_id,
          ]
        );
      }

      await client.query('COMMIT');
      // Return only the direct row inserted on THIS call (null on idempotent
      // retry) so squareWebhook.js's existing "wrote vs already-exists" log
      // stays accurate.
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
