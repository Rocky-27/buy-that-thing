# Enrich Products

For the simplest end-to-end store workflow, start with [README-shopify-ai-catalog-flow.md](../../README-shopify-ai-catalog-flow.md).

Script:

- [enrich-products.mjs](scripts/enrichment/enrich-products.mjs)

Use this when you want AI to rewrite Shopify product descriptions, clean up product titles, and rebuild product tags with tighter taxonomy handling.

Run order:

1. Check `.env.enrich`
2. Run a dry run
3. Review `enrichment-output/`
4. Re-run with `--write` if happy

Dry run:

```bash
node scripts/enrichment/enrich-products.mjs --limit 5
```

Write:

```bash
node scripts/enrichment/enrich-products.mjs --write --limit 5
```

Useful:

```bash
node scripts/enrichment/enrich-products.mjs --ids 1234567890,2345678901
node scripts/enrichment/enrich-products.mjs --query "status:active"
node scripts/enrichment/enrich-products.mjs --include-enriched --limit 5
node scripts/enrichment/enrich-products.mjs --titles-only --include-enriched --limit 5
node scripts/enrichment/enrich-products.mjs --descriptions-only --limit 5
node scripts/enrichment/enrich-products.mjs --write --overwrite-tags --include-enriched --limit 20
node scripts/enrichment/enrich-products.mjs --taxonomy-plan taxonomy-plans/shopify-collection-taxonomy-plan.json --limit 5
```

Notes:

- Products with `ENRICHMENT_MARKER_TAG` are skipped by default.
- Use `--include-enriched` to process products that were already marked as enriched.
- Title cleanup keeps the main product name and factual specs, while removing decorative or non-factual promo wording.
- `--titles-only` updates only the product title.
- `--descriptions-only` updates only the product description.
- `--titles-only` and `--descriptions-only` cannot be used together.
- If a taxonomy plan file is present, the script asks OpenAI to choose collection tags only from that managed taxonomy list.
- Existing managed taxonomy tags are replaced with the new selection on each run so collection mapping can be corrected without preserving stale taxonomy tags.
- `--overwrite-tags` is the destructive one-off mode. It drops existing non-marker tags and replaces them with the new factual tags plus any selected managed taxonomy tags.
- This script does not create collections. Collection creation and product-to-collection assignment happen in the taxonomy workflow first, then this script enriches the products against that approved taxonomy.
