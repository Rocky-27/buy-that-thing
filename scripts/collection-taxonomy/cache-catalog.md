# Cache Catalog

Script:

- [cache-catalog.mjs](scripts/collection-taxonomy/cache-catalog.mjs)

Use this first. It pulls Shopify products and collections into a local cache file.

Default file:

- `catalog-cache/shopify-catalog-cache.json`

Run order:

1. Run this
2. Use the cache file in `plan-taxonomy`
3. Use both files in `apply-taxonomy`

Run:

```bash
node scripts/collection-taxonomy/cache-catalog.mjs
```

Useful:

```bash
node scripts/collection-taxonomy/cache-catalog.mjs --product-query "status:active"
node scripts/collection-taxonomy/cache-catalog.mjs --product-limit 50 --collection-limit 20
node scripts/collection-taxonomy/cache-catalog.mjs --cache-file catalog-cache/my-cache.json
```
