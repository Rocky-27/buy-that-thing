#!/usr/bin/env node

import path from 'node:path';
import {
  buildManagedTag,
  cwd,
  defaultManagedTagPrefix,
  loadEnrichmentEnv,
  readJsonFile,
  requestOpenAIJson,
  slugify,
  stripHtml,
  timestampSlug,
  topEntriesFromMap,
  writeJsonFile
} from './lib/shopify-taxonomy-utils.mjs';

const DEFAULT_CACHE_FILE = path.join(cwd, 'catalog-cache', 'shopify-catalog-cache.json');
const DEFAULT_PLAN_FILENAME = 'shopify-collection-taxonomy-plan.json';
const VALID_SORT_ORDERS = new Set([
  'ALPHA_ASC',
  'ALPHA_DESC',
  'BEST_SELLING',
  'CREATED',
  'CREATED_DESC',
  'MANUAL',
  'PRICE_ASC',
  'PRICE_DESC'
]);

const TITLE_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'at',
  'by',
  'for',
  'from',
  'in',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
  'set',
  'pack',
  'cm',
  'mm'
]);

function parseArgs(argv) {
  const args = {
    cacheFile: DEFAULT_CACHE_FILE,
    engine: process.env.COLLECTION_TAXONOMY_ENGINE || 'openai',
    outputDir: path.join(cwd, 'taxonomy-plans'),
    planFile: path.join(cwd, 'taxonomy-plans', DEFAULT_PLAN_FILENAME),
    maxCollections: Number(process.env.COLLECTION_TAXONOMY_MAX_COLLECTIONS || 72),
    minCollections: Number(process.env.COLLECTION_TAXONOMY_MIN_COLLECTIONS || 40),
    samplePerType: 12
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--cache-file') {
      args.cacheFile = path.resolve(cwd, argv[index + 1] || '');
      index += 1;
      continue;
    }

    if (arg === '--engine') {
      args.engine = argv[index + 1] || args.engine;
      index += 1;
      continue;
    }

    if (arg === '--output-dir') {
      args.outputDir = path.resolve(cwd, argv[index + 1] || args.outputDir);
      args.planFile = path.join(args.outputDir, DEFAULT_PLAN_FILENAME);
      index += 1;
      continue;
    }

    if (arg === '--plan-file') {
      args.planFile = path.resolve(cwd, argv[index + 1] || args.planFile);
      args.outputDir = path.dirname(args.planFile);
      index += 1;
      continue;
    }

    if (arg === '--max-collections') {
      args.maxCollections = Number(argv[index + 1] || args.maxCollections) || args.maxCollections;
      index += 1;
      continue;
    }

    if (arg === '--min-collections') {
      args.minCollections = Number(argv[index + 1] || args.minCollections) || args.minCollections;
      index += 1;
      continue;
    }

    if (arg === '--sample-per-type') {
      args.samplePerType = Number(argv[index + 1] || args.samplePerType) || args.samplePerType;
      index += 1;
      continue;
    }
  }

  return args;
}

function normalizeSortOrder(value) {
  const normalized = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');

  return VALID_SORT_ORDERS.has(normalized) ? normalized : 'BEST_SELLING';
}

function tokenizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !TITLE_STOP_WORDS.has(token) && !/^\d+$/.test(token));
}

function buildTopTitlePhrases(products, limit = 12) {
  const phraseMap = new Map();

  for (const product of products || []) {
    const tokens = tokenizeTitle(product.title);
    const phrasesForProduct = new Set();

    for (let index = 0; index < tokens.length; index += 1) {
      const unigram = tokens[index];
      if (unigram) phrasesForProduct.add(unigram);

      const bigram = tokens[index + 1] ? `${tokens[index]} ${tokens[index + 1]}` : null;
      if (bigram) phrasesForProduct.add(bigram);
    }

    for (const phrase of phrasesForProduct) {
      phraseMap.set(phrase, (phraseMap.get(phrase) || 0) + 1);
    }
  }

  return Array.from(phraseMap.entries())
    .filter(([, count]) => count >= 2)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([phrase, count]) => ({ phrase, count }));
}

