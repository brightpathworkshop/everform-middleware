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

  async create({ shopifyCustomerId, squareCustomerId, email, hasCardOnFile }) {
    const { rows } = await pool.query(
      `INSERT INTO customers (shopify_customer_id, square_customer_id, email, has_card_on_file)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (shopify_customer_id) DO UPDATE SET
         square_customer_id = EXCLUDED.square_customer_id,
         email = EXCLUDED.email
       RETURNING *`,
      [shopifyCustomerId, squareCustomerId, email.toLowerCase(), hasCardOnFile || false]
    );
    return rows[0];
  },

  async updateCardOnFile(squareCustomerId, hasCard) {
    await pool.query(
      'UPDATE customers SET has_card_on_file = $1 WHERE square_customer_id = $2',
      [hasCard, squareCustomerId]
    );
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

  async create({ shopifyOrderId, shopifyOrderNumber, total }) {
    const { rows } = await pool.query(
      `INSERT INTO orders (shopify_order_id, shopify_order_number, total, status)
       VALUES ($1, $2, $3, 'pending')
       ON CONFLICT (shopify_order_id) DO NOTHING
       RETURNING *`,
      [shopifyOrderId, shopifyOrderNumber, total]
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

module.exports = { customers, orders };
