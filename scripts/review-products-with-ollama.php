#!/usr/bin/env php
<?php

declare(strict_types=1);

require __DIR__ . '/lib/bootstrap.php';

final class ReviewProductsWithOllamaCommand
{
    public function __construct(
        private readonly ConsoleIO $io,
        private readonly JsonStorage $storage,
        private readonly HttpClient $httpClient,
    ) {
    }

    public function run(array $options): int
    {
        $dryRun = array_key_exists('dry-run', $options)
            ? filter_var($options['dry-run'], FILTER_VALIDATE_BOOL)
            : $this->io->promptYesNo('Dry run', true);

        $productsPath = ProjectPath::resolve($this->io->prompt('Products input path', 'storage/catalog/products.json'));
        $collectionsPath = ProjectPath::resolve($this->io->prompt('Collections input path', 'storage/catalog/collections.json'));
        $outputPath = ProjectPath::resolve($this->io->prompt('Review output path', 'storage/reviews/product-reviews.json'));
        $ollamaBaseUrl = $this->io->prompt('Ollama base URL', getenv('OLLAMA_BASE_URL') !== false ? getenv('OLLAMA_BASE_URL') : 'http://localhost:11434');
        $model = $options['model'] ?? $this->promptForModel(getenv('OLLAMA_MODEL') !== false ? (string) getenv('OLLAMA_MODEL') : 'llama3.2');
        $tagMode = $options['tag-mode'] ?? $this->io->promptChoice('Tag mode', ['append', 'overwrite'], 'append');
        $limit = isset($options['limit']) ? (int) $options['limit'] : (int) $this->io->prompt('Limit products to process (0 = all)', '0');
        $limit = max(0, $limit);
        $batchSize = isset($options['batch-size']) ? (int) $options['batch-size'] : (int) $this->io->prompt('Batch size', '10');
        $batchSize = max(1, $batchSize);
        $keepAlive = $options['keep-alive'] ?? $this->io->prompt('Ollama keep alive', '15m');
        $warmup = array_key_exists('warmup', $options)
            ? filter_var($options['warmup'], FILTER_VALIDATE_BOOL)
            : $this->io->promptYesNo('Warm up model before review', true);
        $resume = array_key_exists('resume', $options)
            ? filter_var($options['resume'], FILTER_VALIDATE_BOOL)
            : $this->io->promptYesNo('Resume from existing review file if present', true);
        $checkpointEvery = isset($options['checkpoint-every']) ? (int) $options['checkpoint-every'] : (int) $this->io->prompt('Checkpoint every N products', '1');
        $checkpointEvery = max(1, $checkpointEvery);
        $failuresPath = ProjectPath::resolve($this->io->prompt('Failure log path', 'storage/reviews/product-review-failures.json'));

        $productsPayload = $this->storage->read($productsPath);
        $collectionsPayload = $this->storage->read($collectionsPath);

        $products = $productsPayload['products'] ?? [];
        $collections = $collectionsPayload['collections'] ?? [];

        if (!is_array($products) || !is_array($collections)) {
            throw new RuntimeException('Input files are missing the expected products/collections arrays.');
        }

        if ($limit > 0) {
            $products = array_slice($products, 0, $limit);
        }

        $existingPayload = $resume && !$dryRun ? $this->loadExistingReviewPayload($outputPath) : null;
        $existingResults = is_array($existingPayload['products'] ?? null) ? $existingPayload['products'] : [];
        $processedIds = $this->processedProductIds($existingResults);
        if ($processedIds !== []) {
            $products = array_values(array_filter($products, static function (array $product) use ($processedIds): bool {
                return !isset($processedIds[(string) ($product['shopify_product_id'] ?? '')]);
            }));
            $this->io->write(sprintf('Resume enabled. Skipping %d products already present in the review output.', count($processedIds)));
        }

        $knownCollectionTags = CatalogHelper::collectionTags($collections);
        $ollamaClient = new OllamaClient($this->httpClient, $ollamaBaseUrl);
        if ($warmup) {
            $this->io->write(sprintf('Warming up model %s with keep_alive=%s.', $model, (string) $keepAlive));
            $ollamaClient->warmup($model, $keepAlive);
        }

        $failures = [];
        $results = $existingResults;
        $processedSinceCheckpoint = 0;
        $newResults = $this->reviewProducts(
            $products,
            $collections,
            $knownCollectionTags,
            $ollamaClient,
            $model,
            $tagMode,
            $batchSize,
            $keepAlive,
            $failures,
            function (array $chunkResults, array $chunkFailures) use (
                &$results,
                &$failures,
                &$processedSinceCheckpoint,
                $dryRun,
                $outputPath,
                $failuresPath,
                $model,
                $tagMode,
                $limit,
                $batchSize,
                $keepAlive,
                $resume,
                $checkpointEvery
            ): void {
                $results = array_merge($results, $chunkResults);
                $processedSinceCheckpoint += count($chunkResults);

                if ($dryRun) {
                    return;
                }

                if ($processedSinceCheckpoint < $checkpointEvery) {
                    return;
                }

                $this->writeReviewPayload(
                    $outputPath,
                    $results,
                    $model,
                    $tagMode,
                    $limit,
                    $batchSize,
                    $keepAlive,
                    $resume
                );
                $this->storage->write($failuresPath, [
                    'generated_at' => gmdate(DATE_ATOM),
                    'failure_count' => count($failures),
                    'failures' => $failures,
                ]);
                $processedSinceCheckpoint = 0;
            }
        );
        $results = array_merge($results, $newResults);

        if ($dryRun) {
            $this->io->write(sprintf('Dry run enabled. Reviewed %d products without writing %s.', count($results), $outputPath));

            return 0;
        }

        $this->writeReviewPayload($outputPath, $results, $model, $tagMode, $limit, $batchSize, $keepAlive, $resume);
        $this->storage->write($failuresPath, [
            'generated_at' => gmdate(DATE_ATOM),
            'failure_count' => count($failures),
            'failures' => $failures,
        ]);
        $this->io->write(sprintf('Saved review output to %s', $outputPath));
        $this->io->write(sprintf('Saved failure log to %s', $failuresPath));

        return 0;
    }

