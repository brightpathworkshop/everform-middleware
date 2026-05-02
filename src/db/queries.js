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
  // Returns null if no referral matches or all matches have expired.
  async findOpenForCustomer({ shopifyCustomerId, email }) {
    const { rows } = await pool.query(
      `SELECT *
         FROM referrals
        WHERE attribution_expires_at >= CURRENT_DATE
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

const commissions = {
  // Write a commission row for a paid order that has a referral attached.
  // commission_rate_applied + commission_amount stay NULL until the
  // end-of-month finalize job runs. statement_period derived from the
  // order's created_at (the date Shopify reported the order, within seconds).
  async createForPaidOrder({ orderRow }) {
    const { rows } = await pool.query(
      `INSERT INTO commissions (
         partner_id, referral_id, shopify_order_id, shopify_order_number,
         customer_email, order_date, product_subtotal, statement_period
       )
       SELECT
         r.partner_id,
         r.id,
         $1,
         $2,
         r.customer_email,
         $3::date,
         $4,
         to_char($3::date, 'YYYY-MM')
       FROM referrals r
       WHERE r.id = $5
       ON CONFLICT (shopify_order_id) DO NOTHING
       RETURNING *`,
      [
        orderRow.shopify_order_id,
        orderRow.shopify_order_number,
        orderRow.created_at,
        orderRow.product_subtotal,
        orderRow.referral_id,
      ]
    );
    return rows[0] || null;
  },
};

module.exports = { customers, orders, referrals, commissions };
