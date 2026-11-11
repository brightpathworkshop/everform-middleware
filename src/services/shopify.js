const crypto = require('crypto');
const config = require('../config');
const { withRetry } = require('./retry');

const REST_URL = `https://${config.shopify.storeUrl}/admin/api/2025-01`;
const GRAPHQL_URL = `https://${config.shopify.storeUrl}/admin/api/2025-01/graphql.json`;

// Inventory calls pin a newer version: inventorySetQuantities changed shape
// (the @idempotent directive is required from 2026-04 on).
const INVENTORY_API_VERSION = '2026-10';
// Version for fetchOrderContactSnapshot. Kept off the module default because
// the customer SMS-consent field is in a different place on 2025-01, and this
// is the version the query is verified against. Anything added to that query
// must be checked on THIS version, not whatever a schema tool defaults to.
const CONTACT_API_VERSION = '2026-10';
// Business timezone, for filing an order under the right calendar date.
const ORDER_DATE_TIMEZONE = process.env.ORDER_DATE_TIMEZONE || 'America/Los_Angeles';

async function shopifyFetch(endpoint, options = {}) {
  const url = `${REST_URL}${endpoint}`;
  const method = options.method || 'GET';
  return withRetry(
    async () => {
      const res = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': config.shopify.adminApiToken,
          ...options.headers,
        },
      });

      if (!res.ok) {
        const body = await res.text();
        const err = new Error(`Shopify API ${res.status}: ${body}`);
        err.statusCode = res.status;
        throw err;
      }

      if (res.status === 204) return null;
      return res.json();
    },
    { name: `shopify.${method}.${endpoint}` }
  );
}

async function shopifyGraphQL(query, variables = {}, { apiVersion } = {}) {
  const url = apiVersion
    ? `https://${config.shopify.storeUrl}/admin/api/${apiVersion}/graphql.json`
    : GRAPHQL_URL;
  // Extract operation name from query for better retry logs
  const opName = query.match(/(?:mutation|query)\s+(\w+)/)?.[1] || 'graphql';
  return withRetry(
    async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': config.shopify.adminApiToken,
        },
        body: JSON.stringify({ query, variables }),
      });

      if (!res.ok) {
        const body = await res.text();
        const err = new Error(`Shopify GraphQL ${res.status}: ${body}`);
        err.statusCode = res.status;
        throw err;
      }

      const data = await res.json();
      if (data.errors) {
        // Application-level errors (validation, etc) — not retryable.
        throw new Error(`Shopify GraphQL errors: ${JSON.stringify(data.errors)}`);
      }
      return data;
    },
    { name: `shopify.graphql.${opName}` }
  );
}

// --- Mark Order as Paid ---

async function markOrderAsPaid(shopifyOrderId, { squareInvoiceId, squarePaymentId }) {
  const gid = `gid://shopify/Order/${shopifyOrderId}`;

  const result = await shopifyGraphQL(
    `mutation orderMarkAsPaid($input: OrderMarkAsPaidInput!) {
      orderMarkAsPaid(input: $input) {
        order { id name }
        userErrors { field message }
      }
    }`,
    { input: { id: gid } }
  );

  const { order, userErrors } = result.data.orderMarkAsPaid;
  if (userErrors && userErrors.length > 0) {
    throw new Error(`Shopify orderMarkAsPaid failed: ${JSON.stringify(userErrors)}`);
  }

  console.log(`[Shopify] Marked order ${shopifyOrderId} (${order.name}) as paid`);

  // Add note to the order
  const note = squareInvoiceId
    ? `Payment received via Square invoice #${squareInvoiceId}`
    : `Payment received via Square auto-charge #${squarePaymentId}`;
  await addOrderNote(shopifyOrderId, note);

  return order;
}

// --- Add Order Note ---

async function addOrderNote(shopifyOrderId, note) {
  try {
    await shopifyFetch(`/orders/${shopifyOrderId}.json`, {
      method: 'PUT',
      body: JSON.stringify({
        order: {
          id: shopifyOrderId,
          note,
        },
      }),
    });
    console.log(`[Shopify] Added note to order ${shopifyOrderId}`);
  } catch (err) {
    console.error(`[Shopify] Failed to add note to order ${shopifyOrderId}:`, err.message);
  }
}

// --- Webhook Verification ---