    private function reviewProducts(
        array $products,
        array $collections,
        array $knownCollectionTags,
        OllamaClient $ollamaClient,
        string $model,
        string $tagMode,
        int $batchSize,
        string|int|null $keepAlive,
        array &$failures,
        ?callable $checkpointWriter = null,
    ): array {
        $results = [];
        $failureChunk = [];
        $collectionsSummary = $this->buildCollectionsSummary($collections);
        $batches = array_chunk($products, $batchSize);

        foreach ($batches as $batchIndex => $batch) {
            $batchStart = ($batchIndex * $batchSize) + 1;
            $batchEnd = $batchStart + count($batch) - 1;
            $this->io->write(sprintf('Reviewing batch %d (%d-%d of %d).', $batchIndex + 1, $batchStart, $batchEnd, count($products)));

            try {
                $reviewsByProductId = count($batch) === 1
                    ? $this->reviewSingleProductWithRetry(
                        $batch[0],
                        $knownCollectionTags,
                        $collectionsSummary,
                        $ollamaClient,
                        $model,
                        $keepAlive,
                    )
                    : $this->reviewBatchWithRetry(
                        $batch,
                        $knownCollectionTags,
                        $collectionsSummary,
                        $ollamaClient,
                        $model,
                        $keepAlive,
                    );
            } catch (RuntimeException $exception) {
                $this->io->error(sprintf(
                    'Batch %d failed structured parsing: %s',
                    $batchIndex + 1,
                    $exception->getMessage()
                ));
                $this->io->write('Falling back to one-product review calls for this batch.');
                $reviewsByProductId = $this->reviewBatchOneByOne(
                    $batch,
                    $knownCollectionTags,
                    $collectionsSummary,
                    $ollamaClient,
                    $model,
                    $keepAlive,
                );
            }

            foreach ($batch as $product) {
                $productId = (string) ($product['shopify_product_id'] ?? '');
                $reviewFound = $productId !== '' && array_key_exists($productId, $reviewsByProductId);
                if ($productId === '' || !array_key_exists($productId, $reviewsByProductId)) {
                    $message = sprintf(
                        'No structured review returned for product %s. Falling back to original content for this record.',
                        $productId !== '' ? $productId : 'unknown'
                    );
                    $this->io->error(sprintf(
                        'No structured review returned for product %s. Falling back to original content for this record.',
                        $productId !== '' ? $productId : 'unknown'
                    ));
                    $failureChunk[] = [
                        'shopify_product_id' => $productId,
                        'title' => (string) ($product['title'] ?? ''),
                        'error' => $message,
                        'failed_at' => gmdate(DATE_ATOM),
                    ];
                }

                $results[] = $this->mapReviewedProduct($product, $knownCollectionTags, $reviewsByProductId, $tagMode, !$reviewFound);
            }

            if ($checkpointWriter !== null && $results !== []) {
                $failures = array_merge($failures, $failureChunk);
                $checkpointWriter($results, $failureChunk);
                $results = [];
                $failureChunk = [];
            }
        }

        if ($failureChunk !== []) {
            $failures = array_merge($failures, $failureChunk);
        }

        return $results;
    }

