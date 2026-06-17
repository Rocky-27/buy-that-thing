#!/usr/bin/env php
<?php

declare(strict_types=1);

require __DIR__ . '/lib/bootstrap.php';

final class FixShopifyCompareAtPricesCommand
{
    public function __construct(
        private readonly ConsoleIO $io,
        private readonly ShopifyClient $shopifyClient,
    ) {
    }

    public function run(array $options): int
    {
        $dryRun = array_key_exists('dry-run', $options)
            ? filter_var($options['dry-run'], FILTER_VALIDATE_BOOL)
            : $this->io->promptYesNo('Dry run', true);

        $limit = isset($options['limit']) ? max(0, (int) $options['limit']) : 0;
        $mode = isset($options['mode']) ? trim((string) $options['mode']) : $this->io->promptChoice('Fix mode', ['equal', 'lower-than-price', 'invalid'], 'invalid');
        if (!in_array($mode, ['equal', 'lower-than-price', 'invalid'], true)) {
            throw new RuntimeException('Mode must be one of: equal, lower-than-price, invalid.');
        }

        $products = $this->fetchProducts();
        $affectedProducts = $this->collectAffectedProducts($products, $limit, $mode);
        $affectedVariantCount = array_sum(array_map(
            static fn (array $product): int => count($product['variants']),
            $affectedProducts
        ));

        $this->io->write(sprintf(
            'Found %d affected variants across %d products.',
            $affectedVariantCount,
            count($affectedProducts)
        ));

        if ($affectedVariantCount === 0) {
            return 0;
        }

        if ($dryRun) {
            foreach (array_slice($affectedProducts, 0, 20) as $product) {
                $this->io->write(sprintf(
                    '  Product %s (%s): %d variant(s) would be updated.',
                    $product['legacyResourceId'],
                    $product['title'],
                    count($product['variants'])
                ));
            }

            if (count($affectedProducts) > 20) {
                $this->io->write(sprintf('  ...and %d more products.', count($affectedProducts) - 20));
            }

            $this->io->write('Dry run complete. No Shopify changes were made.');

            return 0;
        }

        if (!$this->io->promptYesNo('Proceed with clearing equal compare-at prices in Shopify', false)) {
            $this->io->write('Cancelled.');

            return 0;
        }

        $updatedProducts = 0;
        $updatedVariants = 0;

        foreach ($affectedProducts as $index => $product) {
            $this->io->write(sprintf(
                '[%d/%d] Product %s (%s)',
                $index + 1,
                count($affectedProducts),
                $product['legacyResourceId'],
                $product['title']
            ));

            $this->clearCompareAtPrices($product['id'], $product['variants']);
            $updatedProducts++;
            $updatedVariants += count($product['variants']);
        }

        $this->io->write(sprintf(
            'Shopify updates complete. Cleared compare-at prices on %d variants across %d products.',
            $updatedVariants,
            $updatedProducts
        ));

        return 0;
    }

    private function fetchProducts(): array
    {
        return $this->shopifyClient->fetchAllNodes(
            'products',
            <<<'GRAPHQL'
id
legacyResourceId
title
variants(first: 100) {
  nodes {
    id
    legacyResourceId
    title
    price
    compareAtPrice
  }
}
GRAPHQL
        );
    }

    private function collectAffectedProducts(array $products, int $limit, string $mode): array
    {
        $affectedProducts = [];
        $affectedVariants = 0;

        foreach ($products as $product) {
            $affected = [];

            foreach (($product['variants']['nodes'] ?? []) as $variant) {
                $price = trim((string) ($variant['price'] ?? ''));
                $compareAtPrice = trim((string) ($variant['compareAtPrice'] ?? ''));

                if (!$this->shouldClearCompareAtPrice($price, $compareAtPrice, $mode)) {
                    continue;
                }

                $affected[] = [
                    'id' => (string) $variant['id'],
                    'legacyResourceId' => (string) ($variant['legacyResourceId'] ?? ''),
                    'title' => (string) ($variant['title'] ?? ''),
                    'price' => $price,
                ];
            }

            if ($affected === []) {
                continue;
            }

            if ($limit > 0 && $affectedVariants >= $limit) {
                break;
            }

            if ($limit > 0 && $affectedVariants + count($affected) > $limit) {
                $affected = array_slice($affected, 0, $limit - $affectedVariants);
            }

            $affectedProducts[] = [
                'id' => (string) $product['id'],
                'legacyResourceId' => (string) ($product['legacyResourceId'] ?? ''),
                'title' => (string) ($product['title'] ?? ''),
                'variants' => $affected,
            ];

            $affectedVariants += count($affected);
        }

        return $affectedProducts;
    }

    private function shouldClearCompareAtPrice(string $price, string $compareAtPrice, string $mode): bool
    {
        if ($price === '' || $compareAtPrice === '') {
            return false;
        }

        if (!is_numeric($price) || !is_numeric($compareAtPrice)) {
            return false;
        }

        $priceValue = (float) $price;
        $compareAtPriceValue = (float) $compareAtPrice;

        return match ($mode) {
            'equal' => $compareAtPriceValue === $priceValue,
            'lower-than-price' => $compareAtPriceValue < $priceValue,
            'invalid' => $compareAtPriceValue <= $priceValue,
            default => false,
        };
    }

    private function clearCompareAtPrices(string $productId, array $variants): void
    {
        $mutation = <<<'GRAPHQL'
mutation ProductVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    product {
      id
    }
    productVariants {
      id
      compareAtPrice
    }
    userErrors {
      field
      message
    }
  }
}
GRAPHQL;

        $result = $this->shopifyClient->graphql($mutation, [
            'productId' => $productId,
            'variants' => array_map(
                static fn (array $variant): array => [
                    'id' => $variant['id'],
                    'compareAtPrice' => null,
                ],
                $variants
            ),
        ]);

        $userErrors = $result['productVariantsBulkUpdate']['userErrors'] ?? [];
        if (!empty($userErrors)) {
            throw new RuntimeException('Shopify productVariantsBulkUpdate failed: ' . json_encode($userErrors, JSON_UNESCAPED_SLASHES));
        }
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
$command = new FixShopifyCompareAtPricesCommand($io, $shopifyClient);

exit($command->run($options));
