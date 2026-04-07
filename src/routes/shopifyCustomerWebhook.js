const express = require('express');
const shopify = require('../services/shopify');
const ghl = require('../services/ghl');
const { alertMerchant } = require('../services/alerts');

const router = express.Router();

router.post('/webhooks/shopify/customers', async (req, res) => {
  // 1. Verify webhook signature
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!hmac || !shopify.verifyWebhookSignature(req.rawBody, hmac)) {
    console.warn('[Customer Webhook] Invalid signature — rejected');
    return res.status(401).send('Invalid signature');
  }

  // Respond immediately so Shopify doesn't retry
  res.status(200).send('OK');

  const customer = req.body;
  const customerId = String(customer.id);
  const email = (customer.email || '').toLowerCase();
  const state = customer.state; // "disabled" = hasn't activated account yet

  console.log(`[Customer Webhook] Customer ${customerId} (${email}) — state: ${state}`);

  try {
    // Only generate activation URL for customers who haven't activated yet
    if (state !== 'disabled') {
      console.log(`[Customer Webhook] Customer ${customerId} already activated — skipping`);
      return;
    }

    // 2. Generate activation URL from Shopify
    const activationUrl = await shopify.generateAccountActivationUrl(customerId);
    console.log(`[Customer Webhook] Activation URL generated for ${email}`);

    // 3. Push to GHL
    if (email) {
      await ghl.pushAccountSetupUrl(email, activationUrl);
    } else {
      console.warn(`[Customer Webhook] Customer ${customerId} has no email — cannot push to GHL`);
    }
  } catch (err) {
    console.error(`[Customer Webhook] Failed for customer ${customerId}:`, err.message);
    alertMerchant(
      'Customer activation URL failed',
      `Customer ${customerId} (${email}): ${err.message}`
    );
  }
});

module.exports = router;
