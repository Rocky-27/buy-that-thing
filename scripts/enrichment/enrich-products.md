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
node scripts/enrichment/enrich-products.mjs --only-enriched --tags-only --review-collection-tags --include-enriched --limit 5
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
- `--tags-only` updates only tags and leaves title/description untouched.
- `--titles-only` and `--descriptions-only` cannot be used together.
- `--only-enriched` targets only products that already have the enrichment marker tag.
- If a taxonomy plan file is present, the script asks OpenAI to choose collection tags only from that managed taxonomy list.
- Managed taxonomy tags are preserved by default. Collection mapping should normally be set by the taxonomy workflow, with enrichment only reviewing them when `--review-collection-tags` is explicitly enabled.
- `--overwrite-tags` is the destructive one-off mode. It drops existing non-managed tags and replaces them with the new factual tags, while preserving the managed taxonomy tags already set on the product.
- In `--overwrite-tags` mode, managed taxonomy tags are preserved and only non-managed factual tags are rebuilt.
- `--review-collection-tags` lets the AI review the current managed collection tags against the allowed taxonomy list and keep, replace, or remove them when the fit is explicit.
- This script does not create collections. Collection creation and product-to-collection assignment happen in the taxonomy workflow first, then this script enriches the products against that approved taxonomy.
