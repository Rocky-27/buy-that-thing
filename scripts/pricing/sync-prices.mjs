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

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseArgs(argv) {
  const args = {
    write: false,
    seedCostBasisOnly: false,
    syncCostBasisFromAvasam: false,
    limit: null,
    skuFile: null,
    skuList: [],
    configPath: path.join(cwd, 'scripts', 'pricing', 'pricing-config.example.json'),
    outputDir: path.join(cwd, 'pricing-output'),
    avasamPageLimit: 1000,
    shopifyVariantQuery: 'status:active'
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--write') {
      args.write = true;
      continue;
    }

    if (arg === '--seed-cost-basis-only') {
      args.seedCostBasisOnly = true;
      continue;
    }

    if (arg === '--sync-cost-basis-from-avasam') {
      args.syncCostBasisFromAvasam = true;
      continue;
    }

    if (arg === '--limit') {
      args.limit = Number(argv[index + 1] || 0) || null;
      index += 1;
      continue;
    }

    if (arg === '--sku-file') {
      args.skuFile = path.resolve(cwd, argv[index + 1] || '');
      index += 1;
      continue;
    }

    if (arg === '--skus') {
      args.skuList = (argv[index + 1] || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      index += 1;
      continue;
    }

    if (arg === '--config') {
      args.configPath = path.resolve(cwd, argv[index + 1] || args.configPath);
      index += 1;
      continue;
    }

    if (arg === '--output-dir') {
      args.outputDir = path.resolve(cwd, argv[index + 1] || args.outputDir);
      index += 1;
      continue;
    }

    if (arg === '--avasam-page-limit') {
      args.avasamPageLimit = Number(argv[index + 1] || 0) || args.avasamPageLimit;
      index += 1;
      continue;
    }

    if (arg === '--shopify-query') {
      args.shopifyVariantQuery = argv[index + 1] || args.shopifyVariantQuery;
      index += 1;
    }
  }

  return args;
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function maybeReadJson(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

function moneyToDecimal(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? amount : 0;
}

function decimalToMoney(value) {
  return Number(value.toFixed(2));
}

function moneyToMinorUnits(value) {
  return Math.round(decimalToMoney(value) * 100);
}

function roundPrice(value, roundingConfig = {}) {
  const increment = Number(roundingConfig.increment || 0.01);
  const ending = Number(roundingConfig.ending || 0);
  const mode = roundingConfig.mode || 'ceil';

  if (increment <= 0) {
    return decimalToMoney(value);
  }

  const wholePart = Math.floor(value);
  let rounded = value;

  if (ending > 0 && ending < 1) {
    if (value <= wholePart + ending) {
      rounded = wholePart + ending;
    } else {
      rounded = wholePart + 1 + ending;
    }
  } else if (mode === 'nearest') {
    rounded = Math.round(value / increment) * increment;
  } else if (mode === 'floor') {
    rounded = Math.floor(value / increment) * increment;
  } else {
    rounded = Math.ceil(value / increment) * increment;
  }

  return decimalToMoney(rounded);
}

function resolveConfigPath(basePath, relativeOrAbsolutePath) {
  if (!relativeOrAbsolutePath) return null;
  if (path.isAbsolute(relativeOrAbsolutePath)) return relativeOrAbsolutePath;
  return path.resolve(path.dirname(basePath), relativeOrAbsolutePath);
}

function valuesDiffer(left, right, epsilon = 0.0001) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return left !== right;
  }

  return Math.abs(left - right) > epsilon;
}

function normalizeSku(value) {
  return String(value || '').trim();
}

async function loadSkuFilter(args) {
  const values = new Set(args.skuList.map(normalizeSku).filter(Boolean));

  if (args.skuFile) {
    const raw = await fs.readFile(args.skuFile, 'utf8');
    for (const line of raw.split('\n')) {
      const sku = normalizeSku(line);
      if (sku) values.add(sku);
    }
  }

  return values;
}

function pickRule(rules, landedCost) {
  for (const rule of rules) {
    const minCost = Number(rule.minCost ?? Number.NEGATIVE_INFINITY);
    const maxCost = Number(rule.maxCost ?? Number.POSITIVE_INFINITY);
    if (landedCost >= minCost && landedCost < maxCost) {
      return rule;
    }
  }

  throw new Error(`No pricing rule matched landed cost ${landedCost}`);
}

