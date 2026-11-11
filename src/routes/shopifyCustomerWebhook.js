const express = require('express');
const shopify = require('../services/shopify');
const ghl = require('../services/ghl');
const { alertMerchant } = require('../services/alerts');
const config = require('../config');

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
    // Under new customer accounts there is nothing for this handler to do.
    // Sign-in is an emailed six-digit code, so no activation URL exists to
    // mint and no account_setup_url to push — and the state gate below is
    // meaningless, since "disabled" and "invited" are legacy-only states.
    //
    // Minting anyway would produce a link Shopify documents as non-functional
    // and then push it to GHL, where the welcome automation would text it to
    // a real customer. Returning early is the correct behaviour, not a stub.
    if (config.shopify.customerAccounts === 'new') {
      console.log(
        `[Customer Webhook] Customer ${customerId} — new customer accounts are enabled, no activation step exists; nothing to do`
      );
      return;
    }

    // Only generate activation URL for customers who haven't activated yet.
    // "disabled" = never invited, "invited" = invite sent but not yet accepted.
    // Both are valid states for customerGenerateAccountActivationUrl.
    if (state !== 'disabled' && state !== 'invited') {
      console.log(`[Customer Webhook] Customer ${customerId} already activated (state: ${state}) — skipping`);
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
