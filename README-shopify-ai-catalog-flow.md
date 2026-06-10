# Shopify AI Catalog Flow

Use this when you want one strict process for the whole store:

1. create or update collections
2. assign products to the right collections
3. enrich titles, descriptions, and tags

This is the simplest safe flow for all active products.

## What each script does

- `scripts/collection-taxonomy/cache-catalog.mjs`
  - pulls the live Shopify catalog into a local cache
- `scripts/collection-taxonomy/plan-taxonomy.mjs`
  - asks AI to propose the collection structure and managed collection tags
- `scripts/collection-taxonomy/apply-taxonomy.mjs`
  - creates or updates smart collections and applies the managed collection tags to products
- `scripts/enrichment/enrich-products.mjs`
  - rewrites product titles and descriptions, and rebuilds product tags using the approved taxonomy plan

## Full flow

### 1. Cache the current catalog

```bash
node scripts/collection-taxonomy/cache-catalog.mjs --product-query "status:active"
```

### 2. Let AI plan the collection structure

```bash
node scripts/collection-taxonomy/plan-taxonomy.mjs --engine openai
```

Review:

- `catalog-cache/shopify-catalog-cache.json`
- `taxonomy-plans/shopify-collection-taxonomy-plan.json`

### 3. Dry-run the collection apply step

This shows:

- new collections that would be created
- existing collections that would be updated
- products that would receive managed collection tags

```bash
node scripts/collection-taxonomy/apply-taxonomy.mjs
```

### 4. Apply collections and collection-tag assignment

```bash
node scripts/collection-taxonomy/apply-taxonomy.mjs --write
```

This is the step that lets AI manage collection creation and product-to-collection assignment.

### 5. Dry-run product enrichment

This uses the taxonomy plan from step 2 so products are tagged against the approved collection structure instead of inventing loose collection tags.

```bash
node scripts/enrichment/enrich-products.mjs --include-enriched --overwrite-tags --query "status:active"
```

Review the newest file in:

- `enrichment-output/`

### 6. Apply product enrichment

```bash
node scripts/enrichment/enrich-products.mjs --write --include-enriched --overwrite-tags --query "status:active"
```

This will:

- enrich products for the first time
- reprocess already enriched products
- replace stale non-marker tags
- replace stale managed collection tags chosen during enrichment
- keep the enrichment marker tag if configured

## Recommended operating pattern

For a full-store run:

1. Cache catalog
2. Plan taxonomy with AI
3. Review the plan
4. Apply taxonomy in dry run
5. Apply taxonomy live
6. Dry-run enrichment
7. Apply enrichment live

## Important note

Collection creation and collection assignment are controlled by the taxonomy workflow, not by the enrichment script alone.

That separation is intentional:

- taxonomy decides what collections should exist
- taxonomy apply creates them and assigns products
- enrichment improves product content and keeps product tags aligned with the approved taxonomy
