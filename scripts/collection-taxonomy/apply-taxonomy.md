# Apply Taxonomy

Script:

- [apply-taxonomy.mjs](scripts/collection-taxonomy/apply-taxonomy.mjs)

Use this last. It reads the cache file and plan file, then prepares or applies Shopify changes.

Defaults:

- cache file: `catalog-cache/shopify-catalog-cache.json`
- plan file: `taxonomy-plans/shopify-collection-taxonomy-plan.json`

Run order:

1. Run `cache-catalog`
2. Run `plan-taxonomy`
3. Run this in dry mode
4. Review the report
5. Re-run with `--write`

Dry run:

```bash
node scripts/collection-taxonomy/apply-taxonomy.mjs
```

Collections only:

```bash
node scripts/collection-taxonomy/apply-taxonomy.mjs --collections-only
```

Write:

```bash
node scripts/collection-taxonomy/apply-taxonomy.mjs --write
```

Collections only write:

```bash
node scripts/collection-taxonomy/apply-taxonomy.mjs --collections-only --write
```

Override files if needed:

```bash
node scripts/collection-taxonomy/apply-taxonomy.mjs --cache-file catalog-cache/my-cache.json --plan-file taxonomy-plans/my-plan.json
```

What it writes:

- additive product tags
- smart collections
- collection hierarchy metafields
