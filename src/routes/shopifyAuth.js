const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const pool = require('../db/pool');

const router = express.Router();

const SCOPES = 'read_orders,write_orders,read_customers';

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

    // Store the token in the database for reference
    await pool.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      INSERT INTO settings (key, value, updated_at) VALUES ('shopify_access_token', $1, NOW())
      ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
    `, [access_token]);

    console.log(`[Shopify Auth] App installed successfully! Access token stored in DB.`);
    console.log(`[Shopify Auth] TOKEN: ${access_token}`);
    console.log(`[Shopify Auth] Add this to Railway as SHOPIFY_ADMIN_API_TOKEN`);

    res.send(`
      <html>
        <body style="font-family: sans-serif; max-width: 600px; margin: 40px auto; padding: 20px;">
          <h1>Everform Middleware Installed!</h1>
          <p>The app has been installed on <strong>${shop}</strong>.</p>
          <p>Your access token has been saved. Check your Railway logs for the token value, then add it as <code>SHOPIFY_ADMIN_API_TOKEN</code> in your Railway environment variables.</p>
          <p>You can close this window.</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('[Shopify Auth] Error:', err.message);
    res.status(500).send('Installation failed: ' + err.message);
  }
});

module.exports = router;
