#!/usr/bin/env node

import path from 'node:path';
import {
  cwd,
  ensureDir,
  getShopifyAdminAccessToken,
  loadEnrichmentEnv,
  requestOpenAIJson,
  requiredEnv,
  shopifyGraphQL,
  stripHtml,
  timestampSlug,
  writeJsonFile
} from '../collection-taxonomy/lib/shopify-taxonomy-utils.mjs';

function parseArgs(argv) {
  const args = {
    write: false,
    limit: null,
    handles: [],
    onlyMissing: false,
    outputDir: path.join(cwd, 'collection-description-output')
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--write') {
      args.write = true;
      continue;
    }

    if (arg === '--limit') {
      args.limit = Number(argv[index + 1] || 0) || null;
      index += 1;
      continue;
    }

    if (arg === '--handles') {
      args.handles = (argv[index + 1] || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      index += 1;
      continue;
    }

    if (arg === '--only-missing') {
      args.onlyMissing = true;
      continue;
    }

    if (arg === '--output-dir') {
      args.outputDir = path.resolve(cwd, argv[index + 1] || args.outputDir);
      index += 1;
    }
  }

  return args;
}

async function fetchCollections({ shop, token, handles = [], limit = null }) {
  const handleSet = new Set(handles);
  const collections = [];
  let cursor = null;
  let hasNextPage = true;

  const query = `
    query FetchCollections($cursor: String) {
      collections(first: 40, after: $cursor, sortKey: TITLE) {
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
            productsCount {
              count
            }
            updatedAt
            parentCollectionMetafield: metafield(namespace: "custom", key: "parent_collection") {
              reference {
                ... on Collection {
                  id
                  title
                  handle
                }
              }
            }
            childCollectionsMetafield: metafield(namespace: "custom", key: "child_collections") {
              references(first: 12) {
                nodes {
                  ... on Collection {
                    id
                    title
                    handle
                    productsCount {
                      count
                    }
                  }
                }
              }
            }
            products(first: 8) {
              nodes {
                id
                title
                vendor
                productType
                tags
              }
            }
          }
        }
      }
    }
  `;

  while (hasNextPage) {
    const data = await shopifyGraphQL({
      shop,
      token,
      query,
      variables: { cursor }
    });

    const connection = data.collections;
    for (const edge of connection.edges) {
      const node = edge.node;

      if (handleSet.size > 0 && !handleSet.has(node.handle)) {
        continue;
      }

      collections.push({
        id: node.id,
        title: node.title,
        handle: node.handle,
        descriptionHtml: node.descriptionHtml || '',
        descriptionText: stripHtml(node.descriptionHtml || ''),
        productsCount: node.productsCount?.count || 0,
        updatedAt: node.updatedAt,
        parentCollection: node.parentCollectionMetafield?.reference || null,
        childCollections: node.childCollectionsMetafield?.references?.nodes || [],
        sampleProducts: (node.products?.nodes || []).map((product) => ({
          id: product.id,
          title: product.title,
          vendor: product.vendor,
          productType: product.productType,
          tags: product.tags || []
        }))
      });

      if (limit && collections.length >= limit) {
        return collections;
      }
    }

    hasNextPage = connection.pageInfo.hasNextPage;
    cursor = connection.pageInfo.endCursor;
  }

  return collections;
}

function getStyleBrief() {
  return (
    process.env.COLLECTION_DESCRIPTION_STYLE_BRIEF ||
    process.env.ENRICHMENT_STYLE_BRIEF ||
    'Write one or two short HTML paragraphs for a Shopify collection page. Keep it factual, warm, concise, and ecommerce-friendly. Avoid repetitive stock phrasing, filler, and made-up claims.'
  );
}

