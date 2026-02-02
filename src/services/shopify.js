const crypto = require('crypto');
const config = require('../config');

const BASE_URL = `https://${config.shopify.storeUrl}/admin/api/2024-10`;

async function shopifyFetch(endpoint, options = {}) {
  const url = `${BASE_URL}${endpoint}`;
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

// --- Mark Order as Paid ---

async function markOrderAsPaid(shopifyOrderId, { squareInvoiceId, squarePaymentId }) {
  const transactionNote = squareInvoiceId
    ? `Payment received via invoice #${squareInvoiceId}`
    : `Payment received via auto-charge #${squarePaymentId}`;

  // Create a transaction to mark the order as paid
  const data = await shopifyFetch(`/orders/${shopifyOrderId}/transactions.json`, {
    method: 'POST',
    body: JSON.stringify({
      transaction: {
        kind: 'capture',
        status: 'success',
        gateway: 'manual',
      },
    }),
  });

  console.log(`[Shopify] Marked order ${shopifyOrderId} as paid`);

  // Add note to the order
  await addOrderNote(shopifyOrderId, transactionNote);

  return data;
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
  const shippingTotal = (payload.shipping_lines || []).reduce(
    (sum, line) => sum + parseFloat(line.price || 0),
    0
  );

  const lineItemsTotal = (payload.line_items || []).reduce(
    (sum, item) => sum + parseFloat(item.price || 0) * item.quantity,
    0
  );

  // Use discount_codes to calculate discount amount
  const discountTotal = (payload.discount_codes || []).reduce(
    (sum, d) => sum + parseFloat(d.amount || 0),
    0
  );

  return {
    shopifyOrderId: String(payload.id),
    shopifyOrderNumber: String(payload.order_number),
    shopifyCustomerId: String(payload.customer?.id || ''),
    email: payload.contact_email || payload.customer?.email || '',
    firstName: payload.customer?.first_name || '',
    lastName: payload.customer?.last_name || '',
    phone: payload.shipping_address?.phone || payload.customer?.phone || '',
    subtotal: lineItemsTotal - discountTotal,
    shipping: shippingTotal,
    total: parseFloat(payload.total_price || 0),
  };
}

module.exports = {
  markOrderAsPaid,
  addOrderNote,
  verifyWebhookSignature,
  parseOrderPayload,
};