function computeBaseTarget({ landedCost, rule }) {
  const markupPercent = Number(rule.markupPercent || 0);
  const markupFixed = Number(rule.markupFixed || 0);
  const minMarginFixed = Number(rule.minMarginFixed || 0);
  const minMarginPercent = Number(rule.minMarginPercent || 0);

  const ruleTarget = landedCost * (1 + markupPercent) + markupFixed;
  const floorTarget = landedCost + minMarginFixed + landedCost * minMarginPercent;

  return Math.max(ruleTarget, floorTarget);
}

function computeFloorPrice({ landedCost, rule, feeConfig }) {
  const percentageFee = Number(feeConfig.percentage || 0);
  const fixedFee = Number(feeConfig.fixed || 0);
  const targetNet = landedCost + Number(rule.minMarginFixed || 0) + landedCost * Number(rule.minMarginPercent || 0);
  const denominator = 1 - percentageFee;

  if (denominator <= 0) {
    throw new Error('Fee percentage must be less than 100%.');
  }

  return (targetNet + fixedFee) / denominator;
}

function computeTargetPrice({ landedCost, shippingCost = 0, config, competitorEntry }) {
  const rule = pickRule(config.rules, landedCost);
  const feeConfig = config.fees || {};
  const percentageFee = Number(feeConfig.percentage || 0);
  const fixedFee = Number(feeConfig.fixed || 0);
  const targetNet = computeBaseTarget({ landedCost, rule });
  const denominator = 1 - percentageFee;

  if (denominator <= 0) {
    throw new Error('Fee percentage must be less than 100%.');
  }

  let candidate = (targetNet + fixedFee) / denominator;
  const pricingStrategy = config.competitorPricing || {};

  if (pricingStrategy.enabled && competitorEntry && Number.isFinite(Number(competitorEntry.price))) {
    const undercutPercent = Number(pricingStrategy.undercutPercent || 0);
    const competitorCap = Number(competitorEntry.price) * (1 - undercutPercent);
    const floorPrice = computeFloorPrice({ landedCost, rule, feeConfig });
    candidate = Math.max(Math.min(candidate, competitorCap), floorPrice);
  }

  const rounded = roundPrice(candidate, config.rounding);

  return {
    ruleName: rule.name,
    shippingCost,
    landedCost: decimalToMoney(landedCost),
    feePercent: percentageFee,
    feeFixed: fixedFee,
    targetPrice: rounded,
    competitorPrice: competitorEntry ? Number(competitorEntry.price) : null
  };
}

async function requestAvasamToken() {
  const response = await fetch(`${requiredEnv('AVASAM_AUTH_URL')}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      consumer_key: requiredEnv('AVASAM_CONSUMER_KEY'),
      secret_key: requiredEnv('AVASAM_SECRET_KEY')
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Avasam token request failed (${response.status}): ${body}`);
  }

  const payload = await response.json();
  if (!payload.access_token) {
    throw new Error(`Avasam token response did not include access_token: ${JSON.stringify(payload)}`);
  }

  return payload.access_token;
}