    private function reviewBatchWithRetry(
        array $batch,
        array $knownCollectionTags,
        array $collectionsSummary,
        OllamaClient $ollamaClient,
        string $model,
        string|int|null $keepAlive,
    ): array {
        $lastException = null;

        for ($attempt = 1; $attempt <= 2; $attempt++) {
            try {
                $response = $ollamaClient->generateStructured(
                    $model,
                    $this->batchReviewSchema(),
                    $this->buildBatchPrompt($batch, $knownCollectionTags, $collectionsSummary),
                    $keepAlive,
                );

                return $this->indexBatchReviews($response, $batch);
            } catch (RuntimeException $exception) {
                $lastException = $exception;

                if ($attempt < 2) {
                    $this->io->error(sprintf('Batch response invalid on attempt %d. Retrying once.', $attempt));
                }
            }
        }

        throw $lastException ?? new RuntimeException('Batch review failed.');
    }

    private function reviewSingleProductWithRetry(
        array $product,
        array $knownCollectionTags,
        array $collectionsSummary,
        OllamaClient $ollamaClient,
        string $model,
        string|int|null $keepAlive,
    ): array {
        $lastException = null;

        for ($attempt = 1; $attempt <= 2; $attempt++) {
            try {
                $response = $ollamaClient->generateStructured(
                    $model,
                    $this->singleReviewSchema(),
                    $this->buildSingleProductPrompt($product, $knownCollectionTags, $collectionsSummary),
                    $keepAlive,
                );

                $productId = (string) ($product['shopify_product_id'] ?? '');
                $response['shopify_product_id'] = $response['shopify_product_id'] ?? $productId;

                return [$productId => $response];
            } catch (RuntimeException $exception) {
                $lastException = $exception;

                if ($attempt < 2) {
                    $this->io->error(sprintf(
                        'Single-product response invalid for %s on attempt %d. Retrying once.',
                        (string) ($product['shopify_product_id'] ?? 'unknown'),
                        $attempt
                    ));
                }
            }
        }

        throw $lastException ?? new RuntimeException('Single-product review failed.');
    }

    private function batchReviewSchema(): array
    {
        return [
            'type' => 'object',
            'properties' => [
                'reviews' => [
                    'type' => 'array',
                    'items' => $this->singleReviewItemSchema(),
                ],
            ],
            'required' => ['reviews'],
        ];
    }

    private function singleReviewSchema(): array
    {
        return $this->singleReviewItemSchema();
    }

    private function singleReviewItemSchema(): array
    {
        return [
            'type' => 'object',
            'properties' => [
                'shopify_product_id' => ['type' => ['string', 'integer']],
                'suggested_title' => ['type' => 'string'],
                'suggested_description_html' => ['type' => 'string'],
                'suggested_collection_tag' => ['type' => ['string', 'null']],
                'reasoning' => ['type' => 'string'],
            ],
            'required' => [
                'shopify_product_id',
                'suggested_title',
                'suggested_description_html',
                'suggested_collection_tag',
                'reasoning',
            ],
        ];
    }

    private function promptForModel(string $fallbackDefault): string
    {
        $availableModels = $this->discoverOllamaModels();
        if ($availableModels === []) {
            return $this->io->prompt('Ollama model', $fallbackDefault);
        }

        $defaultModel = in_array($fallbackDefault, $availableModels, true) ? $fallbackDefault : $availableModels[0];

        $this->io->write('Available Ollama models:');
        foreach ($availableModels as $index => $modelName) {
            $suffix = $modelName === $defaultModel ? ' (default)' : '';
            $this->io->write(sprintf('  %d. %s%s', $index + 1, $modelName, $suffix));
        }

        while (true) {
            $input = $this->io->prompt('Choose model by number or name', $defaultModel);
            if (ctype_digit($input)) {
                $selectedIndex = ((int) $input) - 1;
                if (isset($availableModels[$selectedIndex])) {
                    return $availableModels[$selectedIndex];
                }
            }

            if (in_array($input, $availableModels, true)) {
                return $input;
            }

            $this->io->error('Please choose a listed model number or exact model name.');
        }
    }