function buildCatalogSummary(catalog, samplePerType) {
  const productTypeMap = new Map();
  const tagMap = new Map();
  const vendorMap = new Map();
  const byProductType = new Map();

  for (const product of catalog.products || []) {
    const productType = product.productType || 'Unspecified';
    productTypeMap.set(productType, (productTypeMap.get(productType) || 0) + 1);
    vendorMap.set(product.vendor || 'Unknown', (vendorMap.get(product.vendor || 'Unknown') || 0) + 1);

    for (const tag of product.tags || []) {
      tagMap.set(tag, (tagMap.get(tag) || 0) + 1);
    }

    if (!byProductType.has(productType)) {
      byProductType.set(productType, []);
    }
    byProductType.get(productType).push(product);
  }

  const productTypes = topEntriesFromMap(productTypeMap, 80).map(({ value, count }) => {
    const productsForType = byProductType.get(value) || [];
    const sampleProducts = productsForType.slice(0, samplePerType).map((product) => ({
      id: product.id,
      title: product.title,
      vendor: product.vendor,
      product_type: product.productType,
      tags: product.tags,
      description: stripHtml(product.descriptionHtml).slice(0, 180)
    }));

    return {
      product_type: value,
      count,
      title_phrases: buildTopTitlePhrases(productsForType, 12),
      sample_products: sampleProducts
    };
  });

  const existingCollections = (catalog.collections || []).map((collection) => ({
    handle: collection.handle,
    title: collection.title,
    parent_handle: collection.parentCollection?.handle || null,
    child_handles: (collection.childCollections || []).map((child) => child.handle),
    is_smart: Boolean(collection.ruleSet && collection.ruleSet.rules && collection.ruleSet.rules.length > 0)
  }));

  return {
    shop: catalog.shop,
    product_count: catalog.product_count,
    collection_count: catalog.collection_count,
    top_product_types: productTypes,
    top_tags: topEntriesFromMap(tagMap, 120),
    top_vendors: topEntriesFromMap(vendorMap, 40),
    existing_collections: existingCollections
  };
}

function normalizePlan(rawPlan, prefix) {
  const collections = Array.isArray(rawPlan.collections) ? rawPlan.collections : [];

  return {
    summary: rawPlan.summary || '',
    collections: collections.map((collection) => {
      const baseHandle = slugify(collection.handle || collection.title);
      return {
        handle: baseHandle,
        title: collection.title || collection.handle,
        description_html: collection.description_html || '',
        parent_handle: collection.parent_handle ? slugify(collection.parent_handle) : null,
        managed_tag: collection.managed_tag || buildManagedTag(prefix, baseHandle),
        sort_order: normalizeSortOrder(collection.sort_order),
        rationale: collection.rationale || '',
        match_groups: Array.isArray(collection.match_groups) ? collection.match_groups : []
      };
    })
  };
}

function buildHeuristicPlan(catalog, prefix, maxCollections) {
  const summary = buildCatalogSummary(catalog, 3);
  const collections = summary.top_product_types
    .filter((entry) => entry.count >= 2 && entry.product_type !== 'Unspecified')
    .slice(0, maxCollections)
    .map((entry) => {
      const handle = slugify(entry.product_type);
      return {
        handle,
        title: entry.product_type,
        description_html: `<p>${entry.product_type} picks from the current catalog.</p>`,
        parent_handle: null,
        managed_tag: buildManagedTag(prefix, handle),
        sort_order: 'BEST_SELLING',
        rationale: 'Heuristic fallback based on product type frequency.',
        match_groups: [
          [
            {
              field: 'product_type',
              operator: 'equals',
              value: entry.product_type
            }
          ]
        ]
      };
    });

  return {
    summary: 'Heuristic taxonomy plan generated from product types.',
    collections
  };
}

