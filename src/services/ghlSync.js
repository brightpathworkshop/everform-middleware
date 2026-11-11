const config = require('../config');
const { withRetry } = require('./retry');
const db = require('../db/queries');
const pipeline = require('./pipelineLog');
const { alertMerchant } = require('./alerts');

// GHL writes, routed through the portal.
//
// We don't call GHL directly from here. The portal owns the only GHL client
// that resolves merge-tag keys ("square_invoice_url") to GHL field IDs at
// runtime, and a second copy of that resolution logic would be a second thing
// to keep in step — with the failure mode being a field that quietly stops
// being written, which nobody notices until a customer says they never got
// their tracking number.
//
// This replaces three Zapier Zaps:
//   1. Square invoice created → GHL invoice URL + order number
//   2. Shopify order paid     → GHL customer CRM fields
//   3. Shopify tracking       → GHL carrier + tracking number + URL
//
// Zaps 1 and 3 drive customer-facing iMessages through GHL workflows that
// trigger on a field change. That makes an accidental second write a second
// text message to a real customer, so every caller of this guards itself in
// the orders table before pushing. See the ghl_* columns and the
// claim/release helpers in src/db/queries.js.

const SYNC_PATH = '/api/internal/ghl-sync';

// GHL's contact search index lags its own writes by a beat. The portal
// returns 409 when it upserted a contact but couldn't find it again to write
// the trigger fields. That's transient and worth one more go, but it isn't in
// retry.js's retryable set (it isn't a 5xx and shouldn't be for other calls),
// so it's handled here.
const SEARCH_LAG_RETRY_MS = 1500;

function configured() {
  return Boolean(config.portal.baseUrl && config.portal.sharedSecret);
}

