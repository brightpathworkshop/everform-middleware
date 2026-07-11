const express = require('express');
const square = require('../services/square');
const shopify = require('../services/shopify');
const db = require('../db/queries');
const { alertMerchant } = require('../services/alerts');

const router = express.Router();

router.post('/webhooks/square', async (req, res) => {
  // 1. Verify webhook signature against every active Square account. The
  //    matched account is returned so we can log which account fired the
  //    event — useful once multiple accounts are configured. Both
  //    accounts point their webhooks at this same URL.
  const signature = req.headers['x-square-hmacsha256-signature'];
  const notificationUrl = `https://${req.get('host')}${req.originalUrl}`;

  const matchedAccount = signature
    ? await square.verifyWebhookSignatureAndFindAccount(
        req.rawBody,
        signature,
        notificationUrl
      )
    : null;

  if (!matchedAccount) {
    console.warn('[Square Webhook] Invalid signature — rejected');
    return res.status(401).send('Invalid signature');
  }

  res.status(200).send('OK');

  const event = req.body;
  console.log(
    `[Square Webhook] Event: ${event.type} · account: ${matchedAccount.name} (slot ${matchedAccount.env_var_slot})`
  );

  // Log the event as soon as we've validated the signature. Update the
  // processed flag after the handler runs (or set to null if no handler
  // — acknowledged but no action needed).
  const object = event.data?.object || {};
  const objectId =
    object.invoice?.id || object.dispute?.id || object.payout?.id || null;
  const logId = await db.squareWebhookEvents.insertReceived({
    squareAccountId: matchedAccount.id,
    squareEventId: event.event_id,
    eventType: event.type,
    objectId,
    merchantId: event.merchant_id,
    payload: object,
  });

  try {
    if (event.type === 'invoice.payment_made') {
      const invoiceData = event.data?.object?.invoice;
      if (!invoiceData) {
        console.warn('[Square Webhook] No invoice data in event');
        await db.squareWebhookEvents.markProcessed(logId, {
          processedOk: false,
          error: 'no invoice data in event',
        });
        return;
      }

      const squareInvoiceId = invoiceData.id;

      // Find matching order by invoice ID
      const order = await db.orders.findBySquareInvoiceId(squareInvoiceId);
      if (!order) {
        console.warn(`[Square Webhook] No order found for invoice ${squareInvoiceId}`);
        await db.squareWebhookEvents.markProcessed(logId, {
          processedOk: false,
          error: `no order found for invoice ${squareInvoiceId}`,
        });
        return;
      }

      if (order.status === 'paid') {
        console.log(`[Square Webhook] Order #${order.shopify_order_number} already paid — skipping`);
        await db.squareWebhookEvents.markProcessed(logId, { processedOk: true });
        return;
      }

      // Extract payment ID from invoice
      const paymentId = invoiceData.payment_requests?.[0]?.computed_amount_money
        ? squareInvoiceId // Use invoice ID as reference if no direct payment ID
        : squareInvoiceId;

      // Update order status
      await db.orders.updatePayment(order.shopify_order_id, paymentId);

      // Write commission row if this order was attributed to a partner referral.
      if (order.referral_id) {
        try {
          const commission = await db.commissions.createForPaidOrder({ orderRow: order });
          if (commission) {
            console.log(
              `[Square Webhook] Order #${order.shopify_order_number} commission row written (referral ${order.referral_id}, subtotal $${order.product_subtotal})`
            );
          } else {
            console.log(
              `[Square Webhook] Order #${order.shopify_order_number} commission already exists — skipping`
            );
          }
        } catch (err) {
          console.error(
            `[Square Webhook] Order #${order.shopify_order_number} commission write failed:`,
            err.message
          );
          alertMerchant(
            'Commission write failed',
            `Order #${order.shopify_order_number} (referral ${order.referral_id}) paid but commission row not written: ${err.message}`
          );
        }
      }

      // Mark Shopify order as paid (shopifyGraphQL retries transient errors internally)
      try {
        await shopify.markOrderAsPaid(order.shopify_order_id, { squareInvoiceId });
        console.log(`[Square Webhook] Order #${order.shopify_order_number} marked as paid in Shopify`);
      } catch (err) {
        alertMerchant(
          'Shopify update failed after payment',
          `Order #${order.shopify_order_number} invoice ${squareInvoiceId} paid but Shopify not updated after retries: ${err.message}`
        );
      }
      await db.squareWebhookEvents.markProcessed(logId, { processedOk: true });
    } else {
      // Unhandled event type — logged for visibility, no action taken.
      // processed_ok stays NULL so the admin log renders it as "logged"
      // (distinct from "handled OK" and "handler errored").
      console.log(`[Square Webhook] ${event.type} logged, no handler yet`);
    }
  } catch (err) {
    console.error('[Square Webhook] Processing failed:', err.message);
    await db.squareWebhookEvents.markProcessed(logId, {
      processedOk: false,
      error: err.message,
    });
    alertMerchant('Square webhook processing failed', err.message);
  }
});

module.exports = router;
