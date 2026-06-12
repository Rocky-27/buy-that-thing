# Plan Taxonomy

For the simplest end-to-end store workflow, start with [README-shopify-ai-catalog-flow.md](../../README-shopify-ai-catalog-flow.md).

Script:

- [plan-taxonomy.mjs](scripts/collection-taxonomy/plan-taxonomy.mjs)

Use this after caching the catalog. It creates a proposed collection structure and managed tag plan.

Defaults:

- cache file: `catalog-cache/shopify-catalog-cache.json`
- output plan file: `taxonomy-plans/shopify-collection-taxonomy-plan.json`

Sort order in the plan is normalized to Shopify enum values like `BEST_SELLING`.

Run order:

1. Run `cache-catalog`
2. Run this
3. Review the plan file
4. Use the plan file in `apply-taxonomy`

OpenAI mode:

```bash
node scripts/collection-taxonomy/plan-taxonomy.mjs --engine openai
```

Fallback mode:

```bash
node scripts/collection-taxonomy/plan-taxonomy.mjs --engine heuristic
```

Override files if needed:

```bash
node scripts/collection-taxonomy/plan-taxonomy.mjs --cache-file catalog-cache/my-cache.json --plan-file taxonomy-plans/my-plan.json --engine openai
```

Notes:

- The planner now defaults to a larger collection budget, a minimum target collection count, and more sample products per product type so it can propose more granular child collections.
- If you want to push specificity harder, raise `--max-collections` and `--min-collections`.
- If you want to constrain it again, use `--max-collections` with a lower number.
