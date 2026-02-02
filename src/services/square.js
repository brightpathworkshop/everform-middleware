const { Client, Environment } = require('square');
const config = require('../config');
const crypto = require('crypto');

const client = new Client({
  accessToken: config.square.accessToken,
  environment: config.square.environment === 'production'
    ? Environment.Production
    : Environment.Sandbox,
});

const { customersApi, invoicesApi, paymentsApi, cardsApi } = client;

// --- Customer Management ---

async function findCustomerByEmail(email) {
  try {
    const { result } = await customersApi.searchCustomers({
      query: {
        filter: {
          emailAddress: { exact: email.toLowerCase() },
        },
      },
    });
    return result.customers?.[0] || null;
  } catch (err) {
    console.error('[Square] Customer search failed:', err.message);
    throw err;
  }
}

async function createCustomer({ email, firstName, lastName, phone }) {
  try {
    const { result } = await customersApi.createCustomer({
      idempotencyKey: crypto.randomUUID(),
      emailAddress: email.toLowerCase(),
      givenName: firstName,
      familyName: lastName,
      phoneNumber: phone,
    });
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

// --- Card on File ---

async function getCustomerCards(customerId) {
  try {
    const { result } = await cardsApi.listCards(undefined, customerId);
    return result.cards || [];
  } catch (err) {
    console.error('[Square] Card lookup failed:', err.message);
    return [];
  }
}

async function customerHasCardOnFile(customerId) {
  const cards = await getCustomerCards(customerId);
  return cards.length > 0 ? cards[0] : null;
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

    const orderResult = await client.ordersApi.createOrder({
      idempotencyKey: crypto.randomUUID(),
      order: {
        locationId: config.square.locationId,
        customerId: squareCustomerId,
        lineItems,
        metadata: {
          shopify_order_number: shopifyOrderNumber,
        },
      },
    });

    const orderId = orderResult.result.order.id;

    const { result } = await invoicesApi.createInvoice({
      idempotencyKey: crypto.randomUUID(),
      invoice: {
        locationId: config.square.locationId,
        orderId,
        primaryRecipient: {
          customerId: squareCustomerId,
        },
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
        customFields: [
          {
            label: 'Order Reference',
            value: shopifyOrderNumber,
            placement: 'ABOVE_LINE_ITEMS',
          },
        ],
      },
    });

    const invoice = result.invoice;
    console.log(`[Square] Created invoice ${invoice.id} for order #${shopifyOrderNumber}`);

    // Publish (send) the invoice
    const publishResult = await invoicesApi.publishInvoice(invoice.id, {
      version: invoice.version,
      idempotencyKey: crypto.randomUUID(),
    });

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

// --- Auto-Charge ---

async function chargeCard({ squareCustomerId, cardId, amount, shopifyOrderNumber }) {
  try {
    const { result } = await paymentsApi.createPayment({
      idempotencyKey: crypto.randomUUID(),
      sourceId: cardId,
      customerId: squareCustomerId,
      amountMoney: {
        amount: BigInt(Math.round(amount * 100)),
        currency: 'USD',
      },
      note: `Order #${shopifyOrderNumber} - Research Materials`,
      referenceId: shopifyOrderNumber,
    });

    console.log(`[Square] Charged card for order #${shopifyOrderNumber}: ${result.payment.id}`);
    return result.payment;
  } catch (err) {
    console.error(`[Square] Auto-charge failed for order #${shopifyOrderNumber}:`, err.message);
    return null; // Return null to signal fallback to invoice
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
  customerHasCardOnFile,
  createAndSendInvoice,
  chargeCard,
  verifyWebhookSignature,
};
