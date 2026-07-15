const express = require('express');
const shopify = require('../services/shopify');
const square = require('../services/square');
const db = require('../db/queries');
const { alertMerchant } = require('../services/alerts');
const pipeline = require('../services/pipelineLog');

const router = express.Router();

router.post('/webhooks/shopify/orders', async (req, res) => {
  // 1. Verify webhook signature
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!hmac || !shopify.verifyWebhookSignature(req.rawBody, hmac)) {
    console.warn('[Shopify Webhook] Invalid signature — rejected');
    return res.status(401).send('Invalid signature');
  }

  // Respond immediately so Shopify doesn't retry
  res.status(200).send('OK');

  const order = shopify.parseOrderPayload(req.body);
  console.log(`[Shopify Webhook] Order #${order.shopifyOrderNumber} received (${order.email})`);

  // Common keys applied to every pipeline event for this order.
  const keys = {
    shopifyOrderId: order.shopifyOrderId,
    shopifyOrderNumber: order.shopifyOrderNumber,
    customerEmail: order.email,
  };
  await pipeline.log({
    ...keys,
    category: 'shopify_webhook',
    eventName: 'shopify.order_created',
    message: `Received order #${order.shopifyOrderNumber} · subtotal $${order.subtotal}`,
    payload: {
      subtotal: order.subtotal,
      shipping: order.shipping,
      total: order.total,
    },
  });

  try {
    // 2. Idempotency — skip if we already processed this order
    const existing = await db.orders.findByShopifyOrderId(order.shopifyOrderId);
    if (existing) {
      console.log(`[Shopify Webhook] Order #${order.shopifyOrderNumber} already processed — skipping`);
      await pipeline.log({
        ...keys,
        orderId: existing.id,
        category: 'db',
        eventName: 'orders.duplicate_skip',
        status: 'skipped',
        message: 'Order already exists — no reprocess',
      });
      return;
    }

    // 3. Look up open referral (if customer was referred by a partner).
    const referral = await db.referrals.findOpenForCustomer({
      shopifyCustomerId: order.shopifyCustomerId,
      email: order.email,
    });
    if (referral) {
      console.log(
        `[Order #${order.shopifyOrderNumber}] Attributed to referral ${referral.id} (partner ${referral.partner_id})`
      );
      await pipeline.log({
        ...keys,
        category: 'db',
        eventName: 'referral.attributed',
        message: `Attributed to partner ${referral.partner_id}`,
        payload: { referral_id: referral.id, partner_id: referral.partner_id },
      });
    } else {
      await pipeline.log({
        ...keys,
        category: 'db',
        eventName: 'referral.none',
        status: 'info',
        message: 'No open referral — order not attributed to a partner',
      });
    }

    // 4. Store order in DB
    await db.orders.create({
      shopifyOrderId: order.shopifyOrderId,
      shopifyOrderNumber: order.shopifyOrderNumber,
      total: order.total,
      productSubtotal: order.productSubtotal,
      referralId: referral?.id || null,
    });
    await pipeline.log({
      ...keys,
      category: 'db',
      eventName: 'orders.created',
      message: 'Order row persisted (status=pending)',
    });

    // 5. Find or create Square customer
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
      payload: { square_customer_id: squareCustomer.id },
    });

    // 6. Save customer mapping
    await db.customers.create({
      shopifyCustomerId: order.shopifyCustomerId,
      squareCustomerId: squareCustomer.id,
      email: order.email,
    });

    // 7. Create and send invoice via Square. createAndSendInvoice returns
    // { invoice, account } after the multi-account refactor.
    console.log(`[Order #${order.shopifyOrderNumber}] Creating invoice`);
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
    console.log(`[Order #${order.shopifyOrderNumber}] Invoice ${invoice.id} sent`);
  } catch (err) {
    console.error(`[Order #${order.shopifyOrderNumber}] Processing failed:`, err.message);
    await pipeline.log({
      ...keys,
      category: 'shopify_webhook',
      eventName: 'processing.failed',
      status: 'error',
      errorMessage: err.message,
    });
    alertMerchant(
      'Order processing failed',
      `Order #${order.shopifyOrderNumber} (${order.email}): ${err.message}`
    );
  }
});

module.exports = router;
