require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,

  shopify: {
    storeUrl: process.env.SHOPIFY_STORE_URL,
    adminApiToken: process.env.SHOPIFY_ADMIN_API_TOKEN,
    webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET,
    clientId: process.env.SHOPIFY_CLIENT_ID,
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET,
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
  },

  merchant: {
    alertEmail: process.env.MERCHANT_ALERT_EMAIL,
    alertPhone: process.env.MERCHANT_ALERT_PHONE,
  },
};
