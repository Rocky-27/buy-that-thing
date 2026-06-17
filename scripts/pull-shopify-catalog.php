#!/usr/bin/env php
<?php

declare(strict_types=1);

require __DIR__ . '/lib/bootstrap.php';

final class PullShopifyCatalogCommand
{
    public function __construct(
        private readonly ConsoleIO $io,
        private readonly ShopifyClient $shopifyClient,
        private readonly JsonStorage $storage,
        private readonly string $shopDomain,
    ) {
    }

    public function run(array $options): int
    {
        $dryRun = array_key_exists('dry-run', $options)
            ? filter_var($options['dry-run'], FILTER_VALIDATE_BOOL)
            : $this->io->promptYesNo('Dry run', true);

        $productsPath = ProjectPath::resolve($this->io->prompt('Products output path', 'storage/catalog/products.json'));
        $collectionsPath = ProjectPath::resolve($this->io->prompt('Collections output path', 'storage/catalog/collections.json'));

        $products = $this->fetchProducts();
        $collections = $this->fetchCollections();

        $productsPayload = [
            'generated_at' => gmdate(DATE_ATOM),
            'shop_domain' => $this->shopDomain,
            'product_count' => count($products),
            'products' => $products,
        ];

        $collectionsPayload = [
            'generated_at' => gmdate(DATE_ATOM),
            'shop_domain' => $this->shopDomain,
            'collection_count' => count($collections),
            'collections' => $collections,
        ];

        $this->io->write(sprintf('Fetched %d products and %d collections.', count($products), count($collections)));

        if ($dryRun) {
            $this->io->write(sprintf('Dry run enabled. Skipping writes to %s and %s.', $productsPath, $collectionsPath));

            return 0;
        }

        $this->storage->write($productsPath, $productsPayload);
        $this->storage->write($collectionsPath, $collectionsPayload);

        $this->io->write(sprintf('Saved products to %s', $productsPath));
        $this->io->write(sprintf('Saved collections to %s', $collectionsPath));

        return 0;
    }

    private function fetchProducts(): array
    {
        $nodes = $this->shopifyClient->fetchAllNodes(
            'products',
            <<<'GRAPHQL'
id
legacyResourceId
handle
title
descriptionHtml
tags
vendor
productType
status
updatedAt
GRAPHQL
        );

        return array_map(static function (array $product): array {
            return [
                'shopify_gid' => $product['id'],
                'shopify_product_id' => $product['legacyResourceId'],
                'handle' => $product['handle'],
                'title' => $product['title'],
                'description_html' => $product['descriptionHtml'],
                'description_text' => CatalogHelper::normalizeHtmlToText($product['descriptionHtml'] ?? ''),
                'tags' => $product['tags'] ?? [],
                'vendor' => $product['vendor'] ?? null,
                'product_type' => $product['productType'] ?? null,
                'status' => $product['status'] ?? null,
                'updated_at' => $product['updatedAt'] ?? null,
            ];
        }, $nodes);
    }

    private function fetchCollections(): array
    {
        $nodes = $this->shopifyClient->fetchAllNodes(
            'collections',
            <<<'GRAPHQL'
id
legacyResourceId
handle
title
descriptionHtml
updatedAt
ruleSet {
  appliedDisjunctively
  rules {
    column
    relation
    condition
  }
}
GRAPHQL
        );

        return array_map(static function (array $collection): array {
            return [
                'shopify_gid' => $collection['id'],
                'shopify_collection_id' => $collection['legacyResourceId'],
                'handle' => $collection['handle'],
                'title' => $collection['title'],
                'description' => CatalogHelper::normalizeHtmlToText($collection['descriptionHtml'] ?? ''),
                'tag' => CatalogHelper::extractCollectionTag($collection),
                'updated_at' => $collection['updatedAt'] ?? null,
            ];
        }, $nodes);
    }
}

EnvLoader::load(PROJECT_ROOT . '.env');

$options = CliOptions::parse($argv);
$io = new ConsoleIO();
$storage = new JsonStorage();
$httpClient = new HttpClient();
$config = ShopifyConfig::fromEnv();
$accessTokenProvider = new ShopifyAccessTokenProvider($config, $httpClient, $storage);
$shopifyClient = new ShopifyClient($config, $accessTokenProvider, $httpClient);
$command = new PullShopifyCatalogCommand($io, $shopifyClient, $storage, $config->shopDomain);

exit($command->run($options));
