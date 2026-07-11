const { Client, Environment } = require('square');
const crypto = require('crypto');
const { withRetry } = require('./retry');
const squareAccount = require('./squareAccount');

// Returns a { client, account } pair for the currently-primary Square
// account. Fresh lookup per call so changing the primary in
// square_accounts takes effect immediately without a middleware restart.
async function getClient() {
  const account = await squareAccount.getPrimaryAccount();
  const client = new Client({
    accessToken: account.accessToken,
    environment: account.environment === 'production'
      ? Environment.Production
      : Environment.Sandbox,
  });
  return { client, account };
}

// --- Customer Management ---

async function findCustomerByEmail(email) {
  try {
    const { client } = await getClient();
    const { result } = await withRetry(
      () =>
        client.customersApi.searchCustomers({
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
    const { client } = await getClient();
    const { result } = await withRetry(
      () =>
        client.customersApi.createCustomer({
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
    const { client, account } = await getClient();
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
            locationId: account.locationId,
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
        client.invoicesApi.createInvoice({
          idempotencyKey: invoiceIdempotencyKey,
          invoice: {
            locationId: account.locationId,
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
    console.log(
      `[Square] Created invoice ${invoice.id} for order #${shopifyOrderNumber} via account "${account.name}"`
    );

    const publishIdempotencyKey = crypto.randomUUID();
    const publishResult = await withRetry(
      () =>
        client.invoicesApi.publishInvoice(invoice.id, {
          version: invoice.version,
          idempotencyKey: publishIdempotencyKey,
        }),
      { name: 'square.publishInvoice' }
    );

    console.log(`[Square] Published invoice ${invoice.id}`);
    // Return both the invoice and the account so the caller can persist
    // which Square account this order belongs to (needed for payment
    // webhook attribution across multiple accounts).
    return { invoice: publishResult.result.invoice, account };
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

// Looks up every active Square account and tries their signature key
// against the incoming payload. Returns the matched account (with
// credentials) on success, or null on no match — so the webhook route
// can (a) reject unauthorized payloads and (b) know which account the
// event came from for attribution.
async function verifyWebhookSignatureAndFindAccount(body, signature, url) {
  const accounts = await squareAccount.getAllActiveAccounts();
  for (const acc of accounts) {
    if (!acc.webhookSignatureKey) continue;
    const hmac = crypto.createHmac('sha256', acc.webhookSignatureKey);
    hmac.update(url + body);
    const expected = hmac.digest('base64');
    if (signature === expected) return acc;
  }
  return null;
}

// Backwards-compat shim for callers that still expect the old boolean
// verify. Discards the account attribution — only new code should use
// verifyWebhookSignatureAndFindAccount.
async function verifyWebhookSignature(body, signature, url) {
  return (await verifyWebhookSignatureAndFindAccount(body, signature, url)) !== null;
}

module.exports = {
  findOrCreateCustomer,
  createAndSendInvoice,
  verifyWebhookSignature,
  verifyWebhookSignatureAndFindAccount,
};
