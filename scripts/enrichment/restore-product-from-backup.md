# Restore Product From Backup

Script:

- [restore-product-from-backup.mjs](scripts/enrichment/restore-product-from-backup.mjs)

Use this when you want to restore a product description and tags from a saved backup file.

Run order:

1. Pick a backup file from `enrichment-backups/`
2. Run dry first
3. Re-run with `--write` if correct

Dry run:

```bash
node scripts/enrichment/restore-product-from-backup.mjs enrichment-backups/<product-id>/<timestamp>.json
```

Write:

```bash
node scripts/enrichment/restore-product-from-backup.mjs enrichment-backups/<product-id>/<timestamp>.json --write
```
