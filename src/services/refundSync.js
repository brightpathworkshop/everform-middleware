const shopify = require('./shopify');
const db = require('../db/queries');
const pipeline = require('./pipelineLog');
const { alertMerchant } = require('./alerts');

// Bring an order's commission rows in line with what Shopify says has been
// refunded on it.
//
// Shared by the refunds/create webhook and the /jobs/resync-refunds endpoint
// so the manual recovery path and the automatic one cannot drift: a repair
// run exercises exactly the code a live refund does.
//
// Idempotent by construction. It computes a TARGET refunded fraction from the
// order's whole refund history and hands that to refundForOrder, which tops
// up to the target rather than applying a delta. Running it twice, or running
// it after a redelivered webhook, converges on the same numbers.
//
// `source` only labels the pipeline log, so a repair is distinguishable from
// a live refund after the fact.
async function reconcileRefundsForOrder({ shopifyOrderId, refundId = null, source = 'webhook' }) {
  const keys = { shopifyOrderId };

  const orderRow = await db.orders.findByShopifyOrderId(shopifyOrderId);
  if (!orderRow) {
    await pipeline.log({
      ...keys,
      category: 'shopify_webhook',
      eventName: 'refund.unknown_order',
      status: 'skipped',
      message: 'Refund for an order not in our DB — ignoring',
    });
    return { ok: true, status: 'unknown_order' };
  }

  keys.orderId = orderRow.id;
  keys.shopifyOrderNumber = orderRow.shopify_order_number;

  // Product dollars refunded across EVERY refund on this order, read back
  // from Shopify rather than taken from a webhook payload. See
  // shopify.fetchRefundedProductSubtotal for why the payload is not enough.
  const cumulative = await shopify.fetchRefundedProductSubtotal(shopifyOrderId);

  // Commission base for the order, as we recorded it at order time.
  const orderSubtotal = Number(orderRow.product_subtotal || 0);

  if (!(orderSubtotal > 0)) {
    await pipeline.log({
      ...keys,
      category: 'commission',
      eventName: 'refund.no_commission_base',
      status: 'skipped',
      message: 'Order has no product subtotal recorded — nothing to reverse',
    });
    return { ok: true, status: 'no_commission_base' };
  }

  if (!(cumulative > 0)) {
    await pipeline.log({
      ...keys,
      category: 'commission',
      eventName: 'refund.non_product',
      status: 'skipped',
      message:
        'No product lines refunded on this order (shipping/tax/adjustment only) — commission unchanged',
      payload: { refund_id: refundId, order_subtotal: orderSubtotal, source },
    });
    return { ok: true, status: 'non_product', cumulative: 0 };
  }

  const fraction = Math.min(1, cumulative / orderSubtotal);

  const result = await db.commissions.refundForOrder({
    shopifyOrderId,
    refundFraction: fraction,
  });

  await db.orders.recordRefundedProduct(shopifyOrderId, cumulative);

  const summary =
    `Reversed at ${(fraction * 100).toFixed(0)}% of product subtotal ` +
    `($${cumulative.toFixed(2)} of $${orderSubtotal.toFixed(2)}) · ` +
    `${result.direct} direct + ${result.overrides} override rows adjusted in place, ` +
    `${result.carried_forward} carried forward from closed periods`;

  console.log(`[Refund Sync] Order #${orderRow.shopify_order_number}: ${summary}`);
  await pipeline.log({
    ...keys,
    category: 'commission',
    eventName: 'commission.refunded',
    message: summary,
    payload: {
      refund_id: refundId,
      refunded_product_cumulative: cumulative,
      order_subtotal: orderSubtotal,
      fraction,
      source,
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

  return {
    ok: true,
    status: 'reversed',
    orderNumber: orderRow.shopify_order_number,
    cumulative,
    orderSubtotal,
    fraction,
    ...result,
  };
}

module.exports = { reconcileRefundsForOrder };