async function postSync(body) {
  const url = `${config.portal.baseUrl.replace(/\/$/, '')}${SYNC_PATH}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Reprocess-Secret': config.portal.sharedSecret,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`GHL sync ${res.status}: ${text.slice(0, 500)}`);
    err.statusCode = res.status;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`GHL sync returned non-JSON: ${text.slice(0, 200)}`);
  }
}

// Upsert a GHL contact and optionally write trigger fields.
//
//   contact       { email, phone, firstName, lastName, tags, zip }
//   fields        { bareFieldKey: value }  written with the upsert
//   triggerFields { bareFieldKey: value }  written as a separate update
//
// Throws on failure. Callers decide what a failure means: for the invoice and
// tracking pushes it means a customer is waiting on a message that never
// went, so those release their claim and alert rather than swallowing it.
async function syncContact({ contact, fields, triggerFields, name = 'ghl.sync' }) {
  if (!configured()) {
    throw new Error(
      'GHL sync not configured (needs PORTAL_BASE_URL and REPROCESS_SECRET)'
    );
  }
  if (!contact?.email) {
    throw new Error('GHL sync requires contact.email');
  }

  const body = {
    contact: {
      email: contact.email,
      phone: contact.phone || '',
      firstName: contact.firstName || '',
      lastName: contact.lastName || '',
      tags: contact.tags || [],
      zip: contact.zip || null,
    },
    fields: fields || {},
    triggerFields: triggerFields || {},
  };

  try {
    return await withRetry(() => postSync(body), { name });
  } catch (err) {
    if (err.statusCode === 409) {
      await new Promise((r) => setTimeout(r, SEARCH_LAG_RETRY_MS));
      return await withRetry(() => postSync(body), { name: `${name}.retry` });
    }
    throw err;
  }
}

// Shopify reports SMS marketing consent as lowercase "subscribed" on REST
// webhook payloads and uppercase "SUBSCRIBED" on GraphQL. Both reach this
// code from different paths, so neither spelling is wrong — compare folded.
function consentTags(state) {
  return String(state || '').toLowerCase() === 'subscribed'
    ? ['sms-marketing-consent']
    : [];
}

// Push the Square invoice to GHL, which is what actually delivers the
// "here's your invoice" iMessage. Replaces the Zapier Zap that watched Square
// for new invoices.
//
// Two things this has to get right:
//
//   1. Create the GHL contact if it doesn't exist. Until now every GHL
//      contact came from the portal's join flow, so a customer who bought
//      through Shopify without joining had no contact — and a field write
//      against a contact that isn't there goes nowhere and sends nothing.
//      The upsert inside syncContact covers that.
//   2. Push exactly once. The GHL workflow fires on the invoice URL field
//      changing, so a repeat push is a repeat text message. The claim in the
//      orders table is what makes that safe against webhook retries and
//      against the admin reprocess button.
//
// Never throws: by this point the invoice exists and Square has emailed it, so
// a GHL failure must not fail the order. It does alert — a silent failure here
// leaves a customer sitting on an order with no text.
//
// Called from both the orders webhook and the reprocess job, which is the
// whole reason it lives here rather than in either route.
async function pushInvoiceUrl({ order, invoice, keys }) {
  const invoiceUrl = invoice.publicUrl || null;

  if (!invoiceUrl) {
    await pipeline.log({
      ...keys,
      squareInvoiceId: invoice.id,
      category: 'ghl_api',
      eventName: 'ghl.invoice_push_no_url',
      status: 'error',
      errorMessage: 'Square returned no publicUrl — cannot send invoice iMessage',
    });
    alertMerchant(
      'Invoice has no payment link',
      `Order #${order.shopifyOrderNumber}: Square invoice ${invoice.id} published without a publicUrl, so the invoice iMessage was not sent. The customer still got Square's email.`
    );
    return;
  }

  const claimed = await db.orders.claimGhlInvoicePush(order.shopifyOrderId);
  if (!claimed) {
    await pipeline.log({
      ...keys,
      squareInvoiceId: invoice.id,
      category: 'ghl_api',
      eventName: 'ghl.invoice_push_already_sent',
      status: 'skipped',
      message:
        'Invoice URL already pushed to GHL — not re-sending (would re-text the customer)',
    });
    return;
  }

  // Tags merge in GHL and are never removed by us, so these are provenance
  // and eligibility-at-collection only. Opt-outs are GHL's job: it marks a
  // contact DND when they reply STOP, and that outranks any tag here.
  const tags = ['shopify-order-sync', ...consentTags(order.smsConsentState)];

  try {
    const result = await syncContact({
      name: 'ghl.invoice_push',
      contact: {
        email: order.email,
        phone: order.phone,
        firstName: order.firstName,
        lastName: order.lastName,
        zip: order.zip,
        tags,
      },
      // Both fields in one request. The workflow triggers on the invoice URL,
      // so if the order number arrived separately the message could render
      // before it landed.
      triggerFields: {
        square_order_number_from_shopify: order.shopifyOrderNumber,
        square_invoice_url: invoiceUrl,
      },
    });
    await pipeline.log({
      ...keys,
      squareInvoiceId: invoice.id,
      category: 'ghl_api',
      eventName: 'ghl.invoice_pushed',
      message: `Invoice URL pushed to GHL contact ${result.contact_id} — iMessage triggered`,
      payload: {
        contact_id: result.contact_id,
        triggered: result.triggered,
        unresolved_keys: result.unresolved_keys,
      },
    });
    if (result.unresolved_keys?.length > 0) {
      alertMerchant(
        'GHL field missing',
        `Order #${order.shopifyOrderNumber}: these GHL fields could not be resolved and were NOT written: ${result.unresolved_keys.join(
          ', '
        )}. Check /api/admin/ghl-fields.`
      );
    }
  } catch (err) {
    // Hand the claim back so a reprocess can retry — otherwise a transient
    // GHL outage would leave this order permanently marked as sent.
    await db.orders.releaseGhlInvoicePush(order.shopifyOrderId);
    console.error(
      `[Order #${order.shopifyOrderNumber}] GHL invoice push failed:`,
      err.message
    );
    await pipeline.log({
      ...keys,
      squareInvoiceId: invoice.id,
      category: 'ghl_api',
      eventName: 'ghl.invoice_push_failed',
      status: 'error',
      errorMessage: err.message,
    });
    alertMerchant(
      'Invoice iMessage not sent',
      `Order #${order.shopifyOrderNumber} (${order.email}): invoice ${invoice.id} was created, but pushing it to GHL failed, so the customer did not get the invoice text. They did get Square's email. Error: ${err.message}`
    );
  }
}

