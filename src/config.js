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

  // Public address of the portal, used for COA links on the store.
  portalBaseUrl: (process.env.PORTAL_BASE_URL || 'https://membership.everformlife.com').replace(/\/$/, ''),

  database: {
    url: process.env.DATABASE_URL,
  },

  ghl: {
    apiKey: process.env.GHL_API_KEY,
    locationId: process.env.GHL_LOCATION_ID,
    fieldIds: {
      accountSetupUrl: 'JmSEHfP1wYYUtwiwWoNG',
    },
  },

  merchant: {
    alertEmail: process.env.MERCHANT_ALERT_EMAIL,
    alertPhone: process.env.MERCHANT_ALERT_PHONE,
  },
};
