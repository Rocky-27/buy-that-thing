#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

const cwd = process.cwd();

async function loadEnvFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex === -1) continue;

      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim();

      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function getShopifyAdminAccessToken(shop) {
  if (process.env.SHOPIFY_ADMIN_ACCESS_TOKEN) {
    return process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  }

  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      'Missing Shopify credentials. Provide SHOPIFY_ADMIN_ACCESS_TOKEN or both SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET.'
    );
  }

  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Shopify token exchange failed (${response.status}): ${body}`);
  }

  const payload = await response.json();
  if (!payload.access_token) {
    throw new Error(`Shopify token exchange returned no access_token: ${JSON.stringify(payload)}`);
  }

  process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = payload.access_token;
  return payload.access_token;
}

async function shopifyGraphQL({ shop, token, query, variables = {} }) {
  const apiVersion = process.env.SHOPIFY_API_VERSION || '2025-10';
  const response = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token
    },
    body: JSON.stringify({ query, variables })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Shopify request failed (${response.status}): ${body}`);
  }

  const payload = await response.json();
  if (payload.errors) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(payload.errors)}`);
  }

  return payload.data;
}

async function updateProduct({ shop, token, backup }) {
  const document = `
    mutation UpdateProduct($product: ProductUpdateInput!) {
      productUpdate(product: $product) {
        product {
          id
          title
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const data = await shopifyGraphQL({
    shop,
    token,
    query: document,
    variables: {
      product: {
        id: backup.product_id,
        descriptionHtml: backup.description_html,
        tags: backup.tags
      }
    }
  });

  const errors = data.productUpdate.userErrors || [];
  if (errors.length > 0) {
    throw new Error(`Shopify productUpdate failed: ${JSON.stringify(errors)}`);
  }
}

async function main() {
  await loadEnvFile(path.join(cwd, '.env.enrich.local'));
  await loadEnvFile(path.join(cwd, '.env.enrich'));

  const backupFile = process.argv[2];
  const write = process.argv.includes('--write');

  if (!backupFile) {
    throw new Error('Usage: node scripts/enrichment/restore-product-from-backup.mjs <backup-file> [--write]');
  }

  const resolvedPath = path.resolve(process.cwd(), backupFile);
  const raw = await fs.readFile(resolvedPath, 'utf8');
  const backup = JSON.parse(raw);

  console.log(`Loaded backup for ${backup.title} (${backup.product_id})`);

  if (!write) {
    console.log('Dry-run only. Re-run with --write to restore description and tags.');
    return;
  }

  const shop = requiredEnv('SHOPIFY_SHOP_DOMAIN');
  const token = await getShopifyAdminAccessToken(shop);

  await updateProduct({ shop, token, backup });
  console.log(`Restored ${backup.title}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
