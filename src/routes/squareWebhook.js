const express = require('express');
const square = require('../services/square');
const shopify = require('../services/shopify');
const db = require('../db/queries');
const { alertMerchant } = require('../services/alerts');
const pipeline = require('../services/pipelineLog');

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
        await pipeline.log({
          squareInvoiceId,
          squareAccountId: matchedAccount.id,
          category: 'square_webhook',
          eventName: 'invoice.payment_made.no_match',
          status: 'error',
          errorMessage: `No order row for invoice ${squareInvoiceId}`,
        });
        await db.squareWebhookEvents.markProcessed(logId, {
          processedOk: false,
          error: `no order found for invoice ${squareInvoiceId}`,
        });
        return;
      }

      const orderKeys = {
        orderId: order.id,
        shopifyOrderId: order.shopify_order_id,
        shopifyOrderNumber: order.shopify_order_number,
        squareInvoiceId,
        squareAccountId: matchedAccount.id,
      };
      await pipeline.log({
        ...orderKeys,
        category: 'square_webhook',
        eventName: 'invoice.payment_made',
        message: `Square reports payment on invoice ${squareInvoiceId}`,
      });

      if (order.status === 'paid') {
        console.log(`[Square Webhook] Order #${order.shopify_order_number} already paid — skipping`);
        await pipeline.log({
          ...orderKeys,
          category: 'db',
          eventName: 'orders.already_paid_skip',
          status: 'skipped',
        });
        await db.squareWebhookEvents.markProcessed(logId, { processedOk: true });
        return;
      }

      const paymentId = squareInvoiceId;
      await db.orders.updatePayment(order.shopify_order_id, paymentId);
      await pipeline.log({
        ...orderKeys,
        category: 'db',
        eventName: 'orders.marked_paid',
        message: 'orders.status → paid',
      });

      // Write commission row if this order was attributed to a partner referral.
      if (order.referral_id) {
        try {
          const commission = await db.commissions.createForPaidOrder({ orderRow: order });
          if (commission) {
            console.log(
              `[Square Webhook] Order #${order.shopify_order_number} commission row written (referral ${order.referral_id}, subtotal $${order.product_subtotal})`
            );
            await pipeline.log({
              ...orderKeys,
              category: 'commission',
              eventName: 'commission.direct_written',
              message: `Direct commission row written · subtotal $${order.product_subtotal}`,
              payload: { referral_id: order.referral_id },
            });
          } else {
            await pipeline.log({
              ...orderKeys,
              category: 'commission',
              eventName: 'commission.already_exists',
              status: 'skipped',
              message: 'Commission row already exists — no reprocess',
            });
          }
        } catch (err) {
          console.error(
            `[Square Webhook] Order #${order.shopify_order_number} commission write failed:`,
            err.message
          );
          await pipeline.log({
            ...orderKeys,
            category: 'commission',
            eventName: 'commission.write_failed',
            status: 'error',
            errorMessage: err.message,
          });
          alertMerchant(
            'Commission write failed',
            `Order #${order.shopify_order_number} (referral ${order.referral_id}) paid but commission row not written: ${err.message}`
          );
        }
      }

      try {
        await pipeline.measure(
          { ...orderKeys, category: 'shopify_api', eventName: 'shopify.order_mark_as_paid' },
          () => shopify.markOrderAsPaid(order.shopify_order_id, { squareInvoiceId })
        );
        console.log(`[Square Webhook] Order #${order.shopify_order_number} marked as paid in Shopify`);
      } catch (err) {
        alertMerchant(
          'Shopify update failed after payment',
          `Order #${order.shopify_order_number} invoice ${squareInvoiceId} paid but Shopify not updated after retries: ${err.message}`
        );
      }
      await db.squareWebhookEvents.markProcessed(logId, { processedOk: true });
    } else if (event.type === 'invoice.refunded') {
      const invoiceData = event.data?.object?.invoice;
      if (!invoiceData) {
        await db.squareWebhookEvents.markProcessed(logId, {
          processedOk: false,
          error: 'no invoice data in refund event',
        });
        return;
      }
      const squareInvoiceId = invoiceData.id;
      const order = await db.orders.findBySquareInvoiceId(squareInvoiceId);
      if (!order) {
        console.warn(`[Square Webhook] Refund: no order for invoice ${squareInvoiceId}`);
        await pipeline.log({
          squareInvoiceId,
          squareAccountId: matchedAccount.id,
          category: 'square_webhook',
          eventName: 'invoice.refunded.no_match',
          status: 'error',
          errorMessage: `No order row for invoice ${squareInvoiceId}`,
        });
        await db.squareWebhookEvents.markProcessed(logId, {
          processedOk: false,
          error: `no order found for invoice ${squareInvoiceId}`,
        });
        return;
      }

      const refundKeys = {
        orderId: order.id,
        shopifyOrderId: order.shopify_order_id,
        shopifyOrderNumber: order.shopify_order_number,
        squareInvoiceId,
        squareAccountId: matchedAccount.id,
      };
      await pipeline.log({
        ...refundKeys,
        category: 'square_webhook',
        eventName: 'invoice.refunded',
        message: `Square refund posted on invoice ${squareInvoiceId}`,
      });

      // Refund fraction: Square includes payment_requests[].total_completed_amount_money
      // for the original charge; refunded_money if present tells us how much
      // came back. When we can compute it, do proportional reversal;
      // otherwise treat as full refund.
      let refundFraction = 1;
      try {
        const pr = invoiceData.payment_requests?.[0];
        const paid = Number(pr?.total_completed_amount_money?.amount || 0);
        const refunded = Number(pr?.refunded_money?.amount || 0);
        if (paid > 0 && refunded > 0 && refunded < paid) {
          refundFraction = refunded / paid;
        }
      } catch {
        // fall through with full refund
      }

      const result = await db.commissions.refundForOrder({
        shopifyOrderId: order.shopify_order_id,
        refundFraction,
      });
      console.log(
        `[Square Webhook] Refund for order #${order.shopify_order_number}: reversed ${result.direct} direct + ${result.overrides} override rows (fraction ${refundFraction.toFixed(2)})`
      );
      await pipeline.log({
        ...refundKeys,
        category: 'commission',
        eventName: 'commission.refunded',
        message: `Reversed ${result.direct} direct + ${result.overrides} override rows at ${(refundFraction * 100).toFixed(0)}%`,
        payload: { refund_fraction: refundFraction, ...result },
      });

      // Flip the order status so the ledger + admin views reflect it.
      try {
        await db.orders.updateStatus(order.shopify_order_id, 'refunded');
        await pipeline.log({
          ...refundKeys,
          category: 'db',
          eventName: 'orders.marked_refunded',
        });
      } catch (err) {
        console.error('[Square Webhook] Order status update failed:', err.message);
        await pipeline.log({
          ...refundKeys,
          category: 'db',
          eventName: 'orders.mark_refunded_failed',
          status: 'error',
          errorMessage: err.message,
        });
      }

      // Note the Shopify order for the admin trail — we do NOT auto-create
      // a Shopify refund transaction (that requires inventory + line-item
      // decisions Brandon handles manually).
      try {
        await shopify.addOrderNote(
          order.shopify_order_id,
          `Square refund received on invoice ${squareInvoiceId}${
            refundFraction < 1 ? ` (partial: ${(refundFraction * 100).toFixed(0)}%)` : ''
          }. Commission reversed. Review Shopify order status + inventory manually.`
        );
      } catch (err) {
        console.error('[Square Webhook] Shopify order note failed:', err.message);
      }

      alertMerchant(
        'Square refund received',
        `Order #${order.shopify_order_number} · invoice ${squareInvoiceId} · ${refundFraction < 1 ? `partial ${(refundFraction * 100).toFixed(0)}%` : 'full'} refund. Commission auto-reversed. Review Shopify status + inventory.`
      );

      await db.squareWebhookEvents.markProcessed(logId, { processedOk: true });
    } else {
      // Unhandled event type — logged for visibility, no action taken.
      // Log it to pipeline_events too with whatever object we can extract
      // (invoice/dispute/payout id) so it shows up in the unified feed.
      console.log(`[Square Webhook] ${event.type} logged, no handler yet`);
      const obj = event.data?.object || {};
      const inferredInvoiceId = obj.invoice?.id || null;
      let inferredOrder = null;
      if (inferredInvoiceId) {
        try {
          inferredOrder = await db.orders.findBySquareInvoiceId(inferredInvoiceId);
        } catch {
          // best-effort lookup
        }
      }
      await pipeline.log({
        squareAccountId: matchedAccount.id,
        squareInvoiceId: inferredInvoiceId,
        orderId: inferredOrder?.id || null,
        shopifyOrderId: inferredOrder?.shopify_order_id || null,
        shopifyOrderNumber: inferredOrder?.shopify_order_number || null,
        category: 'square_webhook',
        eventName: event.type,
        status: 'info',
        message: 'Received, no handler wired',
      });
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
