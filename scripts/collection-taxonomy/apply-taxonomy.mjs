#!/usr/bin/env node

import path from 'node:path';
import {
  cwd,
  getShopifyAdminAccessToken,
  loadEnrichmentEnv,
  productMatchesGroups,
  readJsonFile,
  requiredEnv,
  shopifyGraphQL,
  timestampSlug,
  uniqueTags,
  writeJsonFile
} from './lib/shopify-taxonomy-utils.mjs';

const DEFAULT_CACHE_FILE = path.join(cwd, 'catalog-cache', 'shopify-catalog-cache.json');
const DEFAULT_PLAN_FILE = path.join(cwd, 'taxonomy-plans', 'shopify-collection-taxonomy-plan.json');
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

function parseArgs(argv) {
  const args = {
    cacheFile: DEFAULT_CACHE_FILE,
    planFile: DEFAULT_PLAN_FILE,
    collectionsOnly: false,
    write: false,
    outputDir: path.join(cwd, 'taxonomy-apply-output')
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--cache-file') {
      args.cacheFile = path.resolve(cwd, argv[index + 1] || '');
      index += 1;
      continue;
    }

    if (arg === '--plan-file') {
      args.planFile = path.resolve(cwd, argv[index + 1] || '');
      index += 1;
      continue;
    }

    if (arg === '--write') {
      args.write = true;
      continue;
    }

    if (arg === '--collections-only') {
      args.collectionsOnly = true;
      continue;
    }

    if (arg === '--output-dir') {
      args.outputDir = path.resolve(cwd, argv[index + 1] || args.outputDir);
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

function indexCollectionsByHandle(collections) {
  return new Map((collections || []).map((collection) => [collection.handle, collection]));
}

function buildAncestorHandlesByCollection(collections) {
  const collectionsByHandle = new Map((collections || []).map((collection) => [collection.handle, collection]));
  const cache = new Map();

  const resolveAncestors = (handle, stack = new Set()) => {
    if (!handle) return [];
    if (cache.has(handle)) return cache.get(handle);
    if (stack.has(handle)) return [];

    const collection = collectionsByHandle.get(handle);
    if (!collection || !collection.parent_handle) {
      cache.set(handle, []);
      return [];
    }

    const parentHandle = collection.parent_handle;
    stack.add(handle);
    const resolved = [parentHandle, ...resolveAncestors(parentHandle, stack)];
    stack.delete(handle);
    cache.set(handle, resolved);
    return resolved;
  };

  for (const collection of collections || []) {
    resolveAncestors(collection.handle);
  }

  return cache;
}

async function findCollectionByHandle({ shop, token, handle }) {
  const query = `
    query CollectionByHandle($query: String!) {
      collections(first: 1, query: $query) {
        nodes {
          id
          title
          handle
          ruleSet {
            appliedDisjunctively
            rules {
              column
              relation
              condition
            }
          }
        }
      }
    }
  `;

  const data = await shopifyGraphQL({
    shop,
    token,
    query,
    variables: {
      query: `handle:${handle}`
    }
  });

  return data.collections.nodes[0] || null;
}

function buildProductTagPlan(products, collections) {
  const collectionsByHandle = new Map((collections || []).map((collection) => [collection.handle, collection]));
  const ancestorHandlesByCollection = buildAncestorHandlesByCollection(collections);

  return (products || []).map((product) => {
    const addTags = [];
    const matchedCollections = [];

    for (const collection of collections) {
      if (!collection.managed_tag) continue;
      if (productMatchesGroups(product, collection.match_groups)) {
        addTags.push(collection.managed_tag);
        matchedCollections.push(collection.handle);

        const ancestorHandles = ancestorHandlesByCollection.get(collection.handle) || [];
        for (const ancestorHandle of ancestorHandles) {
          const ancestorCollection = collectionsByHandle.get(ancestorHandle);
          if (!ancestorCollection?.managed_tag) continue;
          addTags.push(ancestorCollection.managed_tag);
          matchedCollections.push(ancestorHandle);
        }
      }
    }

    const finalTags = uniqueTags([...(product.tags || []), ...addTags]);
    return {
      productId: product.id,
      title: product.title,
      currentTags: product.tags || [],
      addTags: uniqueTags(addTags),
      finalTags,
      matchedCollections
    };
  });
}

function buildCollectionHierarchyPlan(collections) {
  const childrenByParent = new Map();

  for (const collection of collections) {
    if (!collection.parent_handle) continue;
    const childHandles = childrenByParent.get(collection.parent_handle) || [];
    childHandles.push(collection.handle);
    childrenByParent.set(collection.parent_handle, childHandles);
  }

  return childrenByParent;
}

async function updateProductTags({ shop, token, productId, tags }) {
  const mutation = `
    mutation ProductUpdateTags($product: ProductUpdateInput!) {
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
    query: mutation,
    variables: {
      product: {
        id: productId,
        tags
      }
    }
  });

  const errors = data.productUpdate.userErrors || [];
  if (errors.length > 0) {
    throw new Error(`Shopify productUpdate failed: ${JSON.stringify(errors)}`);
  }

  return data.productUpdate.product;
}

async function createSmartCollection({ shop, token, collection }) {
  const mutation = `
    mutation CollectionCreate($input: CollectionInput!) {
      collectionCreate(input: $input) {
        collection {
          id
          title
          handle
          ruleSet {
            appliedDisjunctively
            rules {
              column
              relation
              condition
            }
          }
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
        title: collection.title,
        handle: collection.handle,
        descriptionHtml: collection.description_html,
        sortOrder: normalizeSortOrder(collection.sort_order),
        ruleSet: {
          appliedDisjunctively: false,
          rules: [
            {
              column: 'TAG',
              relation: 'EQUALS',
              condition: collection.managed_tag
            }
          ]
        }
      }
    }
  });

  const errors = data.collectionCreate.userErrors || [];
  if (errors.length > 0) {
    throw new Error(`Shopify collectionCreate failed: ${JSON.stringify(errors)}`);
  }

  return data.collectionCreate.collection;
}

async function updateSmartCollection({ shop, token, collectionId, collection }) {
  const mutation = `
    mutation CollectionUpdate($input: CollectionInput!) {
      collectionUpdate(input: $input) {
        collection {
          id
          title
          handle
          ruleSet {
            appliedDisjunctively
            rules {
              column
              relation
              condition
            }
          }
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
        title: collection.title,
        handle: collection.handle,
        descriptionHtml: collection.description_html,
        sortOrder: normalizeSortOrder(collection.sort_order),
        ruleSet: {
          appliedDisjunctively: false,
          rules: [
            {
              column: 'TAG',
              relation: 'EQUALS',
              condition: collection.managed_tag
            }
          ]
        }
      }
    }
  });

  const errors = data.collectionUpdate.userErrors || [];
  if (errors.length > 0) {
    throw new Error(`Shopify collectionUpdate failed: ${JSON.stringify(errors)}`);
  }

  return data.collectionUpdate.collection;
}

async function setCollectionMetafields({ shop, token, metafields }) {
  if (metafields.length === 0) return;

  const mutation = `
    mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          namespace
          key
          value
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;

  const data = await shopifyGraphQL({
    shop,
    token,
    query: mutation,
    variables: { metafields }
  });

  const errors = data.metafieldsSet.userErrors || [];
  if (errors.length > 0) {
    throw new Error(`Shopify metafieldsSet failed: ${JSON.stringify(errors)}`);
  }
}

async function deleteCollectionMetafields({ shop, token, identifiers }) {
  if (identifiers.length === 0) return;

  const mutation = `
    mutation MetafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
      metafieldsDelete(metafields: $metafields) {
        deletedMetafields {
          ownerId
          namespace
          key
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
    variables: { metafields: identifiers }
  });

  const errors = data.metafieldsDelete.userErrors || [];
  if (errors.length > 0) {
    throw new Error(`Shopify metafieldsDelete failed: ${JSON.stringify(errors)}`);
  }
}

async function main() {
  await loadEnrichmentEnv();
  const args = parseArgs(process.argv.slice(2));
  const catalog = await readJsonFile(args.cacheFile);
  const plan = await readJsonFile(args.planFile);
  const shop = requiredEnv('SHOPIFY_SHOP_DOMAIN');
  const token = args.write ? await getShopifyAdminAccessToken(shop) : null;

  const plannedCollections = Array.isArray(plan.collections) ? plan.collections : [];
  const existingCollectionsByHandle = indexCollectionsByHandle(catalog.collections || []);
  const productTagPlan = buildProductTagPlan(catalog.products || [], plannedCollections);
  const hierarchy = buildCollectionHierarchyPlan(plannedCollections);

  const collectionActions = plannedCollections.map((collection) => {
    const existing = existingCollectionsByHandle.get(collection.handle) || null;

    if (!existing) {
      return {
        handle: collection.handle,
        title: collection.title,
        action: 'create',
        managedTag: collection.managed_tag
      };
    }

    const existingIsSmart = Boolean(existing.ruleSet && existing.ruleSet.rules && existing.ruleSet.rules.length > 0);
    if (!existingIsSmart) {
      return {
        handle: collection.handle,
        title: collection.title,
        action: 'conflict',
        reason: 'Existing collection is manual. Shopify cannot convert a manual collection into a smart collection.'
      };
    }

    return {
      handle: collection.handle,
      title: collection.title,
      action: 'update',
      managedTag: collection.managed_tag
    };
  });

  const summary = {
    dry_run: !args.write,
    collections_only: args.collectionsOnly,
    planned_collection_count: plannedCollections.length,
    product_tag_updates: productTagPlan.filter((entry) => entry.addTags.length > 0).length,
    collection_actions: collectionActions
  };

  const appliedCollectionsByHandle = new Map(
    (catalog.collections || []).map((collection) => [collection.handle, { id: collection.id, handle: collection.handle, title: collection.title }])
  );

  const errors = [];

  if (args.write) {
    for (const action of collectionActions) {
      const collection = plannedCollections.find((entry) => entry.handle === action.handle);
      if (!collection || action.action === 'conflict') {
        if (action.action === 'conflict') errors.push(action);
        continue;
      }

      try {
        if (action.action === 'create') {
          try {
            const created = await createSmartCollection({ shop, token, collection });
            appliedCollectionsByHandle.set(collection.handle, created);
          } catch (error) {
            if (!error.message.includes('Handle has already been taken')) {
              throw error;
            }

            const liveCollection = await findCollectionByHandle({
              shop,
              token,
              handle: collection.handle
            });

            if (!liveCollection) {
              throw error;
            }

            const updated = await updateSmartCollection({
              shop,
              token,
              collectionId: liveCollection.id,
              collection
            });
            appliedCollectionsByHandle.set(collection.handle, updated);
          }
        } else if (action.action === 'update') {
          const existing = existingCollectionsByHandle.get(collection.handle);
          const updated = await updateSmartCollection({
            shop,
            token,
            collectionId: existing.id,
            collection
          });
          appliedCollectionsByHandle.set(collection.handle, updated);
        }
      } catch (error) {
        errors.push({
          handle: action.handle,
          action: action.action,
          error: error.message
        });
      }
    }

    if (!args.collectionsOnly) {
      for (const update of productTagPlan) {
        if (update.addTags.length === 0) continue;

        try {
          await updateProductTags({
            shop,
            token,
            productId: update.productId,
            tags: update.finalTags
          });
        } catch (error) {
          errors.push({
            productId: update.productId,
            title: update.title,
            action: 'product-tag-update',
            error: error.message
          });
        }
      }
    }

    const metafieldsToSet = [];
    const metafieldsToDelete = [];

    for (const collection of plannedCollections) {
      const current = appliedCollectionsByHandle.get(collection.handle);
      if (!current) continue;

      const childHandles = hierarchy.get(collection.handle) || [];
      const childIds = childHandles
        .map((handle) => appliedCollectionsByHandle.get(handle)?.id)
        .filter(Boolean);

      const parentId = collection.parent_handle
        ? appliedCollectionsByHandle.get(collection.parent_handle)?.id || null
        : null;

      if (parentId) {
        metafieldsToSet.push({
          ownerId: current.id,
          namespace: 'custom',
          key: 'parent_collection',
          type: 'collection_reference',
          value: parentId
        });
      } else {
        metafieldsToDelete.push({
          ownerId: current.id,
          namespace: 'custom',
          key: 'parent_collection'
        });
      }

      if (childIds.length > 0) {
        metafieldsToSet.push({
          ownerId: current.id,
          namespace: 'custom',
          key: 'child_collections',
          type: 'list.collection_reference',
          value: JSON.stringify(childIds)
        });
      } else {
        metafieldsToDelete.push({
          ownerId: current.id,
          namespace: 'custom',
          key: 'child_collections'
        });
      }
    }

    try {
      for (let index = 0; index < metafieldsToSet.length; index += 25) {
        await setCollectionMetafields({
          shop,
          token,
          metafields: metafieldsToSet.slice(index, index + 25)
        });
      }

      for (let index = 0; index < metafieldsToDelete.length; index += 25) {
        await deleteCollectionMetafields({
          shop,
          token,
          identifiers: metafieldsToDelete.slice(index, index + 25)
        });
      }
    } catch (error) {
      errors.push({
        action: 'collection-metafields',
        error: error.message
      });
    }
  }

  const outputPath = path.join(args.outputDir, `shopify-collection-taxonomy-apply-${timestampSlug()}.json`);
  await writeJsonFile(outputPath, {
    generated_at: new Date().toISOString(),
    source_cache_file: args.cacheFile,
    source_plan_file: args.planFile,
    summary,
    product_tag_plan: productTagPlan,
    collection_actions: collectionActions,
    hierarchy_preview: Object.fromEntries(hierarchy.entries()),
    errors
  });

  console.log(`Wrote taxonomy apply report to ${outputPath}`);
  console.log(args.write ? 'Mode: write' : 'Mode: dry-run');
  console.log(`Products receiving new tags: ${summary.product_tag_updates}`);
  console.log(`Collections in plan: ${summary.planned_collection_count}`);
  if (errors.length > 0) {
    console.log(`Warnings/errors: ${errors.length}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
