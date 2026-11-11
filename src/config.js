require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,

  shopify: {
    storeUrl: process.env.SHOPIFY_STORE_URL,
    adminApiToken: process.env.SHOPIFY_ADMIN_API_TOKEN,
    webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET,
    clientId: process.env.SHOPIFY_CLIENT_ID,
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET,
    // Where stock is held. One location today; override if that changes.
    locationId: process.env.SHOPIFY_LOCATION_ID || 'gid://shopify/Location/89919914234',
  },

  // Square credentials moved to the multi-tenant square_accounts table.
  // See src/services/squareAccount.js — env vars are keyed by env_var_slot.
  // LEGACY slot falls back to unsuffixed SQUARE_ACCESS_TOKEN etc. so the
  // pre-migration Railway config keeps working without changes.

  database: {
    url: process.env.DATABASE_URL,
  },

  ghl: {
    apiKey: process.env.GHL_API_KEY,
    locationId: process.env.GHL_LOCATION_ID,
    fieldIds: {
      accountSetupUrl: 'JmSEHfP1wYYUtwiwWoNG',
    },
    // GHL merge-tag keys for the CRM fields written at payment time
    // (replacing the Zapier "order paid → GHL" Zap). Env-overridable because
    // these names are a guess until confirmed against /api/admin/ghl-fields:
    // nothing triggers on them, so a wrong key leaves a field blank in GHL
    // rather than dropping a customer message, and it can be corrected
    // without a code deploy.
    crmFieldKeys: {
      lastOrderDate: process.env.GHL_KEY_LAST_ORDER_DATE || 'last_order_date',
      orderCount: process.env.GHL_KEY_ORDER_COUNT || 'customer_order_count',
      totalSpend: process.env.GHL_KEY_TOTAL_SPEND || 'customer_total_spend',
    },
  },

  // The portal (Netlify). We call it for GHL writes rather than talking to
  // GHL directly: the portal owns the only client that resolves GHL
  // merge-tag keys to field IDs. See src/services/ghlSync.js.
  // Shared secret is REPROCESS_SECRET, the same one the portal uses to call
  // our /jobs routes — one secret, one trust boundary, two places to rotate.
  portal: {
    baseUrl: process.env.PORTAL_BASE_URL || 'https://membership.everformlife.com',
    sharedSecret: process.env.REPROCESS_SECRET,
  },

  merchant: {
    alertEmail: process.env.MERCHANT_ALERT_EMAIL,
    alertPhone: process.env.MERCHANT_ALERT_PHONE,
  },
};
