# Shopify Collection Hierarchy

This theme now supports a collection hierarchy using Shopify collection metafields.

## Metafields to create

Create these two metafield definitions in Shopify admin:

1. Collection metafield
   Namespace and key: `custom.parent_collection`
   Type: `Collection`
   Purpose: Select the direct parent collection for the current collection.

2. Collection metafield
   Namespace and key: `custom.child_collections`
   Type: `List of collections`
   Purpose: Select the child collections to show on the current collection page.

## Recommended content model

Use `custom.parent_collection` as the main hierarchy signal.

Example:

- `Garden` -> no parent
- `Lighting` -> parent = `Garden`
- `Solar Lights` -> parent = `Lighting`

Then optionally add children on the parent collection:

- `Garden` children = `Lighting`, `Furniture`
- `Lighting` children = `Solar Lights`, `Wall Lights`

This gives you:

- parent-aware breadcrumbs
- a “Back to parent” link
- a visible subcategory grid on collection pages

## What the theme does

On collection pages, the theme now:

- builds breadcrumbs from `custom.parent_collection`
- shows a back link to the immediate parent collection
- shows child collection cards from `custom.child_collections`

Files:

- [sections/main-collection.liquid](sections/main-collection.liquid)
- [assets/theme.css](assets/theme.css)

## Depth

The current breadcrumb implementation supports up to 6 parent levels in the theme code.

That is usually more than enough for real storefront navigation. If you ever need more, extend the repeated ancestor assignments in `sections/main-collection.liquid`.

## URL behavior

Breadcrumbs reflect the hierarchy, but Shopify collection URLs remain native collection URLs such as:

- `/collections/garden`
- `/collections/lighting`
- `/collections/solar-lights`

They do not become nested URLs like `/collections/garden/lighting/solar-lights`.

That limitation is from Shopify’s collection routing, not the theme.
