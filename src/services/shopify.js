const crypto = require('crypto');
const config = require('../config');

const REST_URL = `https://${config.shopify.storeUrl}/admin/api/2025-01`;
const GRAPHQL_URL = `https://${config.shopify.storeUrl}/admin/api/2025-01/graphql.json`;

async function shopifyFetch(endpoint, options = {}) {
  const url = `${REST_URL}${endpoint}`;
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
    throw new Error(`Shopify API ${res.status}: ${body}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

async function shopifyGraphQL(query, variables = {}) {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': config.shopify.adminApiToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify GraphQL ${res.status}: ${body}`);
  }

  const data = await res.json();
  if (data.errors) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(data.errors)}`);
  }
  return data;
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
  // Get the ACTUAL shipping cost after any shipping discounts (e.g., free shipping codes)
  // total_shipping_price_set contains the final shipping amount the customer pays
  const shippingTotal = parseFloat(
    payload.total_shipping_price_set?.shop_money?.amount || 0
  );

  // Total is what the customer actually pays
  const total = parseFloat(payload.total_price || 0);

  // Subtotal is total minus actual shipping
  // This ensures product cost + shipping = total (no double-counting discounts)
  const subtotal = total - shippingTotal;

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
  };
}

module.exports = {
  markOrderAsPaid,
  addOrderNote,
  verifyWebhookSignature,
  parseOrderPayload,
};
