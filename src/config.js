require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,

  shopify: {
    storeUrl: process.env.SHOPIFY_STORE_URL,
    adminApiToken: process.env.SHOPIFY_ADMIN_API_TOKEN,
    webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET,
  },

  square: {
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    applicationId: process.env.SQUARE_APPLICATION_ID,
    locationId: process.env.SQUARE_LOCATION_ID,
    environment: process.env.SQUARE_ENVIRONMENT || 'sandbox',
    webhookSignatureKey: process.env.SQUARE_WEBHOOK_SIGNATURE_KEY,
  },

  database: {
    url: process.env.DATABASE_URL,
  },

  merchant: {
    alertEmail: process.env.MERCHANT_ALERT_EMAIL,
    alertPhone: process.env.MERCHANT_ALERT_PHONE,
  },
};
