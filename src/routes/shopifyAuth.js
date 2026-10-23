const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const pool = require('../db/pool');

const router = express.Router();

// read_products + the inventory scopes are for the portal → Shopify
// inventory sync (src/services/inventorySync.js).
const SCOPES =
  'read_orders,write_orders,read_customers,write_customers,read_products,read_inventory,write_inventory';

// Shopify redirects here when the merchant clicks "Install"
// We redirect them to the Shopify OAuth authorization screen
router.get('/', (req, res) => {
  const { shop } = req.query;

  if (!shop) {
    return res.status(400).send('Missing shop parameter');
  }

  if (!config.shopify.clientId || !config.shopify.clientSecret) {
    console.error('[Shopify Auth] SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET not set');
    return res.status(500).send('App not configured: missing Shopify OAuth credentials');
  }

  // Validate shop parameter format
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)) {
    return res.status(400).send('Invalid shop parameter');
  }

  const nonce = crypto.randomBytes(16).toString('hex');
  const redirectUri = `https://${req.get('host')}/auth/callback`;

  const authUrl = `https://${shop}/admin/oauth/authorize?` +
    `client_id=${config.shopify.clientId}` +
    `&scope=${SCOPES}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${nonce}`;

  console.log(`[Shopify Auth] Redirecting to authorization for ${shop}`);
  res.redirect(authUrl);
});

// Shopify redirects back here after merchant approves
router.get('/callback', async (req, res) => {
  const { shop, code, hmac, state } = req.query;

  if (!shop || !code) {
    return res.status(400).send('Missing required parameters');
  }

  // Validate shop format
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)) {
    return res.status(400).send('Invalid shop parameter');
  }

  // Exchange code for permanent access token
  // This step itself validates authenticity — Shopify will reject an invalid code
  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: config.shopify.clientId,
        client_secret: config.shopify.clientSecret,
        code,
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error('[Shopify Auth] Token exchange failed:', err);
      return res.status(500).send('Token exchange failed');
    }

    const { access_token } = await tokenRes.json();

    // The token is shown ONCE, here, to whoever completed the install, and is
    // never persisted by us. It is deliberately not logged and not written to
    // the database: both are durable, shared stores that outlive the install,
    // and a credential sitting in either is a credential waiting to leak.
    // Record only that an install happened, so an unexplained re-install is
    // still auditable without keeping the secret around.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_install_log (
        id BIGSERIAL PRIMARY KEY,
        shop TEXT NOT NULL,
        installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        source_ip TEXT
      )
    `);
    await pool.query(
      `INSERT INTO app_install_log (shop, source_ip) VALUES ($1, $2)`,
      [shop, req.headers['x-forwarded-for'] || req.ip || null]
    );

    console.log(`[Shopify Auth] App installed on ${shop}. Token issued, not logged.`);

    res.send(`
      <html>
        <body style="font-family: sans-serif; max-width: 600px; margin: 40px auto; padding: 20px;">
          <h1>Everform Middleware Installed!</h1>
          <p>The app has been installed on <strong>${shop}</strong>.</p>
          <p><strong>Copy this access token now. It is shown once and is not stored anywhere.</strong></p>
          <pre style="background:#f4f1ea;border:1px solid #ccc;padding:12px;word-break:break-all;white-space:pre-wrap;">${access_token}</pre>
          <p>Set it as <code>SHOPIFY_ADMIN_API_TOKEN</code> in <strong>both</strong> Railway (middleware) and
          Netlify (portal). The portal uses the same token for customer creation and activation URLs, so
          updating only one will break onboarding.</p>
          <p>If you did not start this install, treat the token as compromised: uninstall the app in Shopify
          and rotate immediately.</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('[Shopify Auth] Error:', err.message);
    res.status(500).send('Installation failed: ' + err.message);
  }
});

module.exports = router;
