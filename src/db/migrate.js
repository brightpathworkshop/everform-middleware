const pool = require('./pool');

const migration = `
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