// Push carrier + tracking number + tracking URL to GHL, which sends the
// "here's your tracking" iMessage. Replaces the last Zapier Zap.
//
// Guarded per tracking number rather than per order, because an order can
// legitimately gain several over its life — a split shipment, or a reship
// after a lost parcel — and each distinct parcel should text exactly once.
// See db.trackingPushes.
//
// `contact` carries the identity to upsert against (from the Shopify order,
// since a fulfillment payload has no customer details).
//
// Never throws; alerts on failure.
async function pushTracking({ shopifyOrderId, orderNumber, contact, fulfillment, keys }) {
  const { trackingNumber, trackingUrl, carrier } = fulfillment;

  if (!trackingNumber) {
    // Normal and not an error: a fulfillment is often created before the
    // shipping label exists, and the tracking number arrives on a later
    // fulfillments/update. Nothing to say yet.
    await pipeline.log({
      ...keys,
      category: 'ghl_api',
      eventName: 'ghl.tracking_push_no_number',
      status: 'skipped',
      message: 'Fulfillment has no tracking number yet — waiting for an update',
    });
    return;
  }

  // No tracking URL means no message. Two reasons, and the second is the one
  // that bites:
  //
  //   1. A fulfillment with no tracking link is usually not a parcel at all —
  //      a local hand-off entered as carrier "Other" with something like
  //      "special drop off" typed in the tracking field. Texting a customer a
  //      carrier of "Other" and a tracking number of "special drop off" is
  //      worse than texting them nothing.
  //   2. An empty value is dropped rather than written (see resolveFieldKeys
  //      in the portal: writing blank to a field that drives a workflow
  //      trigger would fire it with nothing to say). So pushing a number with
  //      no URL leaves the PREVIOUS url in place — and for a repeat customer
  //      the message would pair this parcel's number with their last order's
  //      tracking link.
  //
  // Deliberately does not claim the parcel, so if a URL arrives on a later
  // fulfillments/update the message still goes out then.
  if (!trackingUrl) {
    await pipeline.log({
      ...keys,
      category: 'ghl_api',
      eventName: 'ghl.tracking_push_no_url',
      status: 'skipped',
      message: `Tracking "${trackingNumber}" (${carrier || 'no carrier'}) has no tracking URL — not texting the customer`,
      payload: { tracking_number: trackingNumber, carrier },
    });
    alertMerchant(
      'Tracking text skipped — no tracking link',
      `Order #${orderNumber} was fulfilled with tracking "${trackingNumber}" and carrier "${
        carrier || 'none'
      }", but Shopify provided no tracking URL, so no tracking text was sent.\n\nIf this was a local drop-off or hand delivery, that's the intended behaviour and you can ignore this. If it was a real shipment, the customer has not been notified — add the carrier and tracking number so Shopify generates a tracking link, and saving the fulfillment again will send the text.`
    );
    return;
  }

  if (!contact?.email) {
    await pipeline.log({
      ...keys,
      category: 'ghl_api',
      eventName: 'ghl.tracking_push_no_contact',
      status: 'error',
      errorMessage: 'No email on the Shopify order — cannot reach a GHL contact',
    });
    alertMerchant(
      'Tracking iMessage not sent',
      `Order #${orderNumber}: tracking ${trackingNumber} is ready but the Shopify order has no email address, so no GHL contact could be found. Send the tracking number manually.`
    );
    return;
  }

  const claimed = await db.trackingPushes.claim({ shopifyOrderId, trackingNumber });
  if (!claimed) {
    await pipeline.log({
      ...keys,
      category: 'ghl_api',
      eventName: 'ghl.tracking_push_already_sent',
      status: 'skipped',
      message: `Tracking ${trackingNumber} already pushed — not re-sending (would re-text the customer)`,
    });
    return;
  }

  try {
    const result = await syncContact({
      name: 'ghl.tracking_push',
      contact: {
        email: contact.email,
        phone: contact.phone,
        firstName: contact.firstName,
        lastName: contact.lastName,
        zip: contact.zip,
        tags: ['shopify-order-sync', ...consentTags(contact.smsConsentState)],
      },
      // One request for all three. The workflow triggers on the tracking
      // number, so splitting these would fire the message while the carrier
      // and link were still blank.
      triggerFields: {
        order_shipping_carrier: carrier,
        tracking_number: trackingNumber,
        tracking_number_url: trackingUrl,
      },
    });
    await pipeline.log({
      ...keys,
      category: 'ghl_api',
      eventName: 'ghl.tracking_pushed',
      message: `Tracking ${trackingNumber} (${carrier || 'no carrier'}) pushed to GHL contact ${result.contact_id} — iMessage triggered`,
      payload: {
        contact_id: result.contact_id,
        tracking_number: trackingNumber,
        carrier,
        has_url: Boolean(trackingUrl),
        extra_tracking_numbers: fulfillment.extraTrackingNumbers || [],
        unresolved_keys: result.unresolved_keys,
      },
    });
    if (result.unresolved_keys?.length > 0) {
      alertMerchant(
        'GHL field missing',
        `Order #${orderNumber}: these GHL fields could not be resolved and were NOT written: ${result.unresolved_keys.join(
          ', '
        )}. Check /api/admin/ghl-fields.`
      );
    }
    if (fulfillment.extraTrackingNumbers?.length > 0) {
      alertMerchant(
        'Order shipped in multiple parcels',
        `Order #${orderNumber} has more than one tracking number on a single fulfillment. The customer was texted ${trackingNumber}; these were not sent: ${fulfillment.extraTrackingNumbers.join(
          ', '
        )}. Pass them on manually if the customer needs them.`
      );
    }
  } catch (err) {
    await db.trackingPushes.release({ shopifyOrderId, trackingNumber });
    console.error(`[Order #${orderNumber}] GHL tracking push failed:`, err.message);
    await pipeline.log({
      ...keys,
      category: 'ghl_api',
      eventName: 'ghl.tracking_push_failed',
      status: 'error',
      errorMessage: err.message,
    });
    alertMerchant(
      'Tracking iMessage not sent',
      `Order #${orderNumber} (${contact.email}): tracking ${trackingNumber} shipped, but pushing it to GHL failed, so the customer did not get the tracking text. Shopify will still have emailed them. Error: ${err.message}`
    );
  }
}

module.exports = {
  syncContact,
  pushInvoiceUrl,
  pushTracking,
  consentTags,
  configured,
};
