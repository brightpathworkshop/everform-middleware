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
  -- Square's hosted invoice page. We already have this at publish time
  -- (publishInvoice returns it) and it's what the customer taps in the
  -- invoice iMessage. Also doubles as the record of what we sent.
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS square_invoice_url TEXT;
  -- Set once, when the invoice URL has been pushed to GHL. The GHL workflow
  -- that sends the invoice iMessage triggers on that field changing, so a
  -- second push is a second text to a real customer. NULL means "not
  -- pushed"; the claim is taken atomically.
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS ghl_invoice_pushed_at TIMESTAMPTZ;
  -- Product dollars refunded on this order so far. Shopify sends one
  -- refunds/create event per refund, so a second partial refund has to reverse
  -- against the cumulative total rather than only its own share — otherwise
  -- two 50% refunds would each ask for 50% and the order would never reach
  -- fully reversed.
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_product_subtotal NUMERIC(10, 2) NOT NULL DEFAULT 0;

  -- One row per tracking number we have pushed to GHL. The GHL workflow that
  -- sends the tracking iMessage triggers on the tracking-number field
  -- changing, so this is what stops a customer being texted twice about the
  -- same parcel.
  --
  -- A ledger rather than a column on orders, because one order legitimately
  -- has several tracking numbers over its life: a split shipment, or a
  -- reshipped lost package. Each distinct number should text exactly once,
  -- and "last number pushed" can't express that — two fulfillments updating
  -- in turn would ping-pong past it and text on every event.
  CREATE TABLE IF NOT EXISTS ghl_tracking_pushes (
    id BIGSERIAL PRIMARY KEY,
    shopify_order_id TEXT NOT NULL,
    tracking_number TEXT NOT NULL,
    pushed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (shopify_order_id, tracking_number)
  );
  CREATE INDEX IF NOT EXISTS idx_tracking_pushes_order
    ON ghl_tracking_pushes(shopify_order_id);

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
