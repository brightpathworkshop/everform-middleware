const config = require('../config');

// Merchant alert service.
// For MVP, we log all alerts to console. A future enhancement
// could send email/SMS via SendGrid, Twilio, or Square Messages.

function alertMerchant(subject, detail) {
  const timestamp = new Date().toISOString();
  console.error(`[ALERT] ${timestamp} | ${subject} | ${detail}`);

  // TODO: send email/SMS if MERCHANT_ALERT_EMAIL or MERCHANT_ALERT_PHONE is set
  // For now, Railway logs capture these for monitoring.
}

module.exports = { alertMerchant };
