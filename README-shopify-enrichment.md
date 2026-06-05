# Shopify Product Enrichment

This project includes a local enrichment script for improving Shopify product descriptions and tags using the OpenAI API.

These files are intentionally ignored by git:

- `.env.enrich`
- `.env.enrich.local`
- `local-scripts/`
- `enrichment-output/`
- `enrichment-backups/`

## Files

- [local-scripts/shopify-enrich-products.mjs](/home/james/freelance/buy-that-thing/local-scripts/shopify-enrich-products.mjs)
- [local-scripts/shopify-restore-product-from-backup.mjs](/home/james/freelance/buy-that-thing/local-scripts/shopify-restore-product-from-backup.mjs)
- [.env.enrich](/home/james/freelance/buy-that-thing/.env.enrich)

## What it does

The enrichment script:

1. Pulls products from Shopify Admin GraphQL.
2. Sends factual product data to the OpenAI Responses API.
3. Suggests:
   - a rewritten HTML description
   - factual tags
4. Saves a backup of the original Shopify description and tags before each product is processed.
5. Writes a report file to `enrichment-output/`.

The restore script can push a saved backup back to Shopify.

## Environment

Fill in `.env.enrich` with real credentials:

```dotenv
SHOPIFY_SHOP_DOMAIN=your-store.myshopify.com
SHOPIFY_ADMIN_ACCESS_TOKEN=
SHOPIFY_CLIENT_ID=your-shopify-client-id
SHOPIFY_CLIENT_SECRET=your-shopify-client-secret
SHOPIFY_API_VERSION=2025-10

OPENAI_API_KEY=your-openai-api-key
OPENAI_MODEL=gpt-5.4-mini

ENRICHMENT_MARKER_TAG=AI Enriched
ENRICHMENT_STYLE_BRIEF=Dry, lightly cheeky, plain-English product copy. Aim for understated wit, not stand-up comedy.
```

Notes:

- `.env.enrich.local` is also supported and is loaded first if present.
- Existing shell environment variables still win if already set.
- `ENRICHMENT_MARKER_TAG` is optional but recommended. Products with that tag are skipped on future runs.
- `ENRICHMENT_STYLE_BRIEF` is optional. Use it if you want to push the copy slightly more deadpan, more playful, or more restrained without editing the script.
- Use your `*.myshopify.com` domain, not the public storefront domain.
- For Dev Dashboard apps, the scripts can exchange `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` for an Admin API token automatically.
- If you already have a valid `SHOPIFY_ADMIN_ACCESS_TOKEN`, the scripts will use that directly.

## Tone

The enrichment prompt is designed to be:

- strictly factual
- lightly tongue-in-cheek
- plain English rather than corporate
- dry and characterful, without turning into novelty copy
- varied in sentence rhythm, without leaning on the same gag repeatedly

Target vibe:

- `A silicone ice cube tray. Exactly what it says on the tin. Makes ice. Surprisingly good at making ice.`

Not the vibe:

- exaggerated claims
- made-up benefits
- jokey copy that hides what the product actually is
- repeated filler like `does what it says on the tin`
- every paragraph starting with `It is` or `It’s`

If you want to push the tone, update `ENRICHMENT_STYLE_BRIEF` in `.env.enrich` and rerun a dry run first.

## Dry run

Start with a dry run:

```bash
node local-scripts/shopify-enrich-products.mjs --limit 5
```

Useful flags:

```bash
node local-scripts/shopify-enrich-products.mjs --ids 1234567890,2345678901
node local-scripts/shopify-enrich-products.mjs --query "status:active"
node local-scripts/shopify-enrich-products.mjs --limit 20 --replace-tags
```

## Write changes to Shopify

Only use `--write` once you are happy with the dry-run output:

```bash
node local-scripts/shopify-enrich-products.mjs --write --limit 5
```

## Output and backups

Reports are written to:

```text
enrichment-output/shopify-enrichment-<timestamp>.json
```

Backups are written to:

```text
enrichment-backups/<product-id>/<timestamp>.json
```

Each backup contains:

- Shopify product ID
- title
- handle
- vendor
- product type
- original tags
- original `description_html`

## Restore from backup

Dry-run restore:

```bash
node local-scripts/shopify-restore-product-from-backup.mjs enrichment-backups/1234567890123/2026-06-05T21-10-44-123Z.json
```

Write restore:

```bash
node local-scripts/shopify-restore-product-from-backup.mjs enrichment-backups/1234567890123/2026-06-05T21-10-44-123Z.json --write
```

## Recommended workflow

1. Fill in `.env.enrich`.
2. Run a dry run on 3-5 products.
3. Review the output JSON.
4. Run `--write` on a small batch.
5. Confirm in Shopify that the content looks right and is not being overwritten by Avasam.
6. Scale up in batches once you trust the flow.

## Important caution

This script only updates Shopify.

If Avasam is the source of truth for listing content on your store, it may overwrite description or tag changes on a future sync. Test on a small batch first before using this widely.
