const express = require('express');
const shopify = require('../services/shopify');
const square = require('../services/square');
const db = require('../db/queries');
const pipeline = require('../services/pipelineLog');
const { alertMerchant } = require('../services/alerts');

const router = express.Router();

// Shared-secret auth for admin-triggered jobs. Portal server actions set
// `X-Reprocess-Secret` matching REPROCESS_SECRET env var. Not user-facing.
function requireJobSecret(req, res, next) {
  const expected = process.env.REPROCESS_SECRET;
  if (!expected) {
    console.error('[jobs] REPROCESS_SECRET not set — refusing all requests');
    return res.status(503).send('Reprocess secret not configured');
  }
  const provided = req.headers['x-reprocess-secret'];
  if (provided !== expected) {
    return res.status(401).send('Unauthorized');
  }
  next();
}

// Reprocess a stuck Shopify order: reruns Square customer + invoice
// creation for a DB order that has status=pending and no square_invoice_id.
// Handles the common "Railway env var missing during the initial webhook
// run" case (like the primary-account switch without redeploying) without
// requiring the shopify order to be recreated.
//
// Body: { shopify_order_id: string }
// NOTE: no express.json() here — the global rawBodyMiddleware in
// src/middleware/rawBody.js already consumes the request stream and
// populates req.body. Adding express.json() on top hangs the second
// parser waiting for a stream that's already ended, producing a 500
// with no useful error surfaced (which is exactly what happened when
// this endpoint was first wired).
router.post('/jobs/reprocess-order', requireJobSecret, async (req, res) => {
  const shopifyOrderId = String(req.body?.shopify_order_id || '').trim();
  if (!shopifyOrderId) {
    return res.status(400).json({ ok: false, error: 'Missing shopify_order_id' });
  }

  try {
    const existing = await db.orders.findByShopifyOrderId(shopifyOrderId);
    if (!existing) {
      return res
        .status(404)
        .json({ ok: false, error: `No order in DB for shopify_order_id ${shopifyOrderId}` });
    }
    if (existing.square_invoice_id) {
      return res.status(409).json({
        ok: false,
        error: `Order already has a Square invoice (${existing.square_invoice_id}). Refusing to double-invoice.`,
      });
    }
    if (existing.status !== 'pending') {
      return res.status(409).json({
        ok: false,
        error: `Order status is "${existing.status}"; only pending orders can be reprocessed`,
      });
    }

    // Fetch full order payload from Shopify Admin API so we get customer
    // details (email, name, phone) that aren't stored in our orders row.
    const raw = await shopify.fetchOrderById(shopifyOrderId);
    const order = shopify.parseOrderPayload(raw);

    const keys = {
      shopifyOrderId: order.shopifyOrderId,
      shopifyOrderNumber: order.shopifyOrderNumber,
      orderId: existing.id,
      customerEmail: order.email,
    };
    await pipeline.log({
      ...keys,
      category: 'shopify_api',
      eventName: 'reprocess.initiated',
      message: `Manual reprocess triggered from admin`,
    });

    // Refuse zero-subtotal orders — Square Invoices API returns 400 on
    // zero-amount invoices, no point retrying.
    if (!(order.subtotal > 0)) {
      await pipeline.log({
        ...keys,
        category: 'shopify_api',
        eventName: 'reprocess.zero_amount_refused',
        status: 'error',
        errorMessage: `Order subtotal is ${order.subtotal} — Square rejects zero-amount invoices. Cancel this order in Shopify or void it here.`,
      });
      return res.status(400).json({
        ok: false,
        error: 'Order subtotal is $0.00; Square rejects zero-amount invoices',
      });
    }

    // Same flow as the shopify webhook route — findOrCreate customer,
    // then createAndSendInvoice. Both are instrumented with pipeline
    // events via services/square.js call sites, so the admin timeline
    // shows the reprocess results.
    const { customer: squareCustomer, isNew } = await pipeline.measure(
      { ...keys, category: 'square_api', eventName: 'square.customer_find_or_create' },
      () =>
        square.findOrCreateCustomer({
          email: order.email,
          firstName: order.firstName,
          lastName: order.lastName,
          phone: order.phone,
        })
    );
    await pipeline.log({
      ...keys,
      category: 'square_api',
      eventName: isNew ? 'square.customer_created' : 'square.customer_found',
      message: `Square customer ${squareCustomer.id}${isNew ? ' (new)' : ' (existing)'}`,
    });

    const { invoice, account } = await pipeline.measure(
      { ...keys, category: 'square_api', eventName: 'square.invoice_create_and_publish' },
      () =>
        square.createAndSendInvoice({
          squareCustomerId: squareCustomer.id,
          shopifyOrderNumber: order.shopifyOrderNumber,
          subtotal: order.subtotal,
          shipping: order.shipping,
        })
    );

    await db.orders.updateInvoice(order.shopifyOrderId, invoice.id);
    await pipeline.log({
      ...keys,
      squareInvoiceId: invoice.id,
      squareAccountId: account?.id || null,
      category: 'square_api',
      eventName: 'square.invoice_published',
      message: `Invoice ${invoice.id} sent to ${order.email} via account "${account?.name || 'unknown'}"`,
      payload: {
        invoice_id: invoice.id,
        account_name: account?.name,
        account_slot: account?.env_var_slot,
      },
    });

    return res.json({
      ok: true,
      shopify_order_id: order.shopifyOrderId,
      shopify_order_number: order.shopifyOrderNumber,
      invoice_id: invoice.id,
      account_name: account?.name || null,
    });
  } catch (err) {
    console.error('[jobs.reprocess-order] failed:', err.message);
    await pipeline.log({
      shopifyOrderId,
      category: 'shopify_api',
      eventName: 'reprocess.failed',
      status: 'error',
      errorMessage: err.message,
    });
    alertMerchant('Order reprocess failed', `${shopifyOrderId}: ${err.message}`);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
