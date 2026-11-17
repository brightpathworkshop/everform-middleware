const express = require('express');
const shopify = require('../services/shopify');
const square = require('../services/square');
const db = require('../db/queries');
const { alertMerchant } = require('../services/alerts');
const pipeline = require('../services/pipelineLog');
const inventorySync = require('../services/inventorySync');
const ghlSync = require('../services/ghlSync');
const orderSettlement = require('../services/orderSettlement');

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

    // 4a. Zero-subtotal orders skip Square entirely. Common for internal
    // fulfillment fixups (reshipping a lost package, printing a shipping
    // label with no customer charge). Square Invoices API returns 400 on
    // zero-amount invoices, and there's no money to collect anyway — no
    // point creating one. Mark the order as 'zero_amount' so it stays
    // out of the Stuck Orders panel.
    if (!(order.subtotal > 0)) {
      await db.orders.updateStatus(order.shopifyOrderId, 'zero_amount');
      await pipeline.log({
        ...keys,
        category: 'db',
        eventName: 'orders.zero_amount_skip',
        status: 'skipped',
        message: `Subtotal is $${order.subtotal} — skipping Square invoice creation`,
      });
      return;
    }

    // 4b. Work out what the customer actually still owes.
    //
    // `total_price` on the payload is what the order is worth, not what is
    // left to collect. A customer who spends store credit at checkout has
    // already paid part (or all) of it, and Shopify records that separately
    // without touching the total. Invoicing the total bills them a second
    // time for the covered portion — which is exactly what happened to order
    // #1412: $115.48 invoiced when $108.00 had been paid in credit.
    //
    // If this lookup fails we deliberately fall through to invoicing the full
    // amount, because the overwhelming majority of orders carry no credit and
    // skipping the invoice on a Shopify blip would leave every customer
    // without a payment link. The alert says the figure is unverified so an
    // over-invoice can be caught by hand.
    let amountDue = null;
    try {
      amountDue = await shopify.fetchOrderAmountDue(order.shopifyOrderId);
      if (amountDue.prepaid > 0) {
        await pipeline.log({
          ...keys,
          category: 'shopify_api',
          eventName: 'order.partially_prepaid',
          message:
            `$${amountDue.prepaid.toFixed(2)} of $${amountDue.total.toFixed(2)} prepaid ` +
            `(store credit $${amountDue.storeCredit.toFixed(2)}, gift card $${amountDue.giftCard.toFixed(2)}) — ` +
            `$${(amountDue.total - amountDue.prepaid).toFixed(2)} to invoice`,
          payload: amountDue,
        });
      } else if (amountDue.covered > 0) {
        // Shopify says this order is settled, but not by anything we treat as
        // prepayment — a draft order marked paid by hand, most likely. That
        // is bookkeeping, not money we can see, so it does not reduce the
        // invoice. Logged so the asymmetry is visible rather than silent.
        await pipeline.log({
          ...keys,
          category: 'shopify_api',
          eventName: 'order.settled_outside_prepayment',
          status: 'info',
          message:
            `Shopify reports $${amountDue.covered.toFixed(2)} of $${amountDue.total.toFixed(2)} settled ` +
            `with no store credit or gift card — invoicing the full amount`,
          payload: amountDue,
        });
      }
    } catch (err) {
      console.error(
        `[Order #${order.shopifyOrderNumber}] Amount-due lookup failed:`,
        err.message
      );
      await pipeline.log({
        ...keys,
        category: 'shopify_api',
        eventName: 'order.amount_due_lookup_failed',
        status: 'error',
        errorMessage: err.message,
      });
      alertMerchant(
        'Could not confirm amount due',
        `Order #${order.shopifyOrderNumber}: Shopify would not say how much is outstanding, so the invoice was raised for the full $${order.total}. If the customer paid with store credit or a gift card, that invoice is overstated — check the order and reissue. Error: ${err.message}`
      );
    }

    // 4c. Nothing left to collect. The customer covered the whole order at
    // checkout with store credit or a gift card, so there is no invoice to
    // raise — Square rejects zero-amount invoices, and there is no payment
    // link worth texting someone who already paid. But the order IS paid, and
    // everything that normally follows a payment has to happen anyway: the
    // partner earns their commission, the stock comes off the shelf, the CRM
    // gets refreshed. No Square payment webhook will ever arrive to do it, so
    // settle here.
    //
    // Both conditions are required. `prepaid > 0` is what distinguishes a
    // customer who actually spent a balance from a draft order somebody
    // marked as paid — which also reports nothing outstanding, and which
    // still needs its invoice.
    if (amountDue && amountDue.prepaid > 0 && amountDue.outstanding <= 0) {
      const orderRow = await db.orders.findByShopifyOrderId(order.shopifyOrderId);
      await pipeline.log({
        ...keys,
        orderId: orderRow?.id || null,
        category: 'square_api',
        eventName: 'square.invoice_skipped_prepaid',
        status: 'skipped',
        message: `Order fully prepaid ($${amountDue.prepaid.toFixed(2)}) — no invoice raised`,
        payload: amountDue,
      });
      if (!orderRow) {
        // Can't happen in practice — the row was inserted a few lines up and
        // the duplicate check already ran. Alert rather than settle nothing
        // silently, because the partner's commission hangs off this.
        alertMerchant(
          'Prepaid order not settled',
          `Order #${order.shopifyOrderNumber} was fully covered at checkout but its order row could not be read back, so it was not marked paid. Commission and stock have NOT been recorded.`
        );
        return;
      }
      // settleOrder runs the inventory sync itself, as part of settlement.
      await orderSettlement.settleOrder({
        order: orderRow,
        keys: { ...keys, orderId: orderRow.id },
        paymentId: `store_credit:${order.shopifyOrderId}`,
        source: 'store_credit',
        shopifyNote: `Paid in full at checkout — $${amountDue.prepaid.toFixed(
          2
        )} prepaid (store credit $${amountDue.storeCredit.toFixed(
          2
        )}, gift card $${amountDue.giftCard.toFixed(2)}). No Square invoice raised.`,
      });
      return;
    }

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
          // Deduct only what was genuinely prepaid. The line items still show
          // the real price of the goods; the deduction is stated separately.
          creditApplied: amountDue?.prepaid || 0,
          creditLabel:
            amountDue && amountDue.giftCard > amountDue.storeCredit
              ? 'Gift card applied'
              : 'Store credit applied',
        })
    );

    await db.orders.updateInvoice(
      order.shopifyOrderId,
      invoice.id,
      invoice.publicUrl || null
    );
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

    // 8. Hand the invoice to GHL, which texts the customer the payment link.
    // Also creates the GHL contact if this customer never went through the
    // join flow. Never throws; alerts on failure.
    await ghlSync.pushInvoiceUrl({ order, invoice, keys });

    // Shopify has lowered the listing that was bought; lower the other
    // listings that draw on the same vials. Never throws.
    await inventorySync.syncQuietly({ reason: 'order_created', keys });
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
