# Enrich Products

Script:

- [enrich-products.mjs](scripts/enrichment/enrich-products.mjs)

Use this when you want AI to rewrite Shopify product descriptions and suggest extra tags.

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
```
