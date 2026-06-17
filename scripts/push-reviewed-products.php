#!/usr/bin/env php
<?php

declare(strict_types=1);

require __DIR__ . '/lib/bootstrap.php';

final class PushReviewedProductsCommand
{
    public function __construct(
        private readonly ConsoleIO $io,
        private readonly ShopifyClient $shopifyClient,
        private readonly JsonStorage $storage,
    ) {
    }

    public function run(array $options): int
    {
        $dryRun = array_key_exists('dry-run', $options)
            ? filter_var($options['dry-run'], FILTER_VALIDATE_BOOL)
            : $this->io->promptYesNo('Dry run', true);

        $inputPath = ProjectPath::resolve($this->io->prompt('Review input path', 'storage/reviews/product-reviews.json'));
        $limit = isset($options['limit']) ? (int) $options['limit'] : (int) $this->io->prompt('Limit products to push (0 = all)', '0');

        $payload = $this->storage->read($inputPath);
        $products = $payload['products'] ?? [];

        if (!is_array($products)) {
            throw new RuntimeException('Review file is missing the expected products array.');
        }

        if ($limit > 0) {
            $products = array_slice($products, 0, $limit);
        }

        $this->io->write(sprintf('Loaded %d reviewed products.', count($products)));

        if (!$dryRun && !$this->io->promptYesNo('Proceed with Shopify updates', false)) {
            $this->io->write('Cancelled.');

            return 0;
        }

        foreach ($products as $index => $product) {
            $this->pushSingleProduct($product, $index + 1, count($products), $dryRun);
        }

        $this->io->write($dryRun ? 'Dry run complete. No Shopify changes were made.' : 'Shopify updates complete.');

        return 0;
    }

    private function pushSingleProduct(array $product, int $current, int $total, bool $dryRun): void
    {
        $gid = (string) ($product['shopify_gid'] ?? '');
        if ($gid === '') {
            throw new RuntimeException('Each reviewed product must include shopify_gid.');
        }

        $tagMode = (string) ($product['tag_mode'] ?? 'append');
        $title = (string) ($product['suggested_title'] ?? '');
        $descriptionHtml = (string) ($product['suggested_description_html'] ?? '');
        $proposedTags = array_values(array_filter($product['proposed_tags'] ?? [], 'is_string'));
        $originalTags = array_values(array_filter($product['original_tags'] ?? [], 'is_string'));
        $tagsToAdd = array_values(array_diff($proposedTags, $originalTags));

        $this->io->write(sprintf('[%d/%d] %s', $current, $total, (string) ($product['shopify_product_id'] ?? $gid)));

        if ($dryRun) {
            $this->io->write(sprintf('  Dry run: would update title/description and %s tags.', $tagMode));

            return;
        }

        $this->updateProductCopy($gid, $title, $descriptionHtml, $tagMode === 'overwrite' ? $proposedTags : $originalTags);

        if ($tagMode === 'append' && $tagsToAdd !== []) {
            $this->appendTags($gid, $tagsToAdd);
        }
    }

    private function updateProductCopy(string $gid, string $title, string $descriptionHtml, array $tags): void
    {
        $mutation = <<<'GRAPHQL'
mutation UpdateProduct($input: ProductUpdateInput!) {
  productUpdate(product: $input) {
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
GRAPHQL;

        $result = $this->shopifyClient->graphql($mutation, [
            'input' => [
                'id' => $gid,
                'title' => $title,
                'descriptionHtml' => $descriptionHtml,
                'tags' => $tags,
            ],
        ]);

        $userErrors = $result['productUpdate']['userErrors'] ?? [];
        if (!empty($userErrors)) {
            throw new RuntimeException('Shopify productUpdate failed: ' . json_encode($userErrors, JSON_UNESCAPED_SLASHES));
        }
    }

    private function appendTags(string $gid, array $tags): void
    {
        $mutation = <<<'GRAPHQL'
mutation AddTags($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) {
    node {
      id
    }
    userErrors {
      field
      message
    }
  }
}
GRAPHQL;

        $result = $this->shopifyClient->graphql($mutation, [
            'id' => $gid,
            'tags' => $tags,
        ]);

        $userErrors = $result['tagsAdd']['userErrors'] ?? [];
        if (!empty($userErrors)) {
            throw new RuntimeException('Shopify tagsAdd failed: ' . json_encode($userErrors, JSON_UNESCAPED_SLASHES));
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
$command = new PushReviewedProductsCommand($io, $shopifyClient, $storage);

exit($command->run($options));