    /**
     * `ollama list` is the source of truth for what is actually installed on this machine.
     */
    private function discoverOllamaModels(): array
    {
        $output = shell_exec('ollama list 2>/dev/null');
        if (!is_string($output) || trim($output) === '') {
            return [];
        }

        $models = [];
        $lines = preg_split("/\r?\n/", trim($output)) ?: [];

        foreach ($lines as $lineIndex => $line) {
            if ($lineIndex === 0) {
                continue;
            }

            $trimmed = trim($line);
            if ($trimmed === '') {
                continue;
            }

            $parts = preg_split('/\s+/', $trimmed);
            $modelName = $parts[0] ?? '';
            if ($modelName !== '') {
                $models[] = $modelName;
            }
        }

        return array_values(array_unique($models));
    }

    /**
     * Collections are shared once per batch so the prompt stays stable while avoiding repeated taxonomy payloads.
     */
    private function buildBatchPrompt(array $products, array $knownCollectionTags, array $collectionsSummary): string
    {
        $batchProducts = [];

        foreach ($products as $product) {
            $candidateCollections = $this->candidateCollectionsForProduct($product, $collectionsSummary);

            $batchProducts[] = [
                'shopify_product_id' => $product['shopify_product_id'] ?? '',
                'title' => $product['title'] ?? '',
                'description_html' => $product['description_html'] ?? '',
                'vendor' => $product['vendor'] ?? null,
                'product_type' => $product['product_type'] ?? null,
                'candidate_collections' => $candidateCollections,
            ];
        }

        $promptPayload = [
            'instructions' => [
                'Review each Shopify product and standardise the merchandising copy.',
                'Keep the product truthful. Do not invent materials, sizes, features, or benefits.',
                'Ignore any current tags or existing taxonomy. Classify from scratch using only the product content and candidate collections provided.',
                'Return a clean, customer-facing title.',
                'Return a concise HTML description suitable for Shopify, using simple <p> and optional <ul><li> markup only.',
                'Choose the single best collection tag from that product\'s candidate_collections list. There must always be a choice of what you determine is best fit.',
                'Return one review object per input product.',
                'Use shopify_product_id to map each review back to its source product.',
            ],
            'products' => $batchProducts,
            'response_rules' => [
                'Respond only with JSON matching the provided schema.',
                'suggested_collection_tag must exactly match one of that product\'s candidate collection tags.',
                'Every input product must produce one output review.',
            ],
        ];

        return json_encode($promptPayload, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)
            ?: throw new RuntimeException('Unable to encode Ollama prompt payload.');
    }

    private function buildSingleProductPrompt(array $product, array $knownCollectionTags, array $collectionsSummary): string
    {
        $candidateCollections = $this->candidateCollectionsForProduct($product, $collectionsSummary);

        $promptPayload = [
            'instructions' => [
                'Review this single Shopify product and standardise the merchandising copy.',
                'Keep the product truthful. Do not invent materials, sizes, features, or benefits.',
                'Ignore any current tags or existing taxonomy. Classify from scratch using only the product content and candidate collections provided.',
                'Return a clean, customer-facing title.',
                'Return a concise HTML description suitable for Shopify, using simple <p> and optional <ul><li> markup only.',
                'Choose the single best collection tag from the candidate_collections list, or null if none fits.',
                'Return exactly one JSON object, not an array or wrapper object.',
                'Use the provided shopify_product_id unchanged.',
            ],
            'product' => [
                'shopify_product_id' => $product['shopify_product_id'] ?? '',
                'title' => $product['title'] ?? '',
                'description_html' => $product['description_html'] ?? '',
                'vendor' => $product['vendor'] ?? null,
                'product_type' => $product['product_type'] ?? null,
                'candidate_collections' => $candidateCollections,
            ],
            'response_rules' => [
                'Respond only with JSON matching the provided schema.',
                'suggested_collection_tag must exactly match one of the candidate collection tags or be null.',
            ],
        ];

        return json_encode($promptPayload, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)
            ?: throw new RuntimeException('Unable to encode Ollama prompt payload.');
    }