function verifyWebhookSignature(body, hmacHeader) {
  const hmac = crypto.createHmac('sha256', config.shopify.webhookSecret);
  hmac.update(body, 'utf8');
  const digest = hmac.digest('base64');
  return crypto.timingSafeEqual(
    Buffer.from(digest),
    Buffer.from(hmacHeader)
  );
}

// Calendar date in the business's own timezone, as YYYY-MM-DD.
//
// GHL's last_order_date is a DATE field, so a full ISO timestamp is the wrong
// shape for it. The timezone is the substantive part though, not the
// formatting: Shopify timestamps are UTC, and a Pacific evening order carries
// the NEXT day's UTC date. Order #1398 was placed at 15:16 on 9 Nov Pacific
// and Shopify records 2026-11-09T23:16:50Z, which is fine — but anything
// after 4pm Pacific would land on tomorrow's date, so roughly a third of the
// day's orders would be filed a day late.
function localCalendarDate(iso, timeZone = ORDER_DATE_TIMEZONE) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // en-CA formats as YYYY-MM-DD, which is what a DATE field wants.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

// Clean a phone into something GHL can actually dial or text.
//
// Shopify stores whatever the customer typed, and the data is messier than it
// looks: order #1366 carries "+1+14157226710" (a doubled country code) and
// several orders carry an empty string rather than null. A malformed number
// reaches GHL, gets stored, and then silently fails to deliver — there is no
// bounce to notice.
//
// US/Canada only, which is the whole customer base: ten digits gets a +1,
// eleven starting with 1 gets a bare +. Anything else passes through
// untouched rather than being mangled into a different number — better a
// number we didn't improve than one we broke.
function normalizePhoneForMessaging(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  // Peel repeated leading country codes until ten digits are left. This is
  // what rescues "+1+14157226710" (order #1366) without assuming anything:
  // only a leading 1 is ever dropped, and only while the number is still
  // longer than a bare US subscriber number.
  let d = s.replace(/\D/g, '');
  while (d.length > 10 && d.startsWith('1')) d = d.slice(1);
  if (d.length === 10) return `+1${d}`;
  // Anything else — a genuine international number, or something too mangled
  // to reason about — passes through untouched. Better a number we didn't
  // improve than one we quietly turned into somebody else's.
  return s;
}

// --- Parse Order Data ---

function parseOrderPayload(payload) {
  // Post-discount shipping the customer actually pays.
  // `total_shipping_price_set` is gross (excludes order-level shipping discounts),
  // so a free-shipping code would still report the original amount and the Square
  // invoice would carry a phantom shipping line. Sum `shipping_lines[].discounted_price`
  // instead — that field is always the post-discount per-line amount.
  const shippingLines = payload.shipping_lines || [];
  const shippingTotal = shippingLines.reduce((sum, line) => {
    return sum + parseFloat(line.discounted_price ?? line.price ?? 0);
  }, 0);

  // Total is what the customer actually pays
  const total = parseFloat(payload.total_price || 0);

  // Subtotal for the Square invoice: total minus actual shipping
  // This ensures product cost + shipping = total (no double-counting discounts)
  const subtotal = total - shippingTotal;

  // Commission base: post-discount, pre-tax, no shipping. Comes directly
  // from Shopify's subtotal_price field. Kept separate from `subtotal` above
  // because that one feeds the Square invoice line item (which must reconcile
  // to the customer-paid total).
  const productSubtotal = parseFloat(payload.subtotal_price || 0);

  return {
    shopifyOrderId: String(payload.id),
    shopifyOrderNumber: String(payload.order_number),
    shopifyCustomerId: String(payload.customer?.id || ''),
    email: payload.contact_email || payload.customer?.email || '',
    firstName: payload.customer?.first_name || '',
    lastName: payload.customer?.last_name || '',
    // Precedence matters, and it is NOT the shipping label's order. The
    // customer's own number comes first, then the number they typed at
    // checkout, and the shipping address only as a last resort: a delivery
    // phone is routinely a workplace, a gift recipient, or a business line.
    // Order #1397 shipped to a toll-free +1800 number while the customer's
    // own mobile sat on the customer record — texting the former reaches
    // nobody.
    phone: normalizePhoneForMessaging(
      payload.customer?.phone || payload.phone || payload.shipping_address?.phone
    ),
    zip: payload.shipping_address?.zip || payload.customer?.default_address?.zip || '',
    // Marketing SMS consent as Shopify recorded it at checkout. Read from the
    // payload rather than fetched, so this stays empty until SMS consent is
    // actually enabled at checkout and starts populating on its own.
    //
    // This does NOT gate the invoice or tracking messages: those are
    // transactional, and the customer handed over the number to get a
    // shipment. It decides whether an order-created GHL contact is eligible
    // for promotional sends, so the promo list can't quietly fill up with
    // people who never opted in.
    smsConsentState: payload.customer?.sms_marketing_consent?.state || null,
    subtotal,
    shipping: shippingTotal,
    total,
    productSubtotal,
  };
}

