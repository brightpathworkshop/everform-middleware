const { Client, Environment } = require('square');
const config = require('../config');
const crypto = require('crypto');
const { withRetry } = require('./retry');

const client = new Client({
  accessToken: config.square.accessToken,
  environment: config.square.environment === 'production'
    ? Environment.Production
    : Environment.Sandbox,
});

const { customersApi, invoicesApi } = client;

// --- Customer Management ---

async function findCustomerByEmail(email) {
  try {
    const { result } = await withRetry(
      () =>
        customersApi.searchCustomers({
          query: { filter: { emailAddress: { exact: email.toLowerCase() } } },
        }),
      { name: 'square.searchCustomers' }
    );
    return result.customers?.[0] || null;
  } catch (err) {
    console.error('[Square] Customer search failed:', err.message);
    throw err;
  }
}

async function createCustomer({ email, firstName, lastName, phone }) {
  const idempotencyKey = crypto.randomUUID();
  try {
    const { result } = await withRetry(
      () =>
        customersApi.createCustomer({
          idempotencyKey,
          emailAddress: email.toLowerCase(),
          givenName: firstName,
          familyName: lastName,
          phoneNumber: phone,
        }),
      { name: 'square.createCustomer' }
    );
    return result.customer;
  } catch (err) {
    console.error('[Square] Customer creation failed:', err.message);
    throw err;
  }
}

async function findOrCreateCustomer({ email, firstName, lastName, phone }) {
  let customer = await findCustomerByEmail(email);
  const isNew = !customer;

  if (!customer) {
    customer = await createCustomer({ email, firstName, lastName, phone });
    console.log(`[Square] Created new customer: ${customer.id}`);
  } else {
    console.log(`[Square] Found existing customer: ${customer.id}`);
  }

  return { customer, isNew };
}

// --- Invoice Creation ---

async function createAndSendInvoice({ squareCustomerId, shopifyOrderNumber, subtotal, shipping }) {
  try {
    const lineItems = [
      {
        name: 'Research Materials',
        quantity: '1',
        basePriceMoney: {
          amount: BigInt(Math.round(subtotal * 100)),
          currency: 'USD',
        },
      },
    ];

    if (shipping > 0) {
      lineItems.push({
        name: 'Shipping',
        quantity: '1',
        basePriceMoney: {
          amount: BigInt(Math.round(shipping * 100)),
          currency: 'USD',
        },
      });
    }

    const orderIdempotencyKey = crypto.randomUUID();
    const orderResult = await withRetry(
      () =>
        client.ordersApi.createOrder({
          idempotencyKey: orderIdempotencyKey,
          order: {
            locationId: config.square.locationId,
            customerId: squareCustomerId,
            lineItems,
            metadata: { shopify_order_number: shopifyOrderNumber },
          },
        }),
      { name: 'square.createOrder' }
    );

    const orderId = orderResult.result.order.id;

    const invoiceIdempotencyKey = crypto.randomUUID();
    const { result } = await withRetry(
      () =>
        invoicesApi.createInvoice({
          idempotencyKey: invoiceIdempotencyKey,
          invoice: {
            locationId: config.square.locationId,
            orderId,
            primaryRecipient: { customerId: squareCustomerId },
            paymentRequests: [
              {
                requestType: 'BALANCE',
                dueDate: new Date().toISOString().split('T')[0],
                automaticPaymentSource: 'NONE',
                reminders: [],
              },
            ],
            acceptedPaymentMethods: {
              card: true,
              bankAccount: false,
              squareGiftCard: false,
              buyNowPayLater: false,
              cashAppPay: false,
            },
            deliveryMethod: 'EMAIL',
            title: `Order #${shopifyOrderNumber}`,
          },
        }),
      { name: 'square.createInvoice' }
    );

    const invoice = result.invoice;
    console.log(`[Square] Created invoice ${invoice.id} for order #${shopifyOrderNumber}`);

    const publishIdempotencyKey = crypto.randomUUID();
    const publishResult = await withRetry(
      () =>
        invoicesApi.publishInvoice(invoice.id, {
          version: invoice.version,
          idempotencyKey: publishIdempotencyKey,
        }),
      { name: 'square.publishInvoice' }
    );

    console.log(`[Square] Published invoice ${invoice.id}`);
    return publishResult.result.invoice;
  } catch (err) {
    console.error('[Square] Invoice creation failed:', err.message);
    if (err.errors) {
      console.error('[Square] Error details:', JSON.stringify(err.errors, null, 2));
    }
    if (err.body) {
      console.error('[Square] Response body:', err.body);
    }
    throw err;
  }
}

// --- Webhook Verification ---

function verifyWebhookSignature(body, signature, url) {
  const hmac = crypto.createHmac('sha256', config.square.webhookSignatureKey);
  hmac.update(url + body);
  const expectedSignature = hmac.digest('base64');
  return signature === expectedSignature;
}

module.exports = {
  findOrCreateCustomer,
  createAndSendInvoice,
  verifyWebhookSignature,
};
