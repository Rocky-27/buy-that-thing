# Shopify Collection Taxonomy Workflow

This repo now includes local scripts to:

1. cache Shopify products and collections
2. generate a proposed smart-collection taxonomy plan
3. apply tags, smart collections, and hierarchy metafields back to Shopify

## Scripts

- [scripts/collection-taxonomy/cache-catalog.mjs](scripts/collection-taxonomy/cache-catalog.mjs)
- [scripts/collection-taxonomy/plan-taxonomy.mjs](scripts/collection-taxonomy/plan-taxonomy.mjs)
- [scripts/collection-taxonomy/apply-taxonomy.mjs](scripts/collection-taxonomy/apply-taxonomy.mjs)
- [scripts/collection-taxonomy/AGENTS.md](scripts/collection-taxonomy/AGENTS.md)
- [scripts/collection-taxonomy/cache-catalog.md](scripts/collection-taxonomy/cache-catalog.md)
- [scripts/collection-taxonomy/plan-taxonomy.md](scripts/collection-taxonomy/plan-taxonomy.md)
- [scripts/collection-taxonomy/apply-taxonomy.md](scripts/collection-taxonomy/apply-taxonomy.md)

## Why this shape is sensible

This workflow separates:

- read-only catalog sync
- AI planning
- Shopify write operations

That matters because taxonomy decisions are high-leverage and easy to get wrong if they go straight from prompt to live store without review.

## Important Shopify constraints

- Products can be in multiple smart collections through tags.
- Smart collections are a good fit when the collection rule is stable.
- Existing manual collections cannot be converted into smart collections by simply updating rules. The apply script flags those as conflicts.
- New collections created through GraphQL are unpublished by default. Publish them manually after review if needed.
- Collection URLs stay flat in Shopify even if the hierarchy metafields and breadcrumbs are nested.

## Step 1: Cache the catalog

```bash
node scripts/collection-taxonomy/cache-catalog.mjs
```

Useful flags:

```bash
node scripts/collection-taxonomy/cache-catalog.mjs --product-limit 50 --collection-limit 20
node scripts/collection-taxonomy/cache-catalog.mjs --product-query "status:active"
node scripts/collection-taxonomy/cache-catalog.mjs --cache-file catalog-cache/my-cache.json
```

Default cache file:

```text
catalog-cache/shopify-catalog-cache.json
```

## Step 2: Build a taxonomy plan

OpenAI-backed planning:

```bash
node scripts/collection-taxonomy/plan-taxonomy.mjs --engine openai
```

Heuristic fallback:

```bash
node scripts/collection-taxonomy/plan-taxonomy.mjs --engine heuristic
```

Default plan file:

```text
taxonomy-plans/shopify-collection-taxonomy-plan.json
```

This creates a plan JSON containing:

- proposed smart collections
- a hierarchy using `parent_handle`
- managed tags for each collection
- matching rules used to add those managed tags to products
- normalized Shopify sort order enum values such as `BEST_SELLING`

## Step 3: Dry-run the apply step

```bash
node scripts/collection-taxonomy/apply-taxonomy.mjs
```

This does not write to Shopify. It produces a report showing:

- products that would receive new tags
- collections that would be created or updated
- hierarchy metadata that would be set
- conflicts and warnings

If you only want to sync collections and hierarchy without retagging products:

```bash
node scripts/collection-taxonomy/apply-taxonomy.mjs --collections-only
```

## Step 4: Apply to Shopify

```bash
node scripts/collection-taxonomy/apply-taxonomy.mjs --write
```

Collections and hierarchy only:

```bash
node scripts/collection-taxonomy/apply-taxonomy.mjs --collections-only --write
```

## Current implementation details

- Product tags are always additive.
- Every proposed smart collection is driven by one managed tag.
- Hierarchy metafields are written to:
  - `custom.parent_collection`
  - `custom.child_collections`
- Child hierarchy is derived from the plan and written back automatically.

## Recommended operating pattern

1. Cache the live catalog.
2. Generate a plan.
3. Review the plan JSON carefully.
4. Run an apply dry-run.
5. Apply with `--write`.
6. Review new collections in Shopify admin and publish any new ones that should go live.
