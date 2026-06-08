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
      let value = trimmed.slice(separatorIndex + 1).trim();

      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }

      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function parseArgs(argv) {
  const args = {
    write: false,
    replaceTags: false,
    limit: null,
    ids: [],
    query: 'status:active',
    outputDir: path.join(cwd, 'enrichment-output'),
    backupDir: path.join(cwd, 'enrichment-backups')
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--write') {
      args.write = true;
      continue;
    }

    if (arg === '--replace-tags') {
      args.replaceTags = true;
      continue;
    }

    if (arg === '--limit') {
      args.limit = Number(argv[index + 1] || 0) || null;
      index += 1;
      continue;
    }

    if (arg === '--ids') {
      args.ids = (argv[index + 1] || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      index += 1;
      continue;
    }

    if (arg === '--query') {
      args.query = argv[index + 1] || args.query;
      index += 1;
      continue;
    }

    if (arg === '--output-dir') {
      args.outputDir = path.resolve(cwd, argv[index + 1] || args.outputDir);
      index += 1;
      continue;
    }

    if (arg === '--backup-dir') {
      args.backupDir = path.resolve(cwd, argv[index + 1] || args.backupDir);
      index += 1;
      continue;
    }
  }

  return args;
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

function stripHtml(value) {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getStyleViolations(descriptionHtml) {
  const plainText = stripHtml(descriptionHtml || '');
  const lower = plainText.toLowerCase();
  const violations = [];

  const bannedPhrases = ['exactly what it says on the tin', 'does what it says on the tin'];
  for (const phrase of bannedPhrases) {
    if (lower.includes(phrase)) {
      violations.push(`Avoid the stock phrase "${phrase}".`);
    }
  }

  const sentences = plainText
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  const itLedSentenceCount = sentences.filter((sentence) => /^it(?:'s|\sis|\s)/i.test(sentence)).length;
  if (itLedSentenceCount > 1) {
    violations.push('Vary sentence openings. Do not start multiple sentences with "It", "It is", or "It’s".');
  }

  const repeatedLeadIns = new Map();
  for (const sentence of sentences) {
    const words = sentence
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);

    if (words.length < 2) continue;

    const leadIn = words.slice(0, 3).join(' ');
    repeatedLeadIns.set(leadIn, (repeatedLeadIns.get(leadIn) || 0) + 1);
  }

  const reusedLeadIns = Array.from(repeatedLeadIns.entries())
    .filter(([, count]) => count > 1)
    .map(([leadIn]) => `"${leadIn}"`);

  if (reusedLeadIns.length > 0) {
    violations.push(`Avoid reusing the same sentence lead-ins: ${reusedLeadIns.join(', ')}.`);
  }

  const repeatedPhrases = new Map();
  for (const sentence of sentences) {
    const words = sentence
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);

    for (let index = 0; index <= words.length - 4; index += 1) {
      const phrase = words.slice(index, index + 4).join(' ');
      repeatedPhrases.set(phrase, (repeatedPhrases.get(phrase) || 0) + 1);
    }
  }

  const reusedPhrases = Array.from(repeatedPhrases.entries())
    .filter(([, count]) => count > 1)
    .slice(0, 3)
    .map(([phrase]) => `"${phrase}"`);

  if (reusedPhrases.length > 0) {
    violations.push(`Cut repeated wording and stock phrasing: ${reusedPhrases.join(', ')}.`);
  }

  return violations;
}

function uniqueTags(tags) {
  return Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean)));
}

function toShopifyGid(id) {
  if (id.startsWith('gid://shopify/Product/')) return id;
  return `gid://shopify/Product/${id}`;
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

async function fetchProducts({ shop, token, ids, limit, query }) {
  const results = [];

  if (ids.length > 0) {
    const document = `
      query ProductsById($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            title
            handle
            vendor
            productType
            tags
            status
            descriptionHtml
            options {
              name
              values
            }
            variants(first: 50) {
              nodes {
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
    `;

    const data = await shopifyGraphQL({
      shop,
      token,
      query: document,
      variables: { ids: ids.map(toShopifyGid) }
    });

    return data.nodes.filter(Boolean);
  }

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
            options {
              name
              values
            }
            variants(first: 50) {
              nodes {
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
      results.push(edge.node);
      if (limit && results.length >= limit) {
        return results;
      }
    }

    hasNextPage = connection.pageInfo.hasNextPage;
    cursor = connection.pageInfo.endCursor;
  }

  return results;
}

async function requestEnrichment(product, styleFeedback = '') {
  const apiKey = requiredEnv('OPENAI_API_KEY');
  const model = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
  const styleBrief =
    process.env.ENRICHMENT_STYLE_BRIEF ||
    'Write concise, factual, plain-English product copy. Keep it brief, useful, and commercially usable.';
  const sourceDescription = stripHtml(product.descriptionHtml || '');
  const currentTags = Array.isArray(product.tags) ? product.tags : [];

  const payload = {
    title: product.title,
    vendor: product.vendor,
    product_type: product.productType,
    current_tags: currentTags,
    current_description: sourceDescription,
    options: product.options,
    variants: product.variants.nodes.map((variant) => ({
      title: variant.title,
      sku: variant.sku,
      barcode: variant.barcode,
      available_for_sale: variant.availableForSale,
      price: variant.price,
      selected_options: variant.selectedOptions
    }))
  };

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text:
                'You rewrite Shopify product descriptions and suggest tags. Stay strictly factual. Use only information explicitly present in the supplied product data. Do not invent materials, dimensions, performance claims, compatibility, certifications, or benefits. Follow style_brief as the primary instruction for tone, cadence, and personality. If the source data is thin, keep the copy short rather than making things up. Avoid stock phrases, repeated sentence structures, and repeated wording. Output valid JSON only.'
            }
          ]
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: JSON.stringify({
                task:
                  'Write a concise HTML description for a Shopify product and propose factual tags. Description should normally be 2 short paragraphs and, if factual feature items exist, one short bullet list. Use short, direct sentences. Vary sentence openings and structure. Avoid hype, unverifiable superlatives, filler, and repeated stock phrasing. If the source data is sparse, keep the copy brief. Tag suggestions should be factual product/category/use-case terms only and should complement the existing tags rather than replacing them.',
                style_brief: styleBrief,
                style_feedback: styleFeedback,
                product: payload
              })
            }
          ]
        }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'shopify_product_enrichment',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              description_html: { type: 'string' },
              tags: {
                type: 'array',
                items: { type: 'string' },
                maxItems: 12
              },
              notes: { type: 'string' }
            },
            required: ['description_html', 'tags', 'notes']
          }
        }
      }
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  const outputText =
    data.output_text ||
    data.output?.flatMap((item) => item.content || []).find((item) => item.type === 'output_text')?.text;

  if (!outputText) {
    throw new Error(`No model output returned for product ${product.id}`);
  }

  return JSON.parse(outputText);
}

