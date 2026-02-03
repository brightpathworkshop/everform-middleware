const express = require('express');
const square = require('../services/square');
const shopify = require('../services/shopify');
const db = require('../db/queries');
const { alertMerchant } = require('../services/alerts');

const router = express.Router();

router.post('/webhooks/square', async (req, res) => {
  // 1. Verify webhook signature
  const signature = req.headers['x-square-hmacsha256-signature'];
  // Use https explicitly — Railway terminates TLS at the proxy
  const notificationUrl = `https://${req.get('host')}${req.originalUrl}`;

  if (!signature || !square.verifyWebhookSignature(req.rawBody, signature, notificationUrl)) {
    console.warn('[Square Webhook] Invalid signature — rejected');
    return res.status(401).send('Invalid signature');
  }

  res.status(200).send('OK');

  const event = req.body;
  console.log(`[Square Webhook] Event: ${event.type}`);

  try {
    if (event.type === 'invoice.payment_made') {
      const invoiceData = event.data?.object?.invoice;
      if (!invoiceData) {
        console.warn('[Square Webhook] No invoice data in event');
        return;
      }

      const squareInvoiceId = invoiceData.id;

      // Find matching order by invoice ID
      const order = await db.orders.findBySquareInvoiceId(squareInvoiceId);
      if (!order) {
        console.warn(`[Square Webhook] No order found for invoice ${squareInvoiceId}`);
        return;
      }

      if (order.status === 'paid') {
        console.log(`[Square Webhook] Order #${order.shopify_order_number} already paid — skipping`);
        return;
      }

      // Extract payment ID from invoice
      const paymentId = invoiceData.payment_requests?.[0]?.computed_amount_money
        ? squareInvoiceId // Use invoice ID as reference if no direct payment ID
        : squareInvoiceId;

      // Update order status
      await db.orders.updatePayment(order.shopify_order_id, paymentId);

      // Update customer card-on-file status (they just paid, so card is likely saved)
      const recipientId = invoiceData.primary_recipient?.customer_id;
      if (recipientId) {
        await db.customers.updateCardOnFile(recipientId, true);
      }

      // Mark Shopify order as paid
      try {
        await shopify.markOrderAsPaid(order.shopify_order_id, {
          squareInvoiceId,
        });
        console.log(`[Square Webhook] Order #${order.shopify_order_number} marked as paid in Shopify`);
      } catch (err) {
        console.error(`[Square Webhook] Shopify update failed, retrying...`);
        // Retry once
        try {
          await shopify.markOrderAsPaid(order.shopify_order_id, {
            squareInvoiceId,
          });
        } catch (retryErr) {
          alertMerchant(
            'Shopify update failed after payment',
            `Order #${order.shopify_order_number} invoice ${squareInvoiceId} paid but Shopify not updated: ${retryErr.message}`
          );
        }
      }
    }
  } catch (err) {
    console.error('[Square Webhook] Processing failed:', err.message);
    alertMerchant('Square webhook processing failed', err.message);
  }
});

module.exports = router;
