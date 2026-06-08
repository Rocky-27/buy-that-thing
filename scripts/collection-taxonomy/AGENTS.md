# Collection Taxonomy Agent Notes

Use this guide when reviewing `catalog-cache` snapshots and proposing Shopify collection taxonomy plans.

## Goal

Design a practical Shopify collection hierarchy that:

- improves storefront browse structure
- can be implemented as smart collections
- allows products to belong to more than one collection through additive tags
- keeps hierarchy manageable for staff in Shopify admin

## Constraints

- Real Shopify collection URLs remain flat: `/collections/<handle>`
- Hierarchy is reflected through collection metafields, breadcrumbs, and child collection blocks
- Smart collections should be driven by one managed tag per collection
- Product tagging must be additive, never destructive
- Avoid creating tiny, redundant, or highly overlapping collections unless there is a clear merchandising reason

## Managed tag strategy

Every proposed collection should have:

- a unique `handle`
- a unique managed tag using the configured prefix, for example `taxonomy:solar-lights`

Products are tagged locally first. Shopify smart collections then use the managed tag as the rule input.

## Matching rules

When proposing collection matches, use only these product fields:

- `title`
- `vendor`
- `product_type`
- `existing_tags`

Allowed operators:

- `equals`
- `contains`
- `contains_any`

Prefer:

- `product_type` rules for broad, reliable category assignment
- `title` and `existing_tags` rules for narrower subcategories
- multiple groups only when needed

## Hierarchy guidance

Prefer:

- broad parent collections
- narrower child collections
- 2-4 levels in normal use

Avoid:

- very deep trees without a strong browsing reason
- siblings that differ only by minor wording
- collections that exist only because of one supplier name unless vendor-driven shopping matters