async function enrichWithOpenAI(product) {
  let styleFeedback = '';

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const suggestion = await requestEnrichment(product, styleFeedback);
    const violations = getStyleViolations(suggestion.description_html);

    if (violations.length === 0 || attempt === 2) {
      return suggestion;
    }

    styleFeedback = [
      'Revise the description to fix these style issues:',
      ...violations,
      'Keep the tone aligned with style_brief, but make the copy more natural and less repetitive.'
    ].join(' ');
  }
}

async function updateProduct({ shop, token, productId, descriptionHtml, tags }) {
  const document = `
    mutation UpdateProduct($product: ProductUpdateInput!) {
      productUpdate(product: $product) {
        product {
          id
          title
          tags
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
        id: productId,
        descriptionHtml,
        tags
      }
    }
  });

  const errors = data.productUpdate.userErrors || [];
  if (errors.length > 0) {
    throw new Error(`Shopify productUpdate failed: ${JSON.stringify(errors)}`);
  }
}

async function writeBackup({ backupDir, product, timestamp }) {
  const productNumericId = product.id.split('/').pop();
  const productDir = path.join(backupDir, productNumericId);

  await fs.mkdir(productDir, { recursive: true });

  const backupPayload = {
    backed_up_at: timestamp,
    product_id: product.id,
    numeric_product_id: productNumericId,
    handle: product.handle,
    title: product.title,
    vendor: product.vendor,
    product_type: product.productType,
    tags: Array.isArray(product.tags) ? product.tags : [],
    description_html: product.descriptionHtml || ''
  };

  const backupPath = path.join(productDir, `${timestamp}.json`);
  await fs.writeFile(backupPath, JSON.stringify(backupPayload, null, 2));

  return backupPath;
}

async function main() {
  await loadEnvFile(path.join(cwd, '.env.enrich.local'));
  await loadEnvFile(path.join(cwd, '.env.enrich'));

  const args = parseArgs(process.argv.slice(2));
  const shop = requiredEnv('SHOPIFY_SHOP_DOMAIN');
  const shopifyToken = await getShopifyAdminAccessToken(shop);
  const markerTag = process.env.ENRICHMENT_MARKER_TAG || '';

  if (args.replaceTags) {
    console.log('--replace-tags is deprecated. Existing tags will be preserved and new tags will be added.');
  }

  await fs.mkdir(args.outputDir, { recursive: true });
  await fs.mkdir(args.backupDir, { recursive: true });

  const products = await fetchProducts({
    shop,
    token: shopifyToken,
    ids: args.ids,
    limit: args.limit,
    query: args.query
  });

  const report = [];
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  for (const product of products) {
    const currentTags = Array.isArray(product.tags) ? product.tags : [];
    const currentDescription = stripHtml(product.descriptionHtml || '');

    if (markerTag && currentTags.includes(markerTag)) {
      console.log(`Skipping ${product.title} (${product.id}) because it already has marker tag "${markerTag}"`);
      continue;
    }

    console.log(`Processing ${product.title} (${product.id})`);

    try {
      const backupPath = await writeBackup({
        backupDir: args.backupDir,
        product,
        timestamp
      });

      const suggestion = await enrichWithOpenAI(product);
      const mergedTags = uniqueTags([...currentTags, ...suggestion.tags]);
      const finalTags = markerTag ? uniqueTags([...mergedTags, markerTag]) : mergedTags;

      report.push({
        productId: product.id,
        title: product.title,
        currentTags,
        suggestedTags: suggestion.tags,
        finalTags,
        currentDescription,
        backupPath,
        suggestedDescriptionHtml: suggestion.description_html,
        notes: suggestion.notes,
        mode: args.write ? 'write' : 'dry-run'
      });

      if (args.write) {
        await updateProduct({
          shop,
          token: shopifyToken,
          productId: product.id,
          descriptionHtml: suggestion.description_html,
          tags: finalTags
        });
        console.log(`Updated ${product.title}`);
      }
    } catch (error) {
      report.push({
        productId: product.id,
        title: product.title,
        error: error.message
      });
      console.error(`Failed ${product.title}: ${error.message}`);
    }
  }

  const outputPath = path.join(args.outputDir, `shopify-enrichment-${timestamp}.json`);
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2));

  console.log(`Finished. Report written to ${outputPath}`);
  console.log(args.write ? 'Mode: write' : 'Mode: dry-run');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
