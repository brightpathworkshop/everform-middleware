const express = require('express');
const shopify = require('../services/shopify');
const square = require('../services/square');
const db = require('../db/queries');
const { alertMerchant } = require('../services/alerts');

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

  try {
    // 2. Idempotency — skip if we already processed this order
    const existing = await db.orders.findByShopifyOrderId(order.shopifyOrderId);
    if (existing) {
      console.log(`[Shopify Webhook] Order #${order.shopifyOrderNumber} already processed — skipping`);
      return;
    }

    // 3. Store order in DB
    await db.orders.create({
      shopifyOrderId: order.shopifyOrderId,
      shopifyOrderNumber: order.shopifyOrderNumber,
      total: order.total,
    });

    // 4. Find or create Square customer
    const { customer: squareCustomer } = await square.findOrCreateCustomer({
      email: order.email,
      firstName: order.firstName,
      lastName: order.lastName,
      phone: order.phone,
    });

    // 5. Save customer mapping
    const localCustomer = await db.customers.create({
      shopifyCustomerId: order.shopifyCustomerId,
      squareCustomerId: squareCustomer.id,
      email: order.email,
    });

    // 6. Check for card on file
    const card = await square.customerHasCardOnFile(squareCustomer.id);

    if (card) {
      // --- Repeat customer: auto-charge ---
      console.log(`[Order #${order.shopifyOrderNumber}] Card on file found — attempting auto-charge`);

      const payment = await square.chargeCard({
        squareCustomerId: squareCustomer.id,
        cardId: card.id,
        amount: order.total,
        shopifyOrderNumber: order.shopifyOrderNumber,
      });

      if (payment) {
        // Charge succeeded
        await db.orders.updatePayment(order.shopifyOrderId, payment.id);
        await db.customers.updateCardOnFile(squareCustomer.id, true);

        // Mark Shopify order as paid
        try {
          await shopify.markOrderAsPaid(order.shopifyOrderId, {
            squarePaymentId: payment.id,
          });
        } catch (err) {
          console.error(`[Order #${order.shopifyOrderNumber}] Failed to mark as paid, retrying...`);
          // Retry once
          try {
            await shopify.markOrderAsPaid(order.shopifyOrderId, {
              squarePaymentId: payment.id,
            });
          } catch (retryErr) {
            alertMerchant(
              'Shopify update failed',
              `Order #${order.shopifyOrderNumber} was charged but could not be marked paid. Payment: ${payment.id}`
            );
          }
        }
        return;
      }

      // Charge failed — fall back to invoice
      console.log(`[Order #${order.shopifyOrderNumber}] Auto-charge failed — falling back to invoice`);
    }

    // --- New customer or failed charge: send invoice ---
    console.log(`[Order #${order.shopifyOrderNumber}] Creating invoice`);

    const invoice = await square.createAndSendInvoice({
      squareCustomerId: squareCustomer.id,
      shopifyOrderNumber: order.shopifyOrderNumber,
      subtotal: order.subtotal,
      shipping: order.shipping,
    });

    await db.orders.updateInvoice(order.shopifyOrderId, invoice.id);
    console.log(`[Order #${order.shopifyOrderNumber}] Invoice ${invoice.id} sent`);

  } catch (err) {
    console.error(`[Order #${order.shopifyOrderNumber}] Processing failed:`, err.message);
    alertMerchant(
      'Order processing failed',
      `Order #${order.shopifyOrderNumber} (${order.email}): ${err.message}`
    );
  }
});

module.exports = router;
