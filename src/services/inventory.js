const pool = require('../db/pool');
const shopify = require('./shopify');
const pipeline = require('./pipelineLog');
const { alertMerchant } = require('./alerts');

// Deduct stock for a paid order. The lot-picking, recipes and idempotency
// all live in the public.consume_order() Postgres function (shared with the
// portal's inventory admin); this just hands it the order's line items.
//
// Never throws. Inventory must not be able to break the payment flow, so
// every failure is logged to pipeline_events and alerted instead.
async function consumeForPaidOrder({ order, keys = {} }) {
  try {
    const shopifyOrder = await shopify.fetchOrderById(order.shopify_order_id);
    const lines = (shopifyOrder?.line_items || [])
      .filter((li) => li.variant_id && li.quantity > 0)
      .map((li) => ({
        variant_id: String(li.variant_id),
        quantity: li.quantity,
        title: li.title || li.name || '',
      }));

    const { rows } = await pool.query(
      'SELECT public.consume_order($1, $2, $3::jsonb, $4) AS result',
      [
        String(order.shopify_order_id),
        order.shopify_order_number ? String(order.shopify_order_number) : null,
        JSON.stringify(lines),
        'square_payment',
      ]
    );
    const result = rows[0]?.result || {};
    const warnings = result.warnings || [];

    if (result.already_consumed) {
      await pipeline.log({
        ...keys,
        category: 'inventory',
        eventName: 'inventory.already_consumed_skip',
        status: 'skipped',
        message: 'Stock already deducted for this order',
      });
      return;
    }

    if (warnings.length > 0) {
      await pipeline.log({
        ...keys,
        category: 'inventory',
        eventName: 'inventory.consumed_with_warnings',
        status: 'error',
        errorMessage: warnings.join(' | '),
        payload: { lines, warnings },
      });
      alertMerchant(
        'Inventory needs a look',
        `Order #${order.shopify_order_number} paid, but stock could not be fully deducted: ${warnings.join(' ')}`
      );
      return;
    }

    await pipeline.log({
      ...keys,
      category: 'inventory',
      eventName: 'inventory.consumed',
      message: `Stock deducted for ${lines.length} line item(s)`,
      payload: { lines },
    });
  } catch (err) {
    console.error(
      `[Inventory] Order #${order.shopify_order_number} stock deduction failed:`,
      err.message
    );
    await pipeline.log({
      ...keys,
      category: 'inventory',
      eventName: 'inventory.consume_failed',
      status: 'error',
      errorMessage: err.message,
    });
    alertMerchant(
      'Inventory deduction failed',
      `Order #${order.shopify_order_number} paid but stock was not deducted: ${err.message}`
    );
  }
}

module.exports = { consumeForPaidOrder };
