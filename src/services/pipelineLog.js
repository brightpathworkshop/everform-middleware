const pool = require('../db/pool');

// Best-effort logger for pipeline events (Shopify → Square → GHL flow).
// Never throws — a logging failure must never take down the actual
// business logic. Errors are console.error'd so Railway logs still show
// them when we're debugging.
//
// Categories:
//   shopify_webhook — Shopify orders/paid webhook received
//   square_webhook  — Square webhook received (invoice.*, dispute.*, payout.*)
//   square_api      — outbound Square API call (customer, order, invoice)
//   shopify_api     — outbound Shopify API call (markAsPaid, tag add)
//   ghl_api         — outbound GHL API call (contact upsert)
//   db              — internal DB state change (orders.updateStatus etc)
//   commission      — commission row written/updated/refunded
async function log({
  category,
  eventName,
  status = 'ok',
  message = null,
  errorMessage = null,
  durationMs = null,
  orderId = null,
  shopifyOrderId = null,
  shopifyOrderNumber = null,
  squareInvoiceId = null,
  squareAccountId = null,
  customerEmail = null,
  payload = null,
} = {}) {
  try {
    await pool.query(
      `INSERT INTO public.pipeline_events (
         order_id, shopify_order_id, shopify_order_number,
         square_invoice_id, square_account_id, customer_email,
         category, event_name, status, message, error_message,
         duration_ms, payload
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        orderId,
        shopifyOrderId,
        shopifyOrderNumber,
        squareInvoiceId,
        squareAccountId,
        customerEmail ? customerEmail.toLowerCase() : null,
        category,
        eventName,
        status,
        message,
        errorMessage ? String(errorMessage).slice(0, 2000) : null,
        durationMs,
        payload ? JSON.stringify(payload) : null,
      ]
    );
  } catch (err) {
    console.error('[pipelineLog] insert failed:', err.message);
  }
}

// Convenience: measure how long a step took and log the outcome. Wraps
// an async function; whatever the fn returns is returned to the caller.
async function measure(meta, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    await log({
      ...meta,
      status: 'ok',
      durationMs: Date.now() - start,
    });
    return result;
  } catch (err) {
    await log({
      ...meta,
      status: 'error',
      errorMessage: err.message,
      durationMs: Date.now() - start,
    });
    throw err;
  }
}

module.exports = { log, measure };