async function avasamRequest({ token, endpointPath, body }) {
  const baseUrl = requiredEnv('AVASAM_API_BASE_URL').replace(/\/+$/, '');
  const authHeader = process.env.AVASAM_AUTH_HEADER || 'Authkey';
  const response = await fetch(`${baseUrl}/${endpointPath.replace(/^\/+/, '')}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      [authHeader]: token
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`Avasam request failed (${response.status}) for ${endpointPath}: ${responseBody}`);
  }

  return response.json();
}

async function fetchAvasamInventory({ token, args, skuFilter }) {
  const items = [];
  let page = 0;
  let total = null;

  while (true) {
    const payload = await avasamRequest({
      token,
      endpointPath: process.env.AVASAM_INVENTORY_ENDPOINT || 'ProductModule/GetInventoryListWithFilter',
      body: {
        ProductType: [],
        Supplier: '',
        Sortby: 'SKU',
        SortStatus: 'down',
        limit: args.avasamPageLimit,
        PriceDelimeter: '0',
        PriceValue: 0,
        StockValue: '0',
        Stock: 0,
        Variation: 'true',
        Showchild: 'true',
        Category: '',
        CategoryName: '',
        IsMapped: '',
        PriceMaxValue: 0,
        PriceMaxDelimeter: '0',
        page
      }
    });

    const batch = Array.isArray(payload.data) ? payload.data : [];
    total = Number(payload.total || batch.length);

    for (const entry of batch) {
      const sku = normalizeSku(entry.SKU || entry.Number);
      if (!sku) continue;
      if (skuFilter.size > 0 && !skuFilter.has(sku)) continue;

      items.push({
        sku,
        avasamId: entry._id || null,
        costPrice: moneyToDecimal(entry.Price),
        retailPrice: moneyToDecimal(entry.RetailPrice),
        stock: Number(entry.Stock || 0),
        title: entry.Title || '',
        vatPercentage: Number(entry.VATPercentage ?? entry.Vat ?? 0),
        listingStatus: entry.ListingStatus || '',
        isMapped: Boolean(entry.isMapped)
      });
    }

    if (batch.length === 0 || items.length >= total || batch.length < args.avasamPageLimit) {
      break;
    }

    if (args.limit && items.length >= args.limit) {
      break;
    }

    page += 1;
  }

  return args.limit ? items.slice(0, args.limit) : items;
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

async function fetchShopifyVariants({ shop, token, queryString, metafieldConfig = {} }) {
  const document = `
    query FetchVariants($cursor: String, $query: String!, $metafieldNamespace: String!, $metafieldKey: String!) {
      productVariants(first: 250, after: $cursor, query: $query) {
        nodes {
          id
          sku
          price
          compareAtPrice
          title
          costBasisMetafield: metafield(namespace: $metafieldNamespace, key: $metafieldKey) {
            id
            namespace
            key
            value
          }
          product {
            id
            title
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  const variants = [];
  let cursor = null;

  while (true) {
    const data = await shopifyGraphQL({
      shop,
      token,
      query: document,
      variables: {
        cursor,
        query: queryString,
        metafieldNamespace: metafieldConfig.namespace || 'custom',
        metafieldKey: metafieldConfig.key || 'base_landed_cost'
      }
    });

    const connection = data.productVariants;
    variants.push(...connection.nodes);

    if (!connection.pageInfo.hasNextPage) {
      break;
    }

    cursor = connection.pageInfo.endCursor;
  }

  return variants;
}

function loadSkuKeyedMap(entries, keyName = 'sku') {
  const map = new Map();
  for (const entry of entries || []) {
    const sku = normalizeSku(entry[keyName]);
    if (!sku) continue;
    map.set(sku, entry);
  }
  return map;
}

function buildSeedPlan({ shopifyVariants, config }) {
  const matches = [];

  for (const shopifyVariant of shopifyVariants) {
    const currentPrice = moneyToDecimal(shopifyVariant.price);
    const costBasis = resolveCostBasis({
      shopifyVariant,
      currentPrice,
      avasamLandedCost: currentPrice,
      config,
      args: { syncCostBasisFromAvasam: false }
    });

    matches.push({
      sku: normalizeSku(shopifyVariant.sku),
      shopifyVariantId: shopifyVariant.id,
      shopifyProductId: shopifyVariant.product.id,
      shopifyProductTitle: shopifyVariant.product.title,
      currentShopifyPrice: decimalToMoney(currentPrice),
      changed: false,
      newShopifyPrice: decimalToMoney(currentPrice),
      calculation: null,
      costBasisSource: costBasis.source,
      existingCostBasisMetafield: Number.isFinite(Number(shopifyVariant.costBasisMetafield?.value))
        ? decimalToMoney(Number(shopifyVariant.costBasisMetafield.value))
        : null,
      costBasisMetafieldUpdate:
        costBasis.metafieldUpdate &&
        (valuesDiffer(Number(shopifyVariant.costBasisMetafield?.value), costBasis.metafieldUpdate.value) ||
          !shopifyVariant.costBasisMetafield)
          ? costBasis.metafieldUpdate
          : null,
      avasamLandedCost: null
    });
  }

  return {
    matches,
    missingInShopify: []
  };
}

function resolveCostBasis({
  shopifyVariant,
  currentPrice,
  avasamLandedCost,
  config,
  args
}) {
  const metafieldConfig = config.costBasisMetafield || {};
  const bootstrapConfig = metafieldConfig.bootstrap || {};
  const existingMetafieldValue = Number(shopifyVariant.costBasisMetafield?.value);
  const hasStoredCostBasis = Number.isFinite(existingMetafieldValue) && existingMetafieldValue >= 0;

  if (args.syncCostBasisFromAvasam) {
    return {
      landedCost: decimalToMoney(avasamLandedCost),
      source: 'avasam-sync',
      metafieldUpdate: {
        value: decimalToMoney(avasamLandedCost),
        reason: hasStoredCostBasis ? 'refreshed-from-avasam' : 'seeded-from-avasam'
      }
    };
  }

  if (hasStoredCostBasis) {
    return {
      landedCost: decimalToMoney(existingMetafieldValue),
      source: 'metafield',
      metafieldUpdate: null
    };
  }

  if (metafieldConfig.enabled === false) {
    return {
      landedCost: decimalToMoney(avasamLandedCost),
      source: 'avasam',
      metafieldUpdate: null
    };
  }

  const bootstrapDivisor = Number(bootstrapConfig.divisor || 0);
  if (bootstrapConfig.enabled && bootstrapDivisor > 0) {
    const bootstrappedLandedCost = currentPrice / bootstrapDivisor;
    return {
      landedCost: decimalToMoney(bootstrappedLandedCost),
      source: 'bootstrap-current-price',
      metafieldUpdate: {
        value: decimalToMoney(bootstrappedLandedCost),
        reason: 'seeded-from-current-shopify-price'
      }
    };
  }

  return {
    landedCost: decimalToMoney(avasamLandedCost),
    source: 'avasam',
    metafieldUpdate: {
      value: decimalToMoney(avasamLandedCost),
      reason: 'seeded-from-avasam'
    }
  };
}

function buildMetafieldUpdate({ row, config }) {
  const metafieldConfig = config.costBasisMetafield || {};
  if (metafieldConfig.enabled === false || !row.costBasisMetafieldUpdate) return null;

  return {
    ownerId: row.shopifyVariantId,
    namespace: metafieldConfig.namespace || 'custom',
    key: metafieldConfig.key || 'base_landed_cost',
    type: metafieldConfig.type || 'number_decimal',
    value: row.costBasisMetafieldUpdate.value.toFixed(2)
  };
}

function buildShopifyOnlyUpdatePlan({ shopifyVariants, competitorMap, config }) {
  const matches = [];
  const missingCostBasis = [];

  for (const shopifyVariant of shopifyVariants) {
    const sku = normalizeSku(shopifyVariant.sku);
    const currentPrice = moneyToDecimal(shopifyVariant.price);
    const storedCostBasis = Number(shopifyVariant.costBasisMetafield?.value);

    if (!Number.isFinite(storedCostBasis) || storedCostBasis < 0) {
      missingCostBasis.push({
        sku,
        shopifyVariantId: shopifyVariant.id,
        shopifyProductId: shopifyVariant.product.id,
        shopifyProductTitle: shopifyVariant.product.title
      });
      continue;
    }

    const competitorEntry = competitorMap.get(sku) || null;
    const calculation = computeTargetPrice({
      landedCost: decimalToMoney(storedCostBasis),
      config,
      competitorEntry
    });
    const changed = decimalToMoney(currentPrice) !== decimalToMoney(calculation.targetPrice);

    matches.push({
      sku,
      shopifyVariantId: shopifyVariant.id,
      shopifyProductId: shopifyVariant.product.id,
      shopifyProductTitle: shopifyVariant.product.title,
      avasamTitle: null,
      currentShopifyPrice: decimalToMoney(currentPrice),
      newShopifyPrice: calculation.targetPrice,
      changed,
      calculation,
      costBasisSource: 'metafield',
      existingCostBasisMetafield: decimalToMoney(storedCostBasis),
      costBasisMetafieldUpdate: null,
      avasamLandedCost: null
    });
  }

  return {
    matches,
    missingInShopify: [],
    missingCostBasis
  };
}

function buildUpdatePlan({ avasamProducts, shopifyVariantMap, shippingMap, competitorMap, config, args }) {
  const matches = [];
  const missingInShopify = [];

  for (const product of avasamProducts) {
    const shopifyVariant = shopifyVariantMap.get(product.sku);
    if (!shopifyVariant) {
      missingInShopify.push(product);
      continue;
    }

    const shippingEntry = shippingMap.get(product.sku);
    const shippingCost = Number(shippingEntry?.shippingCost ?? config.shipping?.fallbackCost ?? 0);
    const competitorEntry = competitorMap.get(product.sku) || null;
    const currentPrice = moneyToDecimal(shopifyVariant.price);
    const avasamLandedCost = product.costPrice + shippingCost;
    const costBasis = resolveCostBasis({
      shopifyVariant,
      currentPrice,
      avasamLandedCost,
      config,
      args
    });
    const calculation = computeTargetPrice({
      landedCost: costBasis.landedCost,
      config,
      competitorEntry
    });
    const changed = decimalToMoney(currentPrice) !== decimalToMoney(calculation.targetPrice);

    matches.push({
      sku: product.sku,
      shopifyVariantId: shopifyVariant.id,
      shopifyProductId: shopifyVariant.product.id,
      shopifyProductTitle: shopifyVariant.product.title,
      avasamTitle: product.title,
      currentShopifyPrice: decimalToMoney(currentPrice),
      newShopifyPrice: calculation.targetPrice,
      changed,
      calculation,
      costBasisSource: costBasis.source,
      existingCostBasisMetafield: Number.isFinite(Number(shopifyVariant.costBasisMetafield?.value))
        ? decimalToMoney(Number(shopifyVariant.costBasisMetafield.value))
        : null,
      costBasisMetafieldUpdate:
        costBasis.metafieldUpdate &&
        (valuesDiffer(Number(shopifyVariant.costBasisMetafield?.value), costBasis.metafieldUpdate.value) ||
          !shopifyVariant.costBasisMetafield)
          ? costBasis.metafieldUpdate
          : null,
      avasamLandedCost: decimalToMoney(avasamLandedCost)
    });
  }

  return {
    matches,
    missingInShopify,
    missingCostBasis: []
  };
}

function groupUpdatesByProduct(matchRows) {
  const groups = new Map();

  for (const row of matchRows) {
    if (!row.changed) continue;
    const group = groups.get(row.shopifyProductId) || [];
    group.push(row);
    groups.set(row.shopifyProductId, group);
  }

  return groups;
}

async function applyShopifyUpdates({ shop, token, groupedUpdates }) {
  const document = `
    mutation BulkUpdateVariantPrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: true) {
        product {
          id
        }
        productVariants {
          id
          price
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const results = [];

  for (const [productId, rows] of groupedUpdates.entries()) {
    const variables = {
      productId,
      variants: rows.map((row) => ({
        id: row.shopifyVariantId,
        price: row.newShopifyPrice.toFixed(2)
      }))
    };

    const data = await shopifyGraphQL({
      shop,
      token,
      query: document,
      variables
    });

    results.push({
      productId,
      rows: rows.length,
      userErrors: data.productVariantsBulkUpdate.userErrors || []
    });
  }

  return results;
}

async function setShopifyMetafields({ shop, token, metafields }) {
  if (metafields.length === 0) return [];

  const document = `
    mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
          key
          namespace
          value
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const results = [];

  for (let index = 0; index < metafields.length; index += 25) {
    const batch = metafields.slice(index, index + 25);
    const data = await shopifyGraphQL({
      shop,
      token,
      query: document,
      variables: { metafields: batch }
    });

    results.push({
      count: batch.length,
      userErrors: data.metafieldsSet.userErrors || []
    });
  }

  return results;
}

async function main() {
  await loadEnvFile(path.join(cwd, '.env.enrich.local'));
  await loadEnvFile(path.join(cwd, '.env.enrich'));

  const args = parseArgs(process.argv.slice(2));
  const config = await readJson(args.configPath);
  const skuFilter = await loadSkuFilter(args);

  if (!Array.isArray(config.rules) || config.rules.length === 0) {
    throw new Error('Pricing config must include at least one rule.');
  }

  const shippingData = await maybeReadJson(resolveConfigPath(args.configPath, config.shipping?.file));
  const competitorData = await maybeReadJson(resolveConfigPath(args.configPath, config.competitorPricing?.file));
  const shippingMap = loadSkuKeyedMap(shippingData, 'sku');
  const competitorMap = loadSkuKeyedMap(competitorData, 'sku');

  const shop = requiredEnv('SHOPIFY_SHOP_DOMAIN');
  const shopifyToken = await getShopifyAdminAccessToken(shop);
  const shopifyVariants = await fetchShopifyVariants({
    shop,
    token: shopifyToken,
    queryString: args.shopifyVariantQuery,
    metafieldConfig: config.costBasisMetafield
  });
  const shopifyVariantMap = new Map(
    shopifyVariants
      .map((variant) => [normalizeSku(variant.sku), variant])
      .filter(([sku]) => sku)
  );

  let avasamProducts = [];
  let plan;

  if (args.seedCostBasisOnly) {
    plan = buildSeedPlan({
      shopifyVariants: shopifyVariants.filter((variant) => skuFilter.size === 0 || skuFilter.has(normalizeSku(variant.sku))),
      config
    });
  } else if (!args.syncCostBasisFromAvasam) {
    plan = buildShopifyOnlyUpdatePlan({
      shopifyVariants: shopifyVariants.filter((variant) => skuFilter.size === 0 || skuFilter.has(normalizeSku(variant.sku))),
      competitorMap,
      config
    });
  } else {
    const avasamToken = await requestAvasamToken();
    avasamProducts = await fetchAvasamInventory({
      token: avasamToken,
      args,
      skuFilter
    });

    plan = buildUpdatePlan({
      avasamProducts,
      shopifyVariantMap,
      shippingMap,
      competitorMap,
      config,
      args
    });
  }

  const changedRows = plan.matches.filter((row) => row.changed);
  const metafieldRows = plan.matches.filter((row) => row.costBasisMetafieldUpdate);
  const metafieldUpdates = metafieldRows
    .map((row) => buildMetafieldUpdate({ row, config }))
    .filter(Boolean);
  const groupedUpdates = groupUpdatesByProduct(plan.matches);

  await ensureDir(args.outputDir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(args.outputDir, `pricing-sync-${timestamp}.json`);

  const report = {
    generatedAt: new Date().toISOString(),
    configPath: args.configPath,
    writeMode: args.write,
    summary: {
      avasamProductsRead: avasamProducts.length,
      matchedToShopify: plan.matches.length,
      missingInShopify: plan.missingInShopify.length,
      missingCostBasis: plan.missingCostBasis.length,
      priceChangesPlanned: changedRows.length,
      costBasisMetafieldChangesPlanned: metafieldUpdates.length,
      shopifyProductsToTouch: groupedUpdates.size
    },
    missingInShopify: plan.missingInShopify.map((item) => ({
      sku: item.sku,
      title: item.title
    })),
    missingCostBasis: (plan.missingCostBasis || []).map((item) => ({
      sku: item.sku,
      shopifyProductTitle: item.shopifyProductTitle
    })),
    updates: plan.matches
  };

  if (args.write && groupedUpdates.size > 0) {
    report.shopifyUpdateResults = await applyShopifyUpdates({
      shop,
      token: shopifyToken,
      groupedUpdates
    });
  }

  if (args.write && metafieldUpdates.length > 0) {
    report.shopifyMetafieldResults = await setShopifyMetafields({
      shop,
      token: shopifyToken,
      metafields: metafieldUpdates
    });
  }

  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(`Avasam products read: ${avasamProducts.length}`);
  console.log(`Matched to Shopify SKUs: ${plan.matches.length}`);
  console.log(`Missing in Shopify: ${plan.missingInShopify.length}`);
  console.log(`Missing cost basis: ${plan.missingCostBasis.length}`);
  console.log(`Planned price changes: ${changedRows.length}`);
  console.log(`Planned cost-basis metafield changes: ${metafieldUpdates.length}`);
  console.log(`Report: ${reportPath}`);

  if (!args.write) {
    console.log(
      args.seedCostBasisOnly
        ? 'Dry-run only. Re-run with --write to seed Shopify cost-basis metafields.'
        : 'Dry-run only. Re-run with --write to push Shopify price updates.'
    );
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