async function buildOpenAIPlan(catalog, prefix, args) {
  const minCollections = Math.min(args.minCollections, args.maxCollections);
  const summary = buildCatalogSummary(catalog, args.samplePerType);
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string' },
      collections: {
        type: 'array',
        minItems: minCollections,
        maxItems: args.maxCollections,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            handle: { type: 'string' },
            title: { type: 'string' },
            description_html: { type: 'string' },
            parent_handle: { type: ['string', 'null'] },
            managed_tag: { type: 'string' },
            sort_order: {
              type: 'string',
              enum: Array.from(VALID_SORT_ORDERS)
            },
            rationale: { type: 'string' },
            match_groups: {
              type: 'array',
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    field: {
                      type: 'string',
                      enum: ['title', 'vendor', 'product_type', 'existing_tags']
                    },
                    operator: {
                      type: 'string',
                      enum: ['equals', 'contains', 'contains_any']
                    },
                    value: { type: 'string' },
                    values: {
                      type: 'array',
                      items: { type: 'string' }
                    }
                  },
                  required: ['field', 'operator', 'value', 'values']
                }
              }
            }
          },
          required: [
            'handle',
            'title',
            'description_html',
            'parent_handle',
            'managed_tag',
            'sort_order',
            'rationale',
            'match_groups'
          ]
        }
      }
    },
    required: ['summary', 'collections']
  };

  const systemText = [
    'You design Shopify smart collection taxonomies for a real store.',
    'Use the catalog summary to propose a practical collection hierarchy.',
    'Every proposed collection must be implemented as a smart collection driven by one managed product tag.',
    `Managed tags should use the prefix "${prefix}".`,
    `Target between ${minCollections} and ${args.maxCollections} collections unless the catalog genuinely cannot support that many specific buckets.`,
    'Prefer a more granular taxonomy with commercially useful child collections where the catalog clearly supports them.',
    'Use the title phrase signals and sample products to split broad parent collections into narrower, specific child collections.',
    'For a catalog of this size, broad umbrellas alone are not enough. Break major branches into clear product-form, function, and use-case subcategories.',
    'Prefer rules that are specific enough to avoid noisy over-tagging.',
    'Do not rely on existing taxonomy tags as the primary signal if they appear noisy or overly broad.',
    'A product can match more than one collection.',
    'A product should match multiple collections only when the fit is explicit and high confidence, not speculative.',
    'Use parent_handle to express hierarchy depth.',
    'Do not propose nested URLs. Only propose collections, hierarchy, and local matching rules.',
    'Keep the plan commercially sensible and avoid tiny or redundant collections unless clearly useful.',
    'Prefer 2 to 4 levels and favor specific functional or product-form subcategories over generic room-based buckets.',
    'If a parent category contains enough distinct product forms, create child collections for those forms rather than stopping at the parent.',
    `sort_order must be one of: ${Array.from(VALID_SORT_ORDERS).join(', ')}.`
  ].join(' ');

  const inputPayload = {
    task: 'Create a smart-collection taxonomy plan for Shopify.',
    constraints: {
      min_collections: minCollections,
      max_collections: args.maxCollections,
      managed_tag_prefix: prefix,
      available_condition_fields: ['title', 'vendor', 'product_type', 'existing_tags'],
      available_condition_operators: ['equals', 'contains', 'contains_any'],
      smart_collection_strategy:
        'Each collection will become a smart collection with a single Shopify rule: product tag equals managed_tag.'
    },
    catalog_summary: summary
  };

  const plan = await requestOpenAIJson({
    model: process.env.OPENAI_MODEL || 'gpt-5.4-mini',
    schemaName: 'shopify_collection_taxonomy_plan',
    schema,
    systemText,
    inputPayload
  });

  return normalizePlan(plan, prefix);
}

async function main() {
  await loadEnrichmentEnv();
  const args = parseArgs(process.argv.slice(2));
  const catalog = await readJsonFile(args.cacheFile);
  const prefix = defaultManagedTagPrefix();

  const plan =
    args.engine === 'heuristic'
      ? buildHeuristicPlan(catalog, prefix, args.maxCollections)
      : await buildOpenAIPlan(catalog, prefix, args);

  const payload = {
    generated_at: new Date().toISOString(),
    engine: args.engine,
    source_cache_file: args.cacheFile,
    managed_tag_prefix: prefix,
    summary: plan.summary,
    collections: plan.collections
  };

  await writeJsonFile(args.planFile, payload);
  console.log(`Wrote taxonomy plan to ${args.planFile}`);
  console.log(`Collections proposed: ${plan.collections.length}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
