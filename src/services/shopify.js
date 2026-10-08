const crypto = require('crypto');
const config = require('../config');
const { withRetry } = require('./retry');

const REST_URL = `https://${config.shopify.storeUrl}/admin/api/2025-01`;
const GRAPHQL_URL = `https://${config.shopify.storeUrl}/admin/api/2025-01/graphql.json`;

// Inventory calls pin a newer version: inventorySetQuantities changed shape
// (the @idempotent directive is required from 2026-04 on).
const INVENTORY_API_VERSION = '2026-10';

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
    phone: payload.shipping_address?.phone || payload.customer?.phone || '',
    subtotal,
    shipping: shippingTotal,
    total,
    productSubtotal,
  };
}

// Fetch a Shopify order by id (REST) and return the raw payload so the
// same parseOrderPayload can be used on both webhook receives and manual
// reprocess flows.
async function fetchOrderById(shopifyOrderId) {
  const data = await shopifyFetch(`/orders/${shopifyOrderId}.json`);
  return data.order;
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
  listVariantInventory,
  setAvailableQuantities,
  markOrderAsPaid,
  addOrderNote,
  verifyWebhookSignature,
  parseOrderPayload,
  generateAccountActivationUrl,
};
