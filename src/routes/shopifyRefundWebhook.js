const express = require('express');
const shopify = require('../services/shopify');
const pipeline = require('../services/pipelineLog');
const refundSync = require('../services/refundSync');
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
// This handler deliberately does almost nothing itself: it verifies the
// signature and hands off to refundSync, which re-reads the order's whole
// refund history from Shopify and recomputes. The event is a TRIGGER TO
// RE-SYNC, not a carrier of the delta.
//
// That distinction is the whole point. A return is routinely recorded as two
// refunds — a restock carrying the line items but no money, then a payout
// carrying the money but no line items — so this payload's own line items are
// $0 on the half that moves the money. Order #1381 ($108 returned as store
// credit) reversed nothing at all under the old per-payload arithmetic.
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

  try {
    await refundSync.reconcileRefundsForOrder({
      shopifyOrderId,
      refundId: payload.id ?? null,
      source: 'webhook',
    });
  } catch (err) {
    console.error(`[Shopify Refund] Order ${shopifyOrderId} failed:`, err.message);
    await pipeline.log({
      shopifyOrderId,
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
