# Everform Middleware - Project Summary

## Overview

The Everform Middleware is a Node.js/Express server deployed on Railway that bridges **Shopify** (order management) and **Square** (payment processing). When a Shopify order is created with "payment due later," the middleware automatically creates a Square invoice and sends it to the customer. When the customer pays the invoice, Square notifies the middleware via webhook, which then marks the Shopify order as paid.

An "air gap" is maintained between the two platforms: product names are never sent to Square. Invoices use generic line items ("Research Materials" and "Shipping").

## Architecture

```
Shopify Store                    Railway (Middleware)                  Square
─────────────                    ───────────────────                  ──────
Order Created ──webhook──> /webhooks/shopify/orders
                                  │
                                  ├─ Parse order data
                                  ├─ Find/create Square customer
                                  ├─ Check for card on file
                                  │
                                  ├─ [Has card] ──> Auto-charge via Square Payments API
                                  │                   │
                                  │                   ├─ Success: mark Shopify order paid
                                  │                   └─ Failure: fall through to invoice
                                  │
                                  └─ [No card / charge failed] ──> Create Square Invoice
                                                                     │
                                                                     └─ Invoice emailed to customer
                                                                          │
                                                                     Customer pays invoice
                                                                          │
Square webhook ──────────────────────────────────────── invoice.payment_made
                                  │
                           /webhooks/square
                                  │
                                  ├─ Verify signature
                                  ├─ Match invoice to order in DB
                                  ├─ Update order status to 'paid'
                                  └─ Mark Shopify order as paid (GraphQL mutation)
```

## Tech Stack

- **Runtime**: Node.js with Express
- **Database**: PostgreSQL (Railway-managed)
- **Deployment**: Railway (auto-deploy from GitHub on push)
- **Shopify API**: REST + GraphQL Admin API (v2025-01)
- **Square SDK**: square npm package (v37.1.1)
- **Webhook verification**: HMAC-SHA256 for both Shopify and Square

## Project Structure

```
everform-middleware/
├── src/
│   ├── index.js              # Express server, healthcheck, DB migrations
│   ├── config.js             # Centralized env var config
│   ├── db/
│   │   ├── pool.js           # PostgreSQL connection pool
│   │   ├── migrate.js        # Migration script
│   │   └── queries.js        # Customer and order CRUD operations
│   ├── middleware/
│   │   └── rawBody.js        # Preserves raw body for webhook signature verification
│   ├── routes/
│   │   ├── shopifyAuth.js    # OAuth install flow (/auth, /auth/callback)
│   │   ├── shopifyWebhook.js # Shopify order webhook handler
│   │   └── squareWebhook.js  # Square payment webhook handler
│   └── services/
│       ├── shopify.js        # Shopify REST + GraphQL API calls
│       ├── square.js         # Square API calls (customers, invoices, payments)
│       └── alerts.js         # Merchant alert notifications
├── .env.example              # Environment variable template
├── package.json
├── Procfile                  # Railway start command
├── railway.toml              # Railway config
└── Logs/                     # Debug screenshots and logs
```

## Database Schema

### customers
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL | Primary key |
| shopify_customer_id | TEXT | Unique |
| square_customer_id | TEXT | |
| email | TEXT | |
| has_card_on_file | BOOLEAN | Enables auto-charge |
| created_at | TIMESTAMPTZ | Default NOW() |

### orders
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL | Primary key |
| shopify_order_id | TEXT | Unique |
| shopify_order_number | TEXT | |
| square_invoice_id | TEXT | |
| square_payment_id | TEXT | |
| status | TEXT | pending / invoiced / paid |
| total | NUMERIC | |
| created_at | TIMESTAMPTZ | Default NOW() |

## Environment Variables

All configured in Railway:

