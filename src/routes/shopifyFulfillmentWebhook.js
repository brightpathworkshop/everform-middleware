const express = require('express');
const shopify = require('../services/shopify');
const db = require('../db/queries');
const pipeline = require('../services/pipelineLog');
const ghlSync = require('../services/ghlSync');

const router = express.Router();

// Shopify fulfillment webhooks → GHL tracking fields, which is what sends the
// customer their tracking iMessage. Replaces the last Zapier Zap.
//
// Subscribed to BOTH fulfillments/create and fulfillments/update, on one
// endpoint. A fulfillment is frequently created before its shipping label
// exists, so the tracking number arrives on a later update rather than at
// creation — listening only for create would mean never texting those
// customers. Listening to both means the same parcel arrives here several
// times, which is why the push is guarded per tracking number in
// ghl_tracking_pushes: the first event carrying a given number sends, every
// later event carrying it does nothing, and a genuinely new number (split
// shipment, reship after a lost parcel) sends again as it should.
router.post('/webhooks/shopify/fulfillments', async (req, res) => {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!hmac || !shopify.verifyWebhookSignature(req.rawBody, hmac)) {
    console.warn('[Shopify Fulfillment] Invalid signature — rejected');
    return res.status(401).send('Invalid signature');
  }

  // Acknowledge immediately so Shopify doesn't retry while we work.
  res.status(200).send('OK');

  const topic = req.headers['x-shopify-topic'] || 'fulfillments/unknown';
  const fulfillment = shopify.parseFulfillmentPayload(req.body);

  if (!fulfillment.shopifyOrderId) {
    console.warn('[Shopify Fulfillment] Payload had no order_id — ignoring');
    return;
  }

  const keys = {
    shopifyOrderId: fulfillment.shopifyOrderId,
  };

  try {
    // Our own order row gives us the order number for logs and alerts, and
    // tells us this is an order we actually handle. Orders predating the
    // middleware, or created outside it, aren't ours to message about.
    const orderRow = await db.orders.findByShopifyOrderId(fulfillment.shopifyOrderId);
    if (!orderRow) {
      await pipeline.log({
        ...keys,
        category: 'shopify_webhook',
        eventName: 'fulfillment.unknown_order',
        status: 'skipped',
        message: `${topic} for an order not in our DB — ignoring`,
      });
      return;
    }

    keys.orderId = orderRow.id;
    keys.shopifyOrderNumber = orderRow.shopify_order_number;

    await pipeline.log({
      ...keys,
      category: 'shopify_webhook',
      eventName: 'fulfillment.received',
      message: `${topic} · ${
        fulfillment.trackingNumber
          ? `tracking ${fulfillment.trackingNumber} (${fulfillment.carrier || 'no carrier'})`
          : 'no tracking number yet'
      }`,
      payload: {
        topic,
        fulfillment_id: fulfillment.fulfillmentId,
        status: fulfillment.status,
        shipment_status: fulfillment.shipmentStatus,
      },
    });

    // Nothing to send yet — don't spend a Shopify API call looking up the
    // customer for a fulfillment that has no tracking number on it.
    if (!fulfillment.trackingNumber) {
      await ghlSync.pushTracking({
        shopifyOrderId: fulfillment.shopifyOrderId,
        orderNumber: orderRow.shopify_order_number,
        contact: null,
        fulfillment,
        keys,
      });
      return;
    }

    // A fulfillment payload carries no customer details, so the contact to
    // upsert against comes from the order.
    const snap = await shopify.fetchOrderContactSnapshot(fulfillment.shopifyOrderId);

    await ghlSync.pushTracking({
      shopifyOrderId: fulfillment.shopifyOrderId,
      orderNumber: orderRow.shopify_order_number,
      contact: snap,
      fulfillment,
      keys,
    });
  } catch (err) {
    console.error(
      `[Shopify Fulfillment] ${topic} for order ${fulfillment.shopifyOrderId} failed:`,
      err.message
    );
    await pipeline.log({
      ...keys,
      category: 'shopify_webhook',
      eventName: 'fulfillment.processing_failed',
      status: 'error',
      errorMessage: err.message,
    });
  }
});

module.exports = router;
