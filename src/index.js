const express = require('express');
const config = require('./config');
const rawBodyMiddleware = require('./middleware/rawBody');
const shopifyAuth = require('./routes/shopifyAuth');
const shopifyWebhook = require('./routes/shopifyWebhook');
const shopifyCustomerWebhook = require('./routes/shopifyCustomerWebhook');
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

// Shopify OAuth install flow
app.use('/auth', shopifyAuth);

// Webhook routes
app.use(shopifyWebhook);
app.use(shopifyCustomerWebhook);
app.use(squareWebhook);

// Start server first (so healthcheck passes), then run migrations
app.listen(config.port, async () => {
  console.log(`[Server] Everform middleware running on port ${config.port}`);
  console.log(`[Server] Square environment: ${config.square.environment}`);
  console.log(`[Server] Shopify Client ID set: ${!!config.shopify.clientId}`);
  console.log(`[Server] Shopify Client Secret set: ${!!config.shopify.clientSecret}`);
  console.log(`[Server] Shopify Admin Token set: ${!!config.shopify.adminApiToken}`);
  console.log(`[Server] GHL API Key set: ${!!config.ghl.apiKey}`);

  // Run migrations
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        shopify_customer_id TEXT UNIQUE,
        square_customer_id TEXT,
        email TEXT NOT NULL,
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
        product_subtotal NUMERIC(10, 2),
        referral_id UUID,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS product_subtotal NUMERIC(10, 2);
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS referral_id UUID;
      CREATE INDEX IF NOT EXISTS idx_orders_shopify_id ON orders(shopify_order_id);
      CREATE INDEX IF NOT EXISTS idx_orders_square_invoice ON orders(square_invoice_id);
      CREATE INDEX IF NOT EXISTS idx_orders_referral_id ON orders(referral_id) WHERE referral_id IS NOT NULL;
    `);
    console.log('[DB] Tables ready');
  } catch (err) {
    console.error('[DB] Migration failed:', err.message);
    console.error('[DB] Webhooks will not work until database is connected.');
  }
});
