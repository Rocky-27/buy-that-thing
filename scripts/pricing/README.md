# Pricing Sync

Deterministic repricing from Avasam data into Shopify.

## What this script does

- Reads pricing rules from JSON.
- Pulls seller inventory pricing from the Avasam Seller API.
- Matches Avasam SKUs to Shopify variant SKUs.
- Calculates a target Shopify sell price using:
  - stored Shopify cost-basis metafield when present
  - otherwise Avasam cost price only when explicitly syncing cost basis from Avasam
  - optional shipping-cost input
  - fixed and percentage fee settings
  - optional competitor caps
- Updates Shopify variant prices grouped by product using `productVariantsBulkUpdate`.
- Can seed a Shopify variant metafield with a derived base landed cost for one-off normalization.
- Writes a JSON report for every run.

## What it does not do

- It does not currently write prices back into Avasam.
- It does not manage Avasam pricing rules by API.
- It does not scrape competitors by itself. Competitor prices are currently an optional input file.

## Environment

Create `.env.pricing` or `.env.pricing.local`.

```bash
SHOPIFY_SHOP_DOMAIN=your-shop.myshopify.com
SHOPIFY_ADMIN_ACCESS_TOKEN=shpat_xxx
SHOPIFY_API_VERSION=2025-10

AVASAM_AUTH_URL=https://app.avasam.com/api/auth/request-token
AVASAM_API_BASE_URL=https://app.avasam.com/apiseeker
AVASAM_CONSUMER_KEY=xxx
AVASAM_SECRET_KEY=xxx

# Optional if your account expects a different auth header name
AVASAM_AUTH_HEADER=Authkey

# Optional if your account uses a different inventory endpoint path
AVASAM_INVENTORY_ENDPOINT=ProductModule/GetInventoryListWithFilter
```

## Config files

- `pricing-config.example.json`
- `shipping-costs.example.json`
- `competitor-prices.example.json`

Copy the pricing config and adjust the rule bands, fees, and shipping/competitor file paths.

The example config also defines a Shopify variant metafield:

- namespace: `custom`
- key: `base_landed_cost`
- type: `number_decimal`

When that metafield exists, repricing uses it as the landed-cost basis. When it is missing, the script can bootstrap it from the current Shopify price using the configured divisor.

## Usage

Dry run:

```bash
node scripts/pricing/sync-prices.mjs --config scripts/pricing/pricing-config.example.json
```

By default, Shopify variants are queried with `status:active`.
By default, repricing uses the existing Shopify variant cost-basis metafield and does not call Avasam.

One-off metafield seed from existing Shopify prices only:

```bash
node scripts/pricing/sync-prices.mjs --config scripts/pricing/pricing-config.example.json --seed-cost-basis-only
```

Write that one-off seed into Shopify:

```bash
node scripts/pricing/sync-prices.mjs --config scripts/pricing/pricing-config.example.json --seed-cost-basis-only --write
```

Write Shopify price updates:

```bash
node scripts/pricing/sync-prices.mjs --config scripts/pricing/pricing-config.example.json --write
```

If you later want to refresh the stored cost basis from live Avasam landed cost before repricing, use:

```bash
node scripts/pricing/sync-prices.mjs --config scripts/pricing/pricing-config.example.json --sync-cost-basis-from-avasam --write
```

That is the only mode that requires the Avasam env vars.

Only target a subset of SKUs:

```bash
node scripts/pricing/sync-prices.mjs --config scripts/pricing/pricing-config.example.json --skus SKU1,SKU2
```

Or:

```bash
node scripts/pricing/sync-prices.mjs --config scripts/pricing/pricing-config.example.json --sku-file ./sku-list.txt
```

## Cost-basis bootstrap

For your current catalog state, where Shopify prices already include the historic 25% uplift, set:

```json
"costBasisMetafield": {
  "bootstrap": {
    "enabled": true,
    "divisor": 1.25
  }
}
```

On the first pass, the script will derive:

- `base_landed_cost = current_shopify_price / 1.25`

and write that to the configured variant metafield. After that, normal repricing uses the stored metafield value instead of inferring from the current sell price again.

## Shipping-cost note

The public Avasam Seller API docs clearly describe pricing rules that can include shipping cost, but the product-list responses in the public docs do not clearly expose a per-SKU shipping-cost field. Because of that, this scaffold treats shipping cost as an explicit optional input file.

If Avasam support confirms a seller API endpoint that returns the resolved shipping cost per SKU, the script can be updated to fetch that directly and remove the manual shipping layer.

## Competitor pricing note

Competitor-aware repricing is easy to support deterministically once you have a trusted input source. The hard part is obtaining reliable competitor prices legally and consistently.

Practical options:

- manual or exported file keyed by SKU
- a marketplace-specific feed or API you already have rights to use
- a separate enrichment process that writes normalized competitor prices into JSON

The sync script already supports a competitor file and can undercut by a configured percentage while respecting margin floors.
