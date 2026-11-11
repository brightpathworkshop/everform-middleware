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

module.exports = { syncContact, pushInvoiceUrl, consentTags, configured };