async function generateCollectionDescription(collection) {
  const styleBrief = getStyleBrief();
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      description_html: { type: 'string' },
      rationale: { type: 'string' }
    },
    required: ['description_html', 'rationale']
  };

  return requestOpenAIJson({
    model: process.env.COLLECTION_DESCRIPTION_MODEL || process.env.OPENAI_MODEL || 'gpt-5.4-mini',
    schemaName: 'collection_description',
    schema,
    systemText: [
      'You write Shopify collection descriptions.',
      'Use only the supplied collection hierarchy and sample product data.',
      'Do not invent brands, materials, dimensions, certifications, or benefits.',
      'The style_brief is the primary instruction for tone and cadence.',
      'Output valid JSON only.',
      'description_html must contain only simple HTML paragraphs using <p> tags.',
      'Keep the copy to one or two short paragraphs.'
    ].join(' '),
    inputPayload: {
      task: 'Write concise collection copy for a Shopify collection page.',
      style_brief: styleBrief,
      collection: {
        title: collection.title,
        handle: collection.handle,
        existing_description_text: collection.descriptionText,
        products_count: collection.productsCount,
        parent_collection: collection.parentCollection
          ? {
              title: collection.parentCollection.title,
              handle: collection.parentCollection.handle
            }
          : null,
        child_collections: collection.childCollections.map((child) => ({
          title: child.title,
          handle: child.handle,
          products_count: child.productsCount?.count || 0
        })),
        sample_products: collection.sampleProducts.map((product) => ({
          title: product.title,
          vendor: product.vendor,
          product_type: product.productType,
          tags: product.tags.slice(0, 8)
        }))
      }
    }
  });
}

async function updateCollectionDescription({ shop, token, collectionId, descriptionHtml }) {
  const mutation = `
    mutation CollectionUpdate($input: CollectionInput!) {
      collectionUpdate(input: $input) {
        collection {
          id
          handle
          descriptionHtml
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
    query: mutation,
    variables: {
      input: {
        id: collectionId,
        descriptionHtml
      }
    }
  });

  const errors = data.collectionUpdate.userErrors || [];
  if (errors.length > 0) {
    throw new Error(`Shopify collectionUpdate failed: ${JSON.stringify(errors)}`);
  }

  return data.collectionUpdate.collection;
}

async function main() {
  await loadEnrichmentEnv();

  const args = parseArgs(process.argv.slice(2));
  const shop = requiredEnv('SHOPIFY_SHOP_DOMAIN');
  const token = await getShopifyAdminAccessToken(shop);

  await ensureDir(args.outputDir);

  const allCollections = await fetchCollections({
    shop,
    token,
    handles: args.handles,
    limit: args.limit
  });

  const targetCollections = args.onlyMissing
    ? allCollections.filter((collection) => !collection.descriptionText)
    : allCollections;

  if (targetCollections.length === 0) {
    console.log('No collections matched the current filters.');
    return;
  }

  const results = [];

  for (const collection of targetCollections) {
    console.log(`Generating copy for ${collection.handle}...`);

    try {
      const suggestion = await generateCollectionDescription(collection);
      const nextDescriptionHtml = String(suggestion.description_html || '').trim();

      if (!nextDescriptionHtml) {
        throw new Error('OpenAI returned an empty description.');
      }

      const record = {
        id: collection.id,
        handle: collection.handle,
        title: collection.title,
        existing_description_html: collection.descriptionHtml,
        generated_description_html: nextDescriptionHtml,
        rationale: suggestion.rationale,
        wrote_to_shopify: false
      };

      if (args.write) {
        await updateCollectionDescription({
          shop,
          token,
          collectionId: collection.id,
          descriptionHtml: nextDescriptionHtml
        });
        record.wrote_to_shopify = true;
      }

      results.push(record);
    } catch (error) {
      results.push({
        id: collection.id,
        handle: collection.handle,
        title: collection.title,
        error: error.message
      });
    }
  }

  const reportPath = path.join(
    args.outputDir,
    `shopify-collection-descriptions-${timestampSlug()}.json`
  );

  await writeJsonFile(reportPath, {
    generated_at: new Date().toISOString(),
    shop,
    write: args.write,
    only_missing: args.onlyMissing,
    style_brief: getStyleBrief(),
    collection_count: targetCollections.length,
    results
  });

  console.log(`Wrote report to ${reportPath}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