// Pull carrier, tracking number and tracking URL out of a fulfillments/create
// or fulfillments/update webhook payload.
//
// Shopify sends both singular fields and arrays (`tracking_number` plus
// `tracking_numbers`), and which are populated varies — the singular field is
// the first element when there are several. Read singular first, fall back to
// the arrays.
//
// Carrier arrives branded, e.g. "UPS®" rather than "UPS". That is passed
// through unchanged: the Zapier Zap this replaces did the same, so the
// existing iMessage copy already renders whatever Shopify sends, and quietly
// rewriting it here would change what customers read.
function parseFulfillmentPayload(payload) {
  const number =
    payload.tracking_number ||
    (Array.isArray(payload.tracking_numbers) ? payload.tracking_numbers[0] : null) ||
    '';
  const url =
    payload.tracking_url ||
    (Array.isArray(payload.tracking_urls) ? payload.tracking_urls[0] : null) ||
    '';
  return {
    fulfillmentId: payload.id != null ? String(payload.id) : '',
    shopifyOrderId: payload.order_id != null ? String(payload.order_id) : '',
    status: payload.status || null,
    shipmentStatus: payload.shipment_status || null,
    carrier: payload.tracking_company || '',
    trackingNumber: String(number || '').trim(),
    trackingUrl: String(url || '').trim(),
    // More than one parcel on a single fulfillment. We text about the first
    // and log the rest, rather than sending a burst of messages.
    extraTrackingNumbers: Array.isArray(payload.tracking_numbers)
      ? payload.tracking_numbers.slice(1).map((n) => String(n).trim()).filter(Boolean)
      : [],
  };
}

// Fetch a Shopify order by id (REST) and return the raw payload so the
// same parseOrderPayload can be used on both webhook receives and manual
// reprocess flows.
async function fetchOrderById(shopifyOrderId) {
  const data = await shopifyFetch(`/orders/${shopifyOrderId}.json`);
  return data.order;
}

