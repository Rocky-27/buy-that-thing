# Shopify Catalog Scripts

These scripts provide a clean PHP-based flow for:

1. Pulling products and collections from Shopify into `storage/`
2. Reviewing products against available collection tags with a local Ollama model
3. Writing approved title, description, and tag changes back to Shopify

## Requirements

- PHP 8.4+
- cURL enabled in PHP
- Shopify Admin API token with product read/write access
- Local Ollama running when using the review step

## Environment

The scripts read from `.env` at the project root:

- `SHOPIFY_SHOP_DOMAIN`
- `SHOPIFY_API_VERSION`
- `SHOPIFY_CLIENT_ID`
- `SHOPIFY_CLIENT_SECRET`
- `OLLAMA_BASE_URL` (optional, defaults to `http://localhost:11434`)
- `OLLAMA_MODEL` (optional, only used as a prompt default)

Optional:

- `SHOPIFY_ADMIN_ACCESS_TOKEN`

## Shopify auth

For current Dev Dashboard apps on a store you own, these scripts fetch a short-lived Admin API token automatically using `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`, then cache it under `storage/runtime/`.

`SHOPIFY_ADMIN_ACCESS_TOKEN` is only kept as an optional fallback for legacy admin-created custom apps that already have a fixed token.

## Scripts

### Pull catalog

```bash
php scripts/pull-shopify-catalog.php
```

This fetches:

- `storage/catalog/products.json`
- `storage/catalog/collections.json`

Collections are stored with title, description, and the detected smart-collection tag rule when one exists.

### Review with Ollama

```bash
php scripts/review-products-with-ollama.php --tag-mode=append
```

Optional flags:

- `--tag-mode=append|overwrite`
- `--dry-run=true|false`
- `--limit=25`
- `--batch-size=10`
- `--keep-alive=15m`
- `--warmup=true|false`
- `--resume=true|false`
- `--checkpoint-every=1`
- `--model=qwen3:1.7b`

This writes `storage/reviews/product-reviews.json` unless dry run is enabled.

The review output stores both the current values the model reviewed and the suggested replacements. Use `--limit=25` to cap a run to the first 25 products.

The review step now batches products so the collections list is shared once per batch instead of once per product. It can also warm the model up first and keep it loaded in memory between batches.
When run interactively, the model prompt reads installed models from `ollama list` and lets you choose by number or exact name.
For unattended runs, the script can resume from an existing review file, skip already-processed products, checkpoint progress during the run, and write a separate failure log.

### Push back to Shopify

```bash
php scripts/push-reviewed-products.php --dry-run=false
```

Optional flags:

- `--dry-run=true|false`
- `--limit=25`

### Clear invalid compare-at prices

```bash
php scripts/fix-shopify-compare-at-prices.php
```

This finds variants where `compare_at_price` is set to exactly the same value as `price` and clears only those compare-at prices.

Optional flags:

- `--dry-run=true|false`
- `--limit=100`
- `--mode=equal|lower-than-price|invalid`

## Notes

- Every script prompts interactively for paths and run mode.
- Dry run defaults to `yes`.
- In `append` mode, the push step only adds new tags. It does not remove old collection tags.
- In `overwrite` mode, the review step preserves non-collection tags and replaces detected collection tags with the newly suggested one.