    private function buildCollectionsSummary(array $collections): array
    {
        return array_map(static function (array $collection): array {
            return [
                'title' => $collection['title'] ?? '',
                'tag' => $collection['tag'] ?? null,
                // Keep only a short text summary so the taxonomy is useful without bloating every batch prompt.
                'description' => mb_substr((string) ($collection['description'] ?? ''), 0, 240),
            ];
        }, $collections);
    }

    private function mapReviewedProduct(array $product, array $knownCollectionTags, array $reviewsByProductId, string $tagMode, bool $usedFallback): array
    {
        $productId = (string) ($product['shopify_product_id'] ?? '');
        $review = $reviewsByProductId[$productId] ?? [];
        $productTags = array_values(array_filter($product['tags'] ?? [], 'is_string'));
        $matchingCollectionTags = array_values(array_intersect($productTags, $knownCollectionTags));
        $currentCollectionTag = $matchingCollectionTags[0] ?? null;

        $suggestedCollectionTag = $review['suggested_collection_tag'] ?? null;
        if ($suggestedCollectionTag !== null && !in_array($suggestedCollectionTag, $knownCollectionTags, true)) {
            $suggestedCollectionTag = null;
        }

        $proposedTags = $tagMode === 'overwrite'
            ? CatalogHelper::buildOverwriteTags($productTags, $knownCollectionTags, $suggestedCollectionTag)
            : CatalogHelper::buildAppendTags($productTags, $suggestedCollectionTag);

        return [
            'shopify_gid' => $product['shopify_gid'] ?? null,
            'shopify_product_id' => $product['shopify_product_id'] ?? null,
            'original_title' => $product['title'] ?? '',
            'current_title' => (string) ($product['title'] ?? ''),
            'suggested_title' => trim((string) ($review['suggested_title'] ?? (string) ($product['title'] ?? ''))),
            'original_description_html' => $product['description_html'] ?? '',
            'current_description_html' => (string) ($product['description_html'] ?? ''),
            'suggested_description_html' => trim((string) ($review['suggested_description_html'] ?? (string) ($product['description_html'] ?? ''))),
            'original_tags' => $productTags,
            'current_collection_tag' => $currentCollectionTag,
            'suggested_collection_tag' => $suggestedCollectionTag,
            'proposed_tags' => $proposedTags,
            'tag_mode' => $tagMode,
            'reasoning' => trim((string) ($review['reasoning'] ?? '')),
            'used_fallback' => $usedFallback,
            'reviewed_at' => gmdate(DATE_ATOM),
        ];
    }

    private function loadExistingReviewPayload(string $path): ?array
    {
        if (!is_file($path)) {
            return null;
        }

        try {
            return $this->storage->read($path);
        } catch (RuntimeException $exception) {
            $this->io->error(sprintf('Existing review file could not be parsed, starting fresh: %s', $exception->getMessage()));

            return null;
        }
    }

    private function processedProductIds(array $results): array
    {
        $ids = [];
        foreach ($results as $result) {
            if (!is_array($result)) {
                continue;
            }

            $id = (string) ($result['shopify_product_id'] ?? '');
            if ($id !== '') {
                $ids[$id] = true;
            }
        }

        return $ids;
    }

    private function writeReviewPayload(
        string $outputPath,
        array $results,
        string $model,
        string $tagMode,
        int $limit,
        int $batchSize,
        string|int|null $keepAlive,
        bool $resume,
    ): void {
        $this->storage->write($outputPath, [
            'generated_at' => gmdate(DATE_ATOM),
            'model' => $model,
            'tag_mode' => $tagMode,
            'limit' => $limit,
            'batch_size' => $batchSize,
            'keep_alive' => $keepAlive,
            'resume_enabled' => $resume,
            'product_count' => count($results),
            'products' => $results,
        ]);
    }

