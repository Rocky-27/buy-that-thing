import fs from 'node:fs/promises';
import path from 'node:path';

export const cwd = process.cwd();

export async function loadEnvFile(filePath) {
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

export async function loadEnrichmentEnv() {
  await loadEnvFile(path.join(cwd, '.env.enrich.local'));
  await loadEnvFile(path.join(cwd, '.env.enrich'));
}

export function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export async function getShopifyAdminAccessToken(shop) {
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

export async function sleep(ms) {
  if (!ms || ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryAfterDelayMs(response) {
  const retryAfter = Number(response.headers.get('retry-after') || 0);
  return Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
}

function isThrottleError(payload) {
  return Array.isArray(payload?.errors) && payload.errors.some((error) => String(error.message || '').includes('THROTTLED'));
}

function computeBackoffDelayMs(attempt, response, payload) {
  const retryAfterDelayMs = response ? getRetryAfterDelayMs(response) : 0;
  if (retryAfterDelayMs > 0) return retryAfterDelayMs;

  const throttleStatus = payload?.extensions?.cost?.throttleStatus || null;
  const currentlyAvailable = Number(throttleStatus?.currentlyAvailable ?? 0);
  const restoreRate = Number(throttleStatus?.restoreRate ?? 50);

  if (currentlyAvailable <= 0 && restoreRate > 0) {
    return Math.max(1000, Math.ceil(1000 / restoreRate) * 10);
  }

  const baseDelayMs = Number(process.env.SHOPIFY_GRAPHQL_RETRY_BASE_DELAY_MS || 1500) || 1500;
  return baseDelayMs * Math.max(1, attempt);
}

export async function shopifyGraphQL({ shop, token, query, variables = {} }) {
  const apiVersion = process.env.SHOPIFY_API_VERSION || '2025-10';
  const maxAttempts = Number(process.env.SHOPIFY_GRAPHQL_RETRY_MAX_ATTEMPTS || 6) || 6;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({ query, variables })
    });

    if (response.status === 429) {
      if (attempt === maxAttempts) {
        const body = await response.text();
        throw new Error(`Shopify request failed (${response.status}): ${body}`);
      }

      await sleep(computeBackoffDelayMs(attempt, response, null));
      continue;
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Shopify request failed (${response.status}): ${body}`);
    }

    const payload = await response.json();
    if (isThrottleError(payload)) {
      if (attempt === maxAttempts) {
        throw new Error(`Shopify GraphQL throttled after ${maxAttempts} attempts: ${JSON.stringify(payload.errors)}`);
      }

      await sleep(computeBackoffDelayMs(attempt, response, payload));
      continue;
    }

    if (payload.errors) {
      throw new Error(`Shopify GraphQL error: ${JSON.stringify(payload.errors)}`);
    }

    return payload.data;
  }

  throw new Error('Shopify GraphQL request failed after retries.');
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function writeJsonFile(filePath, payload) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2));
}

export async function readJsonFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

export function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function uniqueTags(tags) {
  return Array.from(new Set((tags || []).map((tag) => String(tag).trim()).filter(Boolean)));
}

export function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function stripHtml(value) {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function defaultManagedTagPrefix() {
  return process.env.COLLECTION_MANAGED_TAG_PREFIX || 'taxonomy:';
}

export function buildManagedTag(prefix, handle) {
  const normalizedPrefix = prefix.endsWith(':') || prefix.endsWith('/') ? prefix : `${prefix}:`;
  return `${normalizedPrefix}${handle}`;
}

export function isManagedTaxonomyTag(tag, prefix = defaultManagedTagPrefix()) {
  return typeof tag === 'string' && tag.startsWith(prefix);
}

export function splitTagsByManagedPrefix(tags, prefix = defaultManagedTagPrefix()) {
  const managed = [];
  const unmanaged = [];

  for (const tag of Array.isArray(tags) ? tags : []) {
    if (isManagedTaxonomyTag(tag, prefix)) {
      managed.push(tag);
    } else {
      unmanaged.push(tag);
    }
  }

  return { managed, unmanaged };
}

export function topEntriesFromMap(map, limit = 20) {
  return Array.from(map.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

export function evaluateCondition(product, condition) {
  const field = condition?.field;
  const operator = condition?.operator;

  const sourceValue =
    field === 'title'
      ? product.title
      : field === 'vendor'
        ? product.vendor
        : field === 'product_type'
          ? product.productType
          : field === 'existing_tags'
            ? (product.tags || []).join(' || ')
            : '';

  const haystack = String(sourceValue || '').toLowerCase();
  const expected = String(condition.value || '').toLowerCase();
  const expectedValues = Array.isArray(condition.values)
    ? condition.values.map((value) => String(value || '').toLowerCase()).filter(Boolean)
    : [];

  if (operator === 'equals') {
    return haystack === expected;
  }

  if (operator === 'contains') {
    return expected ? haystack.includes(expected) : false;
  }

  if (operator === 'contains_any') {
    return expectedValues.some((value) => haystack.includes(value));
  }

  return false;
}

export function productMatchesGroups(product, groups) {
  if (!Array.isArray(groups) || groups.length === 0) return false;

  return groups.some((group) => {
    if (!Array.isArray(group) || group.length === 0) return false;
    return group.every((condition) => evaluateCondition(product, condition));
  });
}

export async function requestOpenAIJson({ model, schemaName, schema, systemText, inputPayload }) {
  const apiKey = requiredEnv('OPENAI_API_KEY');
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model || process.env.OPENAI_MODEL || 'gpt-5.4-mini',
      input: [
        {
          role: 'system',
          content: [{ type: 'input_text', text: systemText }]
        },
        {
          role: 'user',
          content: [{ type: 'input_text', text: JSON.stringify(inputPayload) }]
        }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: schemaName,
          strict: true,
          schema
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
    throw new Error('No OpenAI output returned.');
  }

  return JSON.parse(outputText);
}
