const pool = require('./pool');

const migration = `
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
`;

async function migrate() {
  try {
    await pool.query(migration);
    console.log('[DB] Migration complete');
  } catch (err) {
    console.error('[DB] Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
