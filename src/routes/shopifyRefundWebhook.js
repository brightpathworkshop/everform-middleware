const express = require('express');
const shopify = require('../services/shopify');
const db = require('../db/queries');
const pipeline = require('../services/pipelineLog');
const { alertMerchant } = require('../services/alerts');

const router = express.Router();

// Shopify refunds/create → reverse the partner commission.
//
// Until this existed, commission reversal was wired to Square's
// invoice.refunded event only. But a product return is normally recorded
// against the Shopify order, not as a Square invoice refund, so in practice a
// return never reduced what a partner was owed — across every commission ever
// written, refund_adjustment was zero on every row.
//
// The refunded fraction is computed from the refund's own line items rather
// than from the order total, because commission is earned on product subtotal
// and a refund frequently covers shipping, tax, or a restocking difference
// that the partner was never paid on. A shipping-only refund comes out at 0%
// and correctly changes nothing.
router.post('/webhooks/shopify/refunds', async (req, res) => {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!hmac || !shopify.verifyWebhookSignature(req.rawBody, hmac)) {
    console.warn('[Shopify Refund] Invalid signature — rejected');
    return res.status(401).send('Invalid signature');
  }

  res.status(200).send('OK');

  const payload = req.body || {};
  const shopifyOrderId = payload.order_id != null ? String(payload.order_id) : '';
  if (!shopifyOrderId) {
    console.warn('[Shopify Refund] Payload had no order_id — ignoring');
    return;
  }

  const keys = { shopifyOrderId };

  try {
    const orderRow = await db.orders.findByShopifyOrderId(shopifyOrderId);
    if (!orderRow) {
      await pipeline.log({
        ...keys,
        category: 'shopify_webhook',
        eventName: 'refund.unknown_order',
        status: 'skipped',
        message: 'refunds/create for an order not in our DB — ignoring',
      });
      return;
    }

    keys.orderId = orderRow.id;
    keys.shopifyOrderNumber = orderRow.shopify_order_number;

    // Product dollars coming back on THIS refund.
    const lineItems = Array.isArray(payload.refund_line_items)
      ? payload.refund_line_items
      : [];
    const refundedProduct = lineItems.reduce(
      (s, li) => s + Number(li.subtotal || 0),
      0
    );

    // Commission base for the order, as we recorded it at order time.
    const orderSubtotal = Number(orderRow.product_subtotal || 0);

    if (!(orderSubtotal > 0)) {
      await pipeline.log({
        ...keys,
        category: 'commission',
        eventName: 'refund.no_commission_base',
        status: 'skipped',
        message: `Order has no product subtotal recorded — nothing to reverse`,
      });
      return;
    }

    if (!(refundedProduct > 0)) {
      await pipeline.log({
        ...keys,
        category: 'commission',
        eventName: 'refund.non_product',
        status: 'skipped',
        message:
          'Refund covered no product lines (shipping/tax/adjustment only) — commission unchanged',
        payload: { refund_id: payload.id, order_subtotal: orderSubtotal },
      });
      return;
    }

    // Refunds accumulate: Shopify sends one event per refund, so a second
    // partial refund must reverse against the order's total refunded product
    // to date rather than only its own share. refundForOrder takes a target
    // fraction and tops up to it, so pass the cumulative figure.
    const alreadyRefunded = await db.orders.refundedProductToDate(shopifyOrderId);
    const cumulative = alreadyRefunded + refundedProduct;
    const fraction = Math.min(1, cumulative / orderSubtotal);

    const result = await db.commissions.refundForOrder({
      shopifyOrderId,
      refundFraction: fraction,
    });

    await db.orders.recordRefundedProduct(shopifyOrderId, cumulative);

    const summary =
      `Reversed at ${(fraction * 100).toFixed(0)}% of product subtotal · ` +
      `${result.direct} direct + ${result.overrides} override rows adjusted in place, ` +
      `${result.carried_forward} carried forward from closed periods`;

    console.log(`[Shopify Refund] Order #${orderRow.shopify_order_number}: ${summary}`);
    await pipeline.log({
      ...keys,
      category: 'commission',
      eventName: 'commission.refunded',
      message: summary,
      payload: {
        refund_id: payload.id,
        refunded_product_this_event: refundedProduct,
        refunded_product_cumulative: cumulative,
        order_subtotal: orderSubtotal,
        fraction,
        ...result,
      },
    });

    // A carried-forward reversal changes a partner's balance in a period they
    // are not expecting it, so it is worth knowing about rather than only
    // sitting in a log.
    if (result.carried_forward > 0) {
      alertMerchant(
        'Commission reversal carried forward',
        `Order #${orderRow.shopify_order_number} was refunded (${(fraction * 100).toFixed(
          0
        )}% of product subtotal), but ${result.carried_forward} commission row(s) sat in a statement period that is already closed.\n\nThose periods were left untouched. The reversal has been applied against the current open period instead, and will show on the partner's next statement as a refund adjustment.`
      );
    }
  } catch (err) {
    console.error(
      `[Shopify Refund] Order ${shopifyOrderId} failed:`,
      err.message
    );
    await pipeline.log({
      ...keys,
      category: 'commission',
      eventName: 'refund.processing_failed',
      status: 'error',
      errorMessage: err.message,
    });
    alertMerchant(
      'Commission reversal failed',
      `A refund came in for order ${shopifyOrderId} but reversing the commission failed, so the partner may still be credited for it: ${err.message}`
    );
  }
});

module.exports = router;
