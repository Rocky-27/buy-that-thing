# Generate Collection Descriptions

Script:

- [generate-collection-descriptions.mjs](./generate-collection-descriptions.mjs)

Use this when you want AI to write or rewrite Shopify collection descriptions.

Run order:

1. Check `.env.enrich`
2. Run a dry run
3. Review `collection-description-output/`
4. Re-run with `--write` if happy

Dry run:

```bash
node scripts/collection-descriptions/generate-collection-descriptions.mjs --limit 5
```

Write:

```bash
node scripts/collection-descriptions/generate-collection-descriptions.mjs --write --limit 5
```

Useful:

```bash
node scripts/collection-descriptions/generate-collection-descriptions.mjs --handles homeware,garden
node scripts/collection-descriptions/generate-collection-descriptions.mjs --only-missing --write
```

Tone and style:

- Set `COLLECTION_DESCRIPTION_STYLE_BRIEF` in `.env.enrich` if you want collection copy to have its own tone.
- If that is not set, the script falls back to `ENRICHMENT_STYLE_BRIEF`.

Note:

- Shopify Magic / Shopify AI does not currently expose a public admin API for scripted collection-copy generation, so this workflow uses Shopify Admin data plus OpenAI to generate the text.
