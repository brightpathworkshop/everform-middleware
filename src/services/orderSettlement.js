const shopify = require('./shopify');
const db = require('../db/queries');
const pipeline = require('./pipelineLog');
const inventory = require('./inventory');
const inventorySync = require('./inventorySync');
const ghlSync = require('./ghlSync');
const { alertMerchant } = require('./alerts');
const config = require('../config');

// Everything that happens once an order is fully paid for, in one place.
//
// This used to live inline in the Square webhook, which was fine while a
// Square payment was the only way an order could settle. It isn't any more:
// a customer can cover an order entirely with store credit at checkout, in
// which case Shopify leaves nothing outstanding, no Square invoice is ever
// created, and no Square payment webhook will ever arrive. Without a shared
// path, such an order would sit unpaid forever — no commission, no stock
// deduction, no CRM refresh — and the partner who referred it would never be
// credited for a sale that really happened.
//
// Both callers run the same steps in the same order, so there is one
// definition of "settled" rather than two that drift.

// Refresh a customer's CRM fields in GHL after payment. Replaces the Zapier
// Zap that watched Shopify for paid orders and wrote a long list of fields
// back to the contact.
//
// Deliberately a thin subset of what that Zap wrote: last order number and
// date, lifetime order count, lifetime spend. The address fields it copied
// are already set by the contact upsert, and the per-line-item order history
// it maintained was the most fragile part of the Zap for the least use.
//
// Runs at PAYMENT, not order creation, because Shopify's numberOfOrders and
// amountSpent only count what Shopify considers paid — and our orders stay
// unpaid in Shopify until the Square invoice clears. Called immediately after
// markOrderAsPaid, both figures include the order that just paid.
//
// Nothing in GHL triggers on these fields, so this is quiet by design: it
// logs a failure and moves on rather than alerting. No customer is waiting on
// it, and the next order the customer places refreshes the numbers anyway.
async function syncCustomerCrmFields({ order, keys }) {
  try {
    const snap = await shopify.fetchOrderContactSnapshot(order.shopify_order_id);
    if (!snap || !snap.email) {
      await pipeline.log({
        ...keys,
        category: 'ghl_api',
        eventName: 'ghl.crm_sync_no_contact',
        status: 'skipped',
        message: 'No email on the Shopify order — nothing to sync',
      });
      return;
    }

    const k = config.ghl.crmFieldKeys;
    const result = await ghlSync.syncContact({
      name: 'ghl.crm_sync',
      contact: {
        email: snap.email,
        phone: snap.phone,
        firstName: snap.firstName,
        lastName: snap.lastName,
        zip: snap.zip,
        tags: ghlSync.consentTags(snap.smsConsentState),
      },
      // Plain fields, not trigger fields — these ride along with the upsert
      // in a single request.
      fields: {
        [k.lastOrderDate]: snap.orderDateLocal,
        [k.orderCount]: snap.orderCount,
        [k.totalSpend]: snap.totalSpend,
      },
    });
    await pipeline.log({
      ...keys,
      customerEmail: snap.email,
      category: 'ghl_api',
      eventName: 'ghl.crm_synced',
      message: `CRM fields refreshed on GHL contact ${result.contact_id} · ${snap.orderCount} orders · $${snap.totalSpend}`,
      payload: {
        contact_id: result.contact_id,
        unresolved_keys: result.unresolved_keys,
      },
    });
  } catch (err) {
    console.error(
      `[Settlement] Order #${order.shopify_order_number} GHL CRM sync failed:`,
      err.message
    );
    await pipeline.log({
      ...keys,
      category: 'ghl_api',
      eventName: 'ghl.crm_sync_failed',
      status: 'error',
      errorMessage: err.message,
    });
  }
}

// Mark an order paid and run every downstream consequence of that.
//
//   order      the orders row (not the Shopify payload)
//   keys       pipeline log keys for this order
//   paymentId  what goes in orders.square_payment_id. For a Square payment
//              that's the invoice id; for a credit-covered order there is no
//              Square record at all, so the caller passes a synthetic marker.
//   source     'square_payment' | 'store_credit', for the logs
//   shopifyNote  overrides the note written on the Shopify order. The default
//              wording credits a Square invoice, which would be a lie on an
//              order that was never invoiced.
//
// Never throws. Each step guards itself: a commission failure must not stop
// the stock deduction, and a Shopify API failure must not stop the CRM sync.
// Failures that a human needs to act on raise a merchant alert.
async function settleOrder({
  order,
  keys,
  paymentId,
  source = 'square_payment',
  shopifyNote = null,
}) {
  await db.orders.updatePayment(order.shopify_order_id, paymentId);
  await pipeline.log({
    ...keys,
    category: 'db',
    eventName: 'orders.marked_paid',
    message: `orders.status → paid (${source})`,
  });

  // Write commission row if this order was attributed to a partner referral.
  if (order.referral_id) {
    try {
      const commission = await db.commissions.createForPaidOrder({ orderRow: order });
      if (commission) {
        console.log(
          `[Settlement] Order #${order.shopify_order_number} commission row written (referral ${order.referral_id}, subtotal $${order.product_subtotal})`
        );
        await pipeline.log({
          ...keys,
          category: 'commission',
          eventName: 'commission.direct_written',
          message: `Direct commission row written · subtotal $${order.product_subtotal}`,
          payload: { referral_id: order.referral_id, source },
        });
      } else {
        await pipeline.log({
          ...keys,
          category: 'commission',
          eventName: 'commission.already_exists',
          status: 'skipped',
          message: 'Commission row already exists — no reprocess',
        });
      }
    } catch (err) {
      console.error(
        `[Settlement] Order #${order.shopify_order_number} commission write failed:`,
        err.message
      );
      await pipeline.log({
        ...keys,
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

  // Deduct stock for the paid order. Never throws; a failure here is
  // logged and alerted but cannot hold up the rest of the payment flow.
  await inventory.consumeForPaidOrder({ order, keys });
  // Then bring every Shopify listing that shares those vials into line.
  await inventorySync.syncQuietly({ reason: 'order_paid', keys });

  try {
    await pipeline.measure(
      { ...keys, category: 'shopify_api', eventName: 'shopify.order_mark_as_paid' },
      () =>
        shopify.markOrderAsPaid(order.shopify_order_id, {
          squareInvoiceId: order.square_invoice_id || null,
          note: shopifyNote,
        })
    );
    console.log(`[Settlement] Order #${order.shopify_order_number} marked as paid in Shopify`);
  } catch (err) {
    alertMerchant(
      'Shopify update failed after payment',
      `Order #${order.shopify_order_number} settled (${source}) but Shopify was not updated after retries: ${err.message}`
    );
  }

  // Refresh the customer's CRM fields in GHL, now that Shopify counts
  // this order as paid. Never throws.
  await syncCustomerCrmFields({ order, keys });
}

module.exports = { settleOrder, syncCustomerCrmFields };
