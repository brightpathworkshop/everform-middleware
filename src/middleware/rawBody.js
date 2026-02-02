// Capture raw body for webhook signature verification.
// Express needs the raw Buffer to verify HMAC signatures,
// but also needs parsed JSON for route handlers.

function rawBodyMiddleware(req, res, next) {
  let data = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { data += chunk; });
  req.on('end', () => {
    req.rawBody = data;
    try {
      req.body = JSON.parse(data);
    } catch {
      req.body = {};
    }
    next();
  });
}

module.exports = rawBodyMiddleware;
