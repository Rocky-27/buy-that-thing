#!/usr/bin/env node

import path from 'node:path';
import {
  cwd,
  ensureDir,
  getShopifyAdminAccessToken,
  loadEnrichmentEnv,
  requiredEnv,
  shopifyGraphQL,
  sleep,
  timestampSlug,
  writeJsonFile
} from './lib/shopify-taxonomy-utils.mjs';

const DEFAULT_CACHE_FILENAME = 'shopify-catalog-cache.json';

function parseArgs(argv) {
  const args = {
    productQuery: 'status:active',
    productLimit: null,
    collectionLimit: null,
    interPageDelayMs: Number(process.env.SHOPIFY_CACHE_INTER_PAGE_DELAY_MS || 250) || 250,
    outputDir: path.join(cwd, 'catalog-cache'),
    cacheFile: path.join(cwd, 'catalog-cache', DEFAULT_CACHE_FILENAME)
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--product-query') {
      args.productQuery = argv[index + 1] || args.productQuery;
      index += 1;
      continue;
    }

    if (arg === '--product-limit') {
      args.productLimit = Number(argv[index + 1] || 0) || null;
      index += 1;
      continue;
    }

    if (arg === '--collection-limit') {
      args.collectionLimit = Number(argv[index + 1] || 0) || null;
      index += 1;
      continue;
    }

    if (arg === '--inter-page-delay-ms') {
      args.interPageDelayMs = Number(argv[index + 1] || args.interPageDelayMs) || args.interPageDelayMs;
      index += 1;
      continue;
    }

    if (arg === '--output-dir') {
      args.outputDir = path.resolve(cwd, argv[index + 1] || args.outputDir);
      args.cacheFile = path.join(args.outputDir, DEFAULT_CACHE_FILENAME);
      index += 1;
      continue;
    }

    if (arg === '--cache-file') {
      args.cacheFile = path.resolve(cwd, argv[index + 1] || args.cacheFile);
      args.outputDir = path.dirname(args.cacheFile);
      index += 1;
      continue;
    }
  }

  return args;
}

async function fetchProducts({ shop, token, query, limit, interPageDelayMs }) {
  const document = `
    query ProductsPage($cursor: String, $query: String!) {
      products(first: 100, after: $cursor, query: $query, sortKey: TITLE) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            title
            handle
            vendor
            productType
            tags
            status
            descriptionHtml
            collections(first: 20) {
              nodes {
                id
                handle
                title
              }
            }
            options {
              name
              values
            }
            variants(first: 20) {
              nodes {
                id
                title
                sku
                barcode
                availableForSale
                price
                selectedOptions {
                  name
                  value
                }
              }
            }
          }
        }
      }
    }
  `;

  const products = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await shopifyGraphQL({
      shop,
      token,
      query: document,
      variables: { cursor, query }
    });

    const connection = data.products;
    for (const edge of connection.edges) {
      products.push({
        ...edge.node,
        collections: edge.node.collections.nodes,
        variants: edge.node.variants.nodes
      });

      if (limit && products.length >= limit) {
        return products;
      }
    }

    hasNextPage = connection.pageInfo.hasNextPage;
    cursor = connection.pageInfo.endCursor;
    if (hasNextPage) {
      await sleep(interPageDelayMs);
    }
  }

  return products;
}

async function fetchCollections({ shop, token, limit, interPageDelayMs }) {
  const document = `
    query CollectionsPage($cursor: String) {
      collections(first: 100, after: $cursor, sortKey: TITLE) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            title
            handle
            descriptionHtml
            sortOrder
            ruleSet {
              appliedDisjunctively
              rules {
                column
                relation
                condition
              }
            }
            parentCollectionMetafield: metafield(namespace: "custom", key: "parent_collection") {
              value
              type
              reference {
                ... on Collection {
                  id
                  handle
                  title
                }
              }
            }
            childCollectionsMetafield: metafield(namespace: "custom", key: "child_collections") {
              value
              type
              references(first: 50) {
                nodes {
                  ... on Collection {
                    id
                    handle
                    title
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const collections = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await shopifyGraphQL({
      shop,
      token,
      query: document,
      variables: { cursor }
    });

    const connection = data.collections;
    for (const edge of connection.edges) {
      const collection = edge.node;
      collections.push({
        id: collection.id,
        title: collection.title,
        handle: collection.handle,
        descriptionHtml: collection.descriptionHtml,
        sortOrder: collection.sortOrder,
        ruleSet: collection.ruleSet,
        parentCollection: collection.parentCollectionMetafield?.reference || null,
        childCollections: collection.childCollectionsMetafield?.references?.nodes || []
      });

      if (limit && collections.length >= limit) {
        return collections;
      }
    }

    hasNextPage = connection.pageInfo.hasNextPage;
    cursor = connection.pageInfo.endCursor;
    if (hasNextPage) {
      await sleep(interPageDelayMs);
    }
  }

  return collections;
}

async function main() {
  await loadEnrichmentEnv();

  const args = parseArgs(process.argv.slice(2));
  const shop = requiredEnv('SHOPIFY_SHOP_DOMAIN');
  const token = await getShopifyAdminAccessToken(shop);

  await ensureDir(args.outputDir);

  console.log('Caching Shopify products...');
  const products = await fetchProducts({
    shop,
    token,
    query: args.productQuery,
    limit: args.productLimit,
    interPageDelayMs: args.interPageDelayMs
  });

  console.log('Caching Shopify collections...');
  const collections = await fetchCollections({
    shop,
    token,
    limit: args.collectionLimit,
    interPageDelayMs: args.interPageDelayMs
  });

  const payload = {
    generated_at: new Date().toISOString(),
    shop,
    product_query: args.productQuery,
    product_count: products.length,
    collection_count: collections.length,
    products,
    collections
  };

  await writeJsonFile(args.cacheFile, payload);
  console.log(`Cached ${products.length} products and ${collections.length} collections to ${args.cacheFile}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