// Everything the GHL CRM sync needs about an order and its customer, in one
// call: contact details plus Shopify's own lifetime aggregates.
//
// Called at PAYMENT time, not order-create time, and that matters.
// `amountSpent` and `numberOfOrders` count what Shopify considers paid, and
// our orders sit unpaid in Shopify until the Square invoice clears and
// markOrderAsPaid runs. Read at order-create they'd both be short by the
// order that just came in; read right after markOrderAsPaid they're current.
//
// Pinned to CONTACT_API_VERSION rather than the module default. The SMS
// consent field moved between versions — it sits at
// Customer.smsMarketingConsent on 2025-01 and under
// defaultPhoneNumber.smsMarketingConsent from 2026-10 — and this exact query
// is verified working against the live shop on 2026-10. Running it on the
// module's 2025-01 default throws "Field 'smsMarketingConsent' doesn't exist
// on type 'CustomerPhoneNumber'", which is how it shipped broken the first
// time: it was validated against a newer schema than the code called.
async function fetchOrderContactSnapshot(shopifyOrderId) {
  const data = await shopifyGraphQL(
    `query OrderContactSnapshot($id: ID!) {
       order(id: $id) {
         name
         createdAt
         email
         phone
         shippingAddress { zip firstName lastName phone }
         customer {
           id
           firstName
           lastName
           numberOfOrders
           amountSpent { amount }
           defaultPhoneNumber {
             phoneNumber
             smsMarketingConsent { state collectedFrom }
           }
         }
       }
     }`,
    { id: `gid://shopify/Order/${shopifyOrderId}` },
    { apiVersion: CONTACT_API_VERSION }
  );
  const order = data?.data?.order;
  if (!order) return null;
  const customer = order.customer || {};
  const ship = order.shippingAddress || {};
  return {
    // `name` is "#1398"; the bare number is what GHL templates show.
    orderNumber: String(order.name || '').replace(/^#/, ''),
    orderDate: order.createdAt || null,
    // YYYY-MM-DD in the business timezone, for GHL's DATE field.
    orderDateLocal: localCalendarDate(order.createdAt),
    email: order.email || '',
    // Same precedence as parseOrderPayload, and for the same reason: the
    // shipping address's phone is a delivery contact, not necessarily the
    // customer's own line.
    phone: normalizePhoneForMessaging(
      customer.defaultPhoneNumber?.phoneNumber || order.phone || ship.phone
    ),
    firstName: customer.firstName || ship.firstName || '',
    lastName: customer.lastName || ship.lastName || '',
    zip: ship.zip || '',
    orderCount: customer.numberOfOrders != null ? String(customer.numberOfOrders) : null,
    totalSpend: customer.amountSpent?.amount != null ? String(customer.amountSpent.amount) : null,
    smsConsentState: customer.defaultPhoneNumber?.smsMarketingConsent?.state || null,
  };
}

// --- Inventory ---

// Every variant with its sellable quantity and inventory item, for the
// portal → Shopify inventory sync. Needs read_products + read_inventory.
async function listVariantInventory() {
  const out = [];
  let after = null;
  for (;;) {
    const result = await shopifyGraphQL(
      `query SyncVariants($after: String) {
        productVariants(first: 250, after: $after) {
          nodes { legacyResourceId inventoryQuantity inventoryItem { id tracked } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { after },
      { apiVersion: INVENTORY_API_VERSION }
    );
    const page = result.data.productVariants;
    for (const v of page.nodes) {
      out.push({
        variantId: String(v.legacyResourceId),
        inventoryQuantity: v.inventoryQuantity,
        inventoryItemId: v.inventoryItem?.id || null,
        tracked: !!v.inventoryItem?.tracked,
      });
    }
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  return out;
}

// Set the available quantity for a batch of inventory items at one
// location. The portal ledger is the source of truth, so no compare check.
// Needs write_inventory.
async function setAvailableQuantities({ locationId, quantities, referenceUri }) {
  const result = await shopifyGraphQL(
    `mutation SetInventory($input: InventorySetQuantitiesInput!, $key: String!) {
      inventorySetQuantities(input: $input) @idempotent(key: $key) {
        userErrors { field message code }
      }
    }`,
    {
      key: crypto.randomUUID(),
      input: {
        name: 'available',
        reason: 'correction',
        referenceDocumentUri: referenceUri,
        quantities: quantities.map((q) => ({
          inventoryItemId: q.inventoryItemId,
          locationId,
          quantity: q.quantity,
          changeFromQuantity: null,
        })),
      },
    },
    { apiVersion: INVENTORY_API_VERSION }
  );
  const { userErrors } = result.data.inventorySetQuantities;
  if (userErrors && userErrors.length > 0) {
    throw new Error(`Shopify inventorySetQuantities failed: ${JSON.stringify(userErrors)}`);
  }
}

// --- Generate Account Activation URL ---

async function generateAccountActivationUrl(shopifyCustomerId) {
  const gid = `gid://shopify/Customer/${shopifyCustomerId}`;

  const result = await shopifyGraphQL(
    `mutation customerGenerateAccountActivationUrl($customerId: ID!) {
      customerGenerateAccountActivationUrl(customerId: $customerId) {
        accountActivationUrl
        userErrors { field message }
      }
    }`,
    { customerId: gid }
  );

  const { accountActivationUrl, userErrors } = result.data.customerGenerateAccountActivationUrl;
  if (userErrors && userErrors.length > 0) {
    throw new Error(`Shopify activation URL failed: ${JSON.stringify(userErrors)}`);
  }

  console.log(`[Shopify] Generated activation URL for customer ${shopifyCustomerId}`);
  return accountActivationUrl;
}

module.exports = {
  fetchOrderById,
  fetchOrderContactSnapshot,
  listVariantInventory,
  setAvailableQuantities,
  markOrderAsPaid,
  addOrderNote,
  verifyWebhookSignature,
  parseOrderPayload,
  parseFulfillmentPayload,
  generateAccountActivationUrl,
};