| Variable | Description |
|----------|-------------|
| `SHOPIFY_STORE_URL` | `everform-life.myshopify.com` (note the hyphen) |
| `SHOPIFY_CLIENT_ID` | Dev Dashboard app client ID |
| `SHOPIFY_CLIENT_SECRET` | Dev Dashboard app client secret |
| `SHOPIFY_ADMIN_API_TOKEN` | OAuth access token (shpat_) |
| `SHOPIFY_WEBHOOK_SECRET` | Shopify webhook HMAC secret |
| `SQUARE_ACCESS_TOKEN` | Square production access token |
| `SQUARE_APPLICATION_ID` | Square production app ID |
| `SQUARE_LOCATION_ID` | Square business location ID |
| `SQUARE_ENVIRONMENT` | `production` |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | Square production webhook signature key |
| `DATABASE_URL` | Railway PostgreSQL connection string |
| `PORT` | `3000` (Railway default) |

## Key Implementation Details

### Shopify Integration
- **Webhook**: Subscribed to `orders/create` events via Shopify Admin
- **Order marking**: Uses GraphQL `orderMarkAsPaid` mutation (REST Transactions API doesn't work for "payment due later" orders)
- **Order notes**: Adds a note to the Shopify order with the Square invoice/payment reference
- **API version**: `2025-01` (current stable)
- **Auth**: OAuth via Shopify Dev Dashboard (legacy custom apps deprecated Jan 2026)

### Square Integration
- **Customer management**: Finds existing customers by email or creates new ones
- **Card on file**: Checks if customer has a saved card for auto-charging
- **Invoice creation**: Creates a Square Order, then an Invoice linked to that order, then publishes (sends) the invoice via email
- **Auto-charge**: Attempts to charge saved card first; falls back to invoice on failure
- **Line items**: Generic names only ("Research Materials", "Shipping") for the air gap
- **Webhook**: Subscribed to `invoice.payment_made` events

### Webhook Security
- Both Shopify and Square webhooks verify HMAC-SHA256 signatures
- Raw body is preserved via custom middleware for signature verification
- Railway terminates TLS at the proxy, so `https://` is hardcoded for webhook URL construction

### Error Handling
- Shopify `markOrderAsPaid` retries once on failure
- Merchant alerts triggered on persistent failures
- Idempotency: orders use `ON CONFLICT DO NOTHING` to prevent duplicates
- Square auto-charge returns `null` on failure (graceful fallback to invoice)

## Deployment

The app deploys automatically when you push to `main`:

```bash
git push origin main
```

Railway runs the healthcheck at `/health` and starts the server via `node src/index.js`.

## Build & Debug History

### Issues Resolved During Development

1. **Square invoice `customFields` error** - Removed `customFields` from invoice creation (requires paid Square subscription)

2. **Square webhook 401 (invalid signature)** - Route path mismatch (`/webhooks/square/payment` vs `/webhooks/square`) and `req.protocol` returning `http` behind Railway's TLS proxy. Fixed by correcting the route and hardcoding `https://`.

3. **Shopify REST Transactions API 404** - The REST Transactions API requires an authorization transaction that "payment due later" orders don't have. Switched to GraphQL `orderMarkAsPaid` mutation.

4. **Shopify Admin API 404 on all versions** - The `SHOPIFY_STORE_URL` was set to `everformlife.myshopify.com` but the actual store domain is `everform-life.myshopify.com` (with a hyphen). The store had been renamed, causing all API calls to return 404 regardless of API version or token validity.

5. **API version confusion** - The Shopify Dev Dashboard showed `2026-01` as the webhook API version, but this is an unreleased version. The working Admin API version is `2025-01`.

## Pending Items

- **Credential rotation**: The Shopify access token was exposed during debugging and should be rotated via the Dev Dashboard (reinstall the app to get a new token)
- **Merchant alerts**: Currently logs to console. Can be extended to send email/SMS via a service like SendGrid or Twilio
- **Monitoring**: Consider adding uptime monitoring for the Railway deployment