    private function candidateCollectionsForProduct(array $product, array $collectionsSummary): array
    {
        $titleTokens = $this->meaningfulTokens((string) ($product['title'] ?? ''));
        $descriptionTokens = $this->meaningfulTokens((string) ($product['description_text'] ?? ''));
        $vendorTokens = $this->meaningfulTokens((string) ($product['vendor'] ?? ''));
        $productTypeTokens = $this->meaningfulTokens((string) ($product['product_type'] ?? ''));

        $scored = [];
        foreach ($collectionsSummary as $collection) {
            $tag = (string) ($collection['tag'] ?? '');
            if ($tag === '') {
                continue;
            }

            $score = 0;
            $collectionText = implode(' ', [
                (string) ($collection['title'] ?? ''),
                (string) ($collection['description'] ?? ''),
                $tag,
            ]);
            $collectionTokens = $this->meaningfulTokens($collectionText);
            $collectionTokenSet = array_flip($collectionTokens);

            foreach ($titleTokens as $token) {
                if (isset($collectionTokenSet[$token])) {
                    $score += 5;
                }
            }

            foreach ($productTypeTokens as $token) {
                if (isset($collectionTokenSet[$token])) {
                    $score += 4;
                }
            }

            foreach ($vendorTokens as $token) {
                if (isset($collectionTokenSet[$token])) {
                    $score += 1;
                }
            }

            foreach ($descriptionTokens as $token) {
                if (isset($collectionTokenSet[$token])) {
                    $score += 1;
                }
            }

            if ($score > 0) {
                $collection['score'] = $score;
                $scored[] = $collection;
            }
        }

        usort($scored, static fn (array $a, array $b): int => ($b['score'] <=> $a['score']));
        $shortlist = array_slice($scored, 0, 12);

        return array_map(static function (array $collection): array {
            return [
                'title' => $collection['title'] ?? '',
                'tag' => $collection['tag'] ?? null,
                'description' => $collection['description'] ?? '',
            ];
        }, $shortlist);
    }

    private function meaningfulTokens(string $text): array
    {
        $text = strtolower(strip_tags($text));
        preg_match_all('/[a-z0-9]+/i', $text, $matches);
        $tokens = $matches[0] ?? [];

        $stopwords = array_flip([
            'a', 'an', 'and', 'are', 'as', 'at', 'be', 'for', 'from', 'in', 'is', 'it', 'its',
            'of', 'on', 'or', 'that', 'the', 'their', 'this', 'to', 'use', 'with', 'you', 'your'
        ]);

        $filtered = [];
        foreach ($tokens as $token) {
            $token = strtolower((string) $token);
            if (strlen($token) < 3) {
                continue;
            }

            if (isset($stopwords[$token])) {
                continue;
            }

            $filtered[] = $token;
        }

        return array_values(array_unique($filtered));
    }

    private function indexBatchReviews(array $response, array $batch): array
    {
        $reviewsByProductId = [];

        foreach (($response['reviews'] ?? []) as $review) {
            $reviewKey = (string) ($review['shopify_product_id'] ?? '');
            if ($reviewKey !== '') {
                $reviewsByProductId[$reviewKey] = $review;
            }
        }

        $expectedIds = array_map(
            static fn (array $product): string => (string) ($product['shopify_product_id'] ?? ''),
            $batch
        );
        $expectedIds = array_values(array_filter($expectedIds, static fn (string $id): bool => $id !== ''));

        $missingIds = array_values(array_diff($expectedIds, array_keys($reviewsByProductId)));
        if ($missingIds !== []) {
            throw new RuntimeException(sprintf(
                'Batch response was incomplete. Missing reviews for product ids: %s',
                implode(', ', $missingIds)
            ));
        }

        return $reviewsByProductId;
    }

    private function reviewBatchOneByOne(
        array $batch,
        array $knownCollectionTags,
        array $collectionsSummary,
        OllamaClient $ollamaClient,
        string $model,
        string|int|null $keepAlive,
    ): array {
        $reviewsByProductId = [];

        foreach ($batch as $product) {
            $productId = (string) ($product['shopify_product_id'] ?? 'unknown');
            $this->io->write(sprintf('Retrying product %s individually.', $productId));

            try {
                $reviewsByProductId += $this->reviewSingleProductWithRetry(
                    $product,
                    $knownCollectionTags,
                    $collectionsSummary,
                    $ollamaClient,
                    $model,
                    $keepAlive,
                );
            } catch (RuntimeException $exception) {
                $this->io->error(sprintf(
                    'Single-product retry failed for %s: %s',
                    $productId,
                    $exception->getMessage()
                ));
            }
        }

        return $reviewsByProductId;
    }
}

EnvLoader::load(PROJECT_ROOT . '.env');

$options = CliOptions::parse($argv);
$command = new ReviewProductsWithOllamaCommand(new ConsoleIO(), new JsonStorage(), new HttpClient());

exit($command->run($options));
