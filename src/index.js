const express = require('express');
const config = require('./config');
const rawBodyMiddleware = require('./middleware/rawBody');
const shopifyWebhook = require('./routes/shopifyWebhook');
const squareWebhook = require('./routes/squareWebhook');
const pool = require('./db/pool');

const app = express();

// Use raw body parser for webhook signature verification
app.use(rawBodyMiddleware);

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'everform-middleware' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Webhook routes
app.use(shopifyWebhook);
app.use(squareWebhook);

// Run migration on startup, then start server
async function start() {
  // Run migrations inline (create tables if not exist)
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        shopify_customer_id TEXT UNIQUE,
        square_customer_id TEXT,
        email TEXT NOT NULL,
        has_card_on_file BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
      CREATE INDEX IF NOT EXISTS idx_customers_shopify_id ON customers(shopify_customer_id);

      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        shopify_order_id TEXT UNIQUE NOT NULL,
        shopify_order_number TEXT,
        square_invoice_id TEXT,
        square_payment_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        total NUMERIC(10, 2),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_orders_shopify_id ON orders(shopify_order_id);
      CREATE INDEX IF NOT EXISTS idx_orders_square_invoice ON orders(square_invoice_id);
    `);
    console.log('[DB] Tables ready');
  } catch (err) {
    console.error('[DB] Migration failed:', err.message);
    process.exit(1);
  }

  app.listen(config.port, () => {
    console.log(`[Server] Everform middleware running on port ${config.port}`);
    console.log(`[Server] Square environment: ${config.square.environment}`);
  });
}

start();
