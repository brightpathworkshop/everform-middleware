# Everform Middleware

Shopify ↔ Square middleware for Everform Life. Receives Shopify order webhooks, creates Square invoices with generic descriptions, and marks orders paid when payment is received.

## Setup

### 1. Create a GitHub repo

```bash
cd everform-middleware
git init
git add .
git commit -m "Initial commit"
```

Push to a new GitHub repo.

### 2. Railway

1. Sign up at [railway.com](https://railway.com) and connect your GitHub
2. Create a new project → "Deploy from GitHub repo" → select this repo
3. Add a **Postgres** plugin to the project (click "+ New" → Database → PostgreSQL)
4. Railway auto-injects `DATABASE_URL` — no config needed for DB connection
5. Add the remaining environment variables in the Railway dashboard (Settings → Variables):

```
SHOPIFY_STORE_URL=everformlife.myshopify.com
SHOPIFY_ADMIN_API_TOKEN=shpat_xxxxx
SHOPIFY_WEBHOOK_SECRET=xxxxx
SQUARE_ACCESS_TOKEN=xxxxx
SQUARE_APPLICATION_ID=xxxxx
SQUARE_LOCATION_ID=xxxxx
SQUARE_ENVIRONMENT=sandbox
SQUARE_WEBHOOK_SIGNATURE_KEY=xxxxx
```

6. Deploy. Railway gives you a public URL like `everform-middleware-production-xxxx.up.railway.app`

### 3. Shopify

1. Go to Settings → Apps → Develop Apps → Create an app
2. Configure Admin API scopes: `read_orders`, `write_orders`, `read_customers`
3. Install the app and copy the Admin API access token
4. Go to Settings → Notifications → Webhooks → Create webhook:
   - Event: `Order creation`
   - URL: `https://your-railway-url.up.railway.app/webhooks/shopify/orders`
   - Format: JSON
5. Copy the webhook signing secret
6. Set checkout to manual payment with message: "You'll receive a payment link via text and email within 60 seconds. Returning members with a card on file will be charged automatically."

### 4. Square

1. Go to [developer.squareup.com](https://developer.squareup.com)
2. Create an application
3. Copy: Access Token, Application ID
4. Get Location ID from Square Dashboard → Locations
5. Go to Webhooks → Subscribe:
   - URL: `https://your-railway-url.up.railway.app/webhooks/square/payment`
   - Events: `invoice.payment_made`
6. Copy the webhook signature key

### 5. Go live

1. Test with Square sandbox + Shopify dev store first
2. Switch `SQUARE_ENVIRONMENT` to `production` and update tokens
3. Redeploy

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Service status |
| GET | `/health` | Health check |
| POST | `/webhooks/shopify/orders` | Shopify order webhook |
| POST | `/webhooks/square/payment` | Square payment webhook |

## Architecture

```
Shopify order → Middleware → Square invoice (or auto-charge) → Customer pays → Middleware → Shopify marked paid
```
