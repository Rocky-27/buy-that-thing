#!/usr/bin/env php
<?php

declare(strict_types=1);

require __DIR__ . '/lib/bootstrap.php';

final class AvasamConfig
{
    public function __construct(
        public readonly string $baseUrl,
        public readonly string $consumerKey,
        public readonly string $secretKey,
    ) {
    }

    public static function fromEnv(): self
    {
        $consumerKey = self::env('AVASAM_CONSUMER_KEY');
        $secretKey = self::env('AVASAM_SECRET_KEY');

        if ($consumerKey === null || trim($consumerKey) === '' || $secretKey === null || trim($secretKey) === '') {
            throw new RuntimeException('AVASAM_CONSUMER_KEY and AVASAM_SECRET_KEY must be set in .env.');
        }

        $baseUrl = self::env('AVASAM_API_BASE_URL', 'https://app.avasam.com') ?? 'https://app.avasam.com';

        return new self(rtrim($baseUrl, '/'), trim($consumerKey), trim($secretKey));
    }

    private static function env(string $key, ?string $default = null): ?string
    {
        $value = getenv($key);

        return $value === false ? $default : $value;
    }
}

final class AvasamAccessTokenProvider
{
    private const CACHE_PATH = PROJECT_ROOT . 'storage/runtime/avasam-access-token.json';
    private ?array $resolvedToken = null;

    public function __construct(
        private readonly AvasamConfig $config,
        private readonly HttpClient $httpClient,
        private readonly JsonStorage $storage,
    ) {
    }

    public function getAccessToken(): string
    {
        return $this->resolveToken()['token'];
    }

    public function getClientId(): ?string
    {
        return $this->resolveToken()['client_id'];
    }

    public function getEndpointOverride(): ?string
    {
        return $this->resolveToken()['endpoint'];
    }

    private function resolveToken(): array
    {
        if ($this->resolvedToken !== null) {
            return $this->resolvedToken;
        }

        $cached = $this->loadCachedToken();
        if ($cached !== null) {
            return $this->resolvedToken = $cached;
        }

        return $this->resolvedToken = $this->requestAccessToken();
    }

    private function loadCachedToken(): ?array
    {
        if (!is_file(self::CACHE_PATH)) {
            return null;
        }

        try {
            $payload = $this->storage->read(self::CACHE_PATH);
        } catch (RuntimeException) {
            return null;
        }

        if (($payload['base_url'] ?? null) !== $this->config->baseUrl || ($payload['consumer_key'] ?? null) !== $this->config->consumerKey) {
            return null;
        }

        $token = trim((string) ($payload['token'] ?? ''));
        $expiresAt = strtotime((string) ($payload['expires_at'] ?? ''));

        if ($token === '' || $expiresAt === false || $expiresAt <= time() + 300) {
            return null;
        }

        return [
            'token' => $token,
            'client_id' => self::nullIfEmpty($payload['client_id'] ?? null),
            'endpoint' => self::nullIfEmpty($payload['endpoint'] ?? null),
        ];
    }

    private function requestAccessToken(): array
    {
        $response = $this->httpClient->postJson(
            $this->config->baseUrl . '/api/auth/request-token',
            ['Accept' => 'application/json'],
            [
                'consumer_key' => $this->config->consumerKey,
                'secret_key' => $this->config->secretKey,
            ],
        );

        $token = trim((string) ($response['access_token'] ?? $response['Token'] ?? ''));
        $expiresAtValue = (string) ($response['expires_at'] ?? $response['ExpiresAt'] ?? '');
        $expiresAt = strtotime($expiresAtValue);

        if ($token === '' || $expiresAt === false) {
            throw new RuntimeException('Avasam token response did not include a valid token and expiry.');
        }

        $payload = [
            'base_url' => $this->config->baseUrl,
            'consumer_key' => $this->config->consumerKey,
            'token' => $token,
            'client_id' => self::nullIfEmpty($response['ClientID'] ?? $response['client_id'] ?? $response['customerId'] ?? null),
            'endpoint' => self::nullIfEmpty($response['EndPoint'] ?? $response['endpoint'] ?? null),
            'expires_at' => gmdate(DATE_ATOM, $expiresAt),
            'generated_at' => gmdate(DATE_ATOM),
            'raw_response' => $response,
        ];

        $this->storage->write(self::CACHE_PATH, $payload);

        return [
            'token' => $payload['token'],
            'client_id' => $payload['client_id'],
            'endpoint' => $payload['endpoint'],
        ];
    }

    private static function nullIfEmpty(mixed $value): ?string
    {
        if (!is_string($value)) {
            return null;
        }

        $trimmed = trim($value);

        return $trimmed === '' ? null : $trimmed;
    }
}

final class AvasamClient
{
    public function __construct(
        private readonly AvasamConfig $config,
        private readonly AvasamAccessTokenProvider $accessTokenProvider,
        private readonly HttpClient $httpClient,
    ) {
    }

    public function fetchMappedProducts(int $limit, int $maxProducts = 0): array
    {
        $products = [];
        $seenNumbers = [];

        foreach ([
            [
                'mode' => 'single-and-parent',
                'payload' => [
                    'ProductType' => [],
                    'Supplier' => '',
                    'Sortby' => 'SKU',
                    'SortStatus' => 'down',
                    'limit' => $limit,
                    'PriceDelimeter' => '0',
                    'PriceValue' => 0,
                    'StockValue' => '0',
                    'Stock' => 0,
                    'Category' => '',
                    'CategoryName' => '',
                    'IsMapped' => 'Yes',
                    'PriceMaxValue' => 0,
                    'PriceMaxDelimeter' => '0',
                ],
            ],
            [
                'mode' => 'variation-child',
                'payload' => [
                    'ProductType' => [],
                    'Supplier' => '',
                    'Sortby' => 'SKU',
                    'SortStatus' => 'down',
                    'limit' => $limit,
                    'PriceDelimeter' => '0',
                    'PriceValue' => 0,
                    'StockValue' => '0',
                    'Stock' => 0,
                    'Variation' => 'true',
                    'Showchild' => 'true',
                    'Category' => '',
                    'CategoryName' => '',
                    'IsMapped' => 'Yes',
                    'PriceMaxValue' => 0,
                    'PriceMaxDelimeter' => '0',
                ],
            ],
        ] as $requestConfig) {
            $page = 0;

            do {
                $payload = $requestConfig['payload'];
                $payload['page'] = $page;
                $chunk = $this->post('/apiseeker/ProductModule/GetInventoryListWithFilter', $payload);
                $rows = $chunk['body']['data'] ?? $chunk['data'] ?? null;

                if (!is_array($rows)) {
                    throw new RuntimeException('Unexpected Avasam mapped inventory response shape.');
                }

                foreach ($rows as $row) {
                    if (!is_array($row)) {
                        continue;
                    }

                    $number = trim((string) ($row['Number'] ?? $row['SKU'] ?? ''));
                    $dedupeKey = $number !== '' ? $number : md5(json_encode($row, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) ?: '');

                    if (isset($seenNumbers[$dedupeKey])) {
                        continue;
                    }

                    $seenNumbers[$dedupeKey] = true;
                    $row['_pull_mode'] = $requestConfig['mode'];
                    $products[] = $row;

                    if ($maxProducts > 0 && count($products) >= $maxProducts) {
                        return $products;
                    }
                }

                $count = count($rows);
                $page++;
            } while ($count === $limit);
        }

        return $products;
    }

    private function post(string $path, array $payload): array
    {
        return $this->requestJson('POST', $path, $payload);
    }

    private function get(string $path): array
    {
        return $this->requestJson('GET', $path);
    }

    public function fetchProductDetailBySku(string $sku, int $level, string $currency, ?string $substatus): ?array
    {
        $query = [
            'SKU' => $sku,
            'authkey' => '',
            'level' => (string) $level,
            'currency' => $currency,
        ];

        if ($substatus !== null && trim($substatus) !== '') {
            $query['substatus'] = trim($substatus);
        }

        $response = $this->get('/apiseeker/SeekerProductModule/GetProductBySKU?' . http_build_query($query));
        $body = $response['body'] ?? null;

        return is_array($body) ? $body : null;
    }

    private function normalizeComparableString(mixed $value): string
    {
        if (!is_string($value) && !is_numeric($value)) {
            return '';
        }

        return trim((string) $value);
    }

    private function requestJson(string $method, string $path, ?array $payload = null): array
    {
        $baseUrl = $this->accessTokenProvider->getEndpointOverride() ?? $this->config->baseUrl;
        $token = $this->accessTokenProvider->getAccessToken();
        $clientId = $this->accessTokenProvider->getClientId();

        $headers = [
            'Accept' => 'application/json',
            'Authorization' => $token,
            'Token' => $token,
            'Authkey' => $token,
        ];

        if ($clientId !== null) {
            $headers['ClientID'] = $clientId;
        }

        return $this->requestJsonWithDiagnostics($method, rtrim($baseUrl, '/') . $path, $headers, $payload);
    }

    private function requestJsonWithDiagnostics(string $method, string $url, array $headers, ?array $payload = null): array
    {
        $ch = curl_init($url);
        if ($ch === false) {
            throw new RuntimeException('Unable to initialise cURL.');
        }

        $httpHeaders = ['Content-Type: application/json'];
        foreach ($headers as $name => $value) {
            $httpHeaders[] = "{$name}: {$value}";
        }

        $responseHeaders = [];
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CUSTOMREQUEST => strtoupper($method),
            CURLOPT_HTTPHEADER => $httpHeaders,
            CURLOPT_TIMEOUT => 120,
            CURLOPT_HEADERFUNCTION => static function ($curl, string $headerLine) use (&$responseHeaders): int {
                $trimmed = trim($headerLine);
                if ($trimmed !== '') {
                    $responseHeaders[] = $trimmed;
                }

                return strlen($headerLine);
            },
        ]);

        if ($payload !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
        }

        $body = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $error = curl_error($ch);
        curl_close($ch);

        if ($body === false) {
            throw new RuntimeException("Avasam HTTP request failed: {$error}");
        }

        $decoded = json_decode($body, true);
        if (!is_array($decoded)) {
            $headerDump = implode("\n", array_slice($responseHeaders, 0, 40));
            $bodyPreview = substr($body, 0, 2000);

            throw new RuntimeException(
                "Unexpected Avasam response from {$url}\n"
                . "Status: {$status}\n"
                . "Method: {$method}\n"
                . "Request headers: " . json_encode($headers, JSON_UNESCAPED_SLASHES) . "\n"
                . "Request body: " . json_encode($payload, JSON_UNESCAPED_SLASHES) . "\n"
                . "Response headers:\n{$headerDump}\n"
                . "Response body preview:\n{$bodyPreview}"
            );
        }

        if ($status >= 400) {
            throw new RuntimeException(
                "Avasam HTTP {$status} returned from {$url}: "
                . json_encode($decoded, JSON_UNESCAPED_SLASHES)
            );
        }

        return $decoded;
    }
}

final class AvasamPullLogger
{
    public function __construct(
        private readonly string $errorLogPath,
    ) {
    }

    public function log(string $level, string $message, array $context = []): void
    {
        $directory = dirname($this->errorLogPath);
        if (!is_dir($directory)) {
            mkdir($directory, 0777, true);
        }

        $payload = [
            'timestamp' => gmdate(DATE_ATOM),
            'level' => $level,
            'message' => $message,
            'context' => $context,
        ];

        file_put_contents(
            $this->errorLogPath,
            json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . PHP_EOL,
            FILE_APPEND
        );
    }
}

final class PullAvasamCatalogCommand
{
    public function __construct(
        private readonly ConsoleIO $io,
        private readonly AvasamClient $avasamClient,
        private readonly ShopifyClient $shopifyClient,
        private readonly JsonStorage $storage,
        private readonly string $shopDomain,
        private readonly string $avasamBaseUrl,
    ) {
    }

    public function run(array $options): int
    {
        $limit = isset($options['limit']) ? max(1, (int) $options['limit']) : (int) $this->io->prompt('Avasam page size', '250');
        $maxProducts = isset($options['max-products']) ? max(0, (int) $options['max-products']) : (int) $this->io->prompt('Maximum Avasam products to keep before Shopify filtering (0 = all)', '0');
        $collectionHandle = isset($options['shopify-collection-handle']) ? trim((string) $options['shopify-collection-handle']) : trim($this->io->prompt('Shopify collection handle filter (blank = all products)', ''));
        $collectionId = isset($options['shopify-collection-id']) ? trim((string) $options['shopify-collection-id']) : trim($this->io->prompt('Shopify collection id filter (blank = ignore)', ''));
        $vendorFilter = isset($options['shopify-vendor']) ? trim((string) $options['shopify-vendor']) : trim($this->io->prompt('Shopify vendor filter (blank = all vendors)', ''));
        $productTypeFilter = isset($options['shopify-product-type']) ? trim((string) $options['shopify-product-type']) : trim($this->io->prompt('Shopify product type filter (blank = all product types)', ''));
        $level = isset($options['level']) ? (int) $options['level'] : (int) $this->io->prompt('Avasam level for detail lookups', '0');
        $currency = isset($options['currency']) ? trim((string) $options['currency']) : trim($this->io->prompt('Avasam currency for detail lookups', 'GBP'));
        $substatusOption = isset($options['substatus']) ? trim((string) $options['substatus']) : trim($this->io->prompt('Avasam substatus for detail lookups (blank to skip)', ''));
        $substatus = $substatusOption === '' ? null : $substatusOption;
        $checkpointEvery = isset($options['checkpoint-every']) ? max(1, (int) $options['checkpoint-every']) : (int) $this->io->prompt('Checkpoint every N detailed products', '25');
        $resume = $this->resolveBoolOption($options, 'resume', true, 'Resume from checkpoint if available');
        $continueOnError = $this->resolveBoolOption($options, 'continue-on-error', true, 'Continue when an Avasam SKU fails');
        $retries = isset($options['retries']) ? max(1, (int) $options['retries']) : (int) $this->io->prompt('Retry attempts per failed SKU', '3');
        $retryDelayMs = isset($options['retry-delay-ms']) ? max(0, (int) $options['retry-delay-ms']) : (int) $this->io->prompt('Retry delay in ms', '1500');
        $rawOutputPath = isset($options['raw-output-path'])
            ? ProjectPath::resolve((string) $options['raw-output-path'])
            : ProjectPath::resolve($this->io->prompt('Avasam raw output path', 'storage/catalog/avasam-products.json'));
        $matchedOutputPath = isset($options['matched-output-path'])
            ? ProjectPath::resolve((string) $options['matched-output-path'])
            : ProjectPath::resolve($this->io->prompt('Avasam matched output path', 'storage/catalog/avasam-shopify-products.json'));
        $checkpointPath = isset($options['checkpoint-path'])
            ? ProjectPath::resolve((string) $options['checkpoint-path'])
            : ProjectPath::resolve($this->io->prompt('Avasam checkpoint path', 'storage/runtime/avasam-pull-progress.json'));
        $errorLogPath = isset($options['error-log-path'])
            ? ProjectPath::resolve((string) $options['error-log-path'])
            : ProjectPath::resolve($this->io->prompt('Avasam error log path', 'storage/logs/avasam-pull-errors.jsonl'));

        $logger = new AvasamPullLogger($errorLogPath);
        $runConfig = [
            'limit' => $limit,
            'max_products' => $maxProducts,
            'shopify_collection_handle' => $collectionHandle,
            'shopify_collection_id' => $collectionId,
            'shopify_vendor' => $vendorFilter,
            'shopify_product_type' => $productTypeFilter,
            'level' => $level,
            'currency' => $currency,
            'substatus' => $substatus,
            'raw_output_path' => $rawOutputPath,
            'matched_output_path' => $matchedOutputPath,
        ];

        $shopifyProducts = $this->fetchShopifyProducts($collectionHandle, $collectionId, $vendorFilter, $productTypeFilter);
        $shopifyLookup = $this->buildShopifyLookup($shopifyProducts);
        $mappedAvasamProducts = $this->avasamClient->fetchMappedProducts($limit, $maxProducts);
        $scopedMappedAvasamProducts = $this->filterAvasamProductsToShopify($mappedAvasamProducts, $shopifyLookup);

        $state = $resume
            ? $this->loadCheckpoint($checkpointPath, $runConfig)
            : $this->freshCheckpointState($runConfig);

        if (($state['status'] ?? '') === 'complete') {
            $this->io->write(sprintf(
                'Checkpoint already marked complete with %d detailed products. Rebuilding output files from checkpoint.',
                count($state['products_by_sku'] ?? [])
            ));
        }

        $pendingMappedProducts = $this->filterPendingMappedProducts($scopedMappedAvasamProducts, $state['products_by_sku'] ?? []);
        $this->io->write(sprintf(
            'Fetched %d mapped Avasam products, scoped %d to Shopify, loaded %d Shopify products, resumed %d detailed products, and have %d pending.',
            count($mappedAvasamProducts),
            count($scopedMappedAvasamProducts),
            count($shopifyProducts),
            count($state['products_by_sku'] ?? []),
            count($pendingMappedProducts)
        ));

        try {
            $processedSinceCheckpoint = 0;
            foreach ($pendingMappedProducts as $mappedProduct) {
                $sku = self::normalizeComparableString($mappedProduct['Number'] ?? $mappedProduct['SKU'] ?? '');
                if ($sku === '') {
                    continue;
                }

                try {
                    $detail = $this->fetchProductDetailWithRetry($sku, $level, $currency, $substatus, $retries, $retryDelayMs);
                    if ($detail === null) {
                        $this->recordSkuFailure($state, $sku, 'Avasam returned no detail body for SKU.', $mappedProduct, $logger);
                        if (!$continueOnError) {
                            throw new RuntimeException("Avasam returned no detail body for SKU {$sku}.");
                        }

                        continue;
                    }

                    $mergedProduct = $this->mergeMappedListingDataIntoSellerProduct($detail, [$mappedProduct]);
                    $state['products_by_sku'][$sku] = $mergedProduct;
                    $state['last_completed_sku'] = $sku;
                    $state['last_checkpoint_at'] = gmdate(DATE_ATOM);
                    $processedSinceCheckpoint++;
                } catch (Throwable $throwable) {
                    $this->recordSkuFailure($state, $sku, $throwable->getMessage(), $mappedProduct, $logger);

                    if (!$continueOnError) {
                        throw $throwable;
                    }
                }

                if ($processedSinceCheckpoint >= $checkpointEvery) {
                    $this->persistProgress(
                        $checkpointPath,
                        $rawOutputPath,
                        $matchedOutputPath,
                        $state,
                        $shopifyProducts,
                        count($mappedAvasamProducts),
                        count($scopedMappedAvasamProducts),
                        true
                    );
                    $this->io->write(sprintf(
                        'Checkpoint saved: %d detailed products complete, %d failures logged, %d pending.',
                        count($state['products_by_sku']),
                        count($state['failures']),
                        max(0, count($scopedMappedAvasamProducts) - count($state['products_by_sku']))
                    ));
                    $processedSinceCheckpoint = 0;
                }
            }

            $state['status'] = 'complete';
            $state['completed_at'] = gmdate(DATE_ATOM);

            $this->persistProgress(
                $checkpointPath,
                $rawOutputPath,
                $matchedOutputPath,
                $state,
                $shopifyProducts,
                count($mappedAvasamProducts),
                count($scopedMappedAvasamProducts),
                false
            );
        } catch (Throwable $throwable) {
            $state['status'] = 'failed';
            $state['fatal_error'] = [
                'message' => $throwable->getMessage(),
                'timestamp' => gmdate(DATE_ATOM),
            ];
            $logger->log('fatal', 'Avasam pull aborted before completion.', $state['fatal_error']);
            $this->persistProgress(
                $checkpointPath,
                $rawOutputPath,
                $matchedOutputPath,
                $state,
                $shopifyProducts,
                count($mappedAvasamProducts),
                count($scopedMappedAvasamProducts),
                true
            );

            throw $throwable;
        }

        $this->io->write(sprintf(
            'Saved Avasam raw catalog to %s and matched catalog to %s. Completed %d detailed products with %d failures logged.',
            $rawOutputPath,
            $matchedOutputPath,
            count($state['products_by_sku']),
            count($state['failures'])
        ));

        return 0;
    }

    private function resolveBoolOption(array $options, string $key, bool $default, string $prompt): bool
    {
        if (isset($options[$key])) {
            return filter_var($options[$key], FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE) ?? $default;
        }

        return $this->io->promptYesNo($prompt, $default);
    }

    private function freshCheckpointState(array $runConfig): array
    {
        return [
            'status' => 'running',
            'started_at' => gmdate(DATE_ATOM),
            'last_checkpoint_at' => null,
            'completed_at' => null,
            'run_config' => $runConfig,
            'products_by_sku' => [],
            'failures' => [],
            'last_completed_sku' => null,
            'fatal_error' => null,
        ];
    }

    private function loadCheckpoint(string $checkpointPath, array $runConfig): array
    {
        if (!is_file($checkpointPath)) {
            return $this->freshCheckpointState($runConfig);
        }

        try {
            $checkpoint = $this->storage->read($checkpointPath);
        } catch (RuntimeException) {
            return $this->freshCheckpointState($runConfig);
        }

        if (($checkpoint['run_config'] ?? null) !== $runConfig) {
            return $this->freshCheckpointState($runConfig);
        }

        $checkpoint['products_by_sku'] = is_array($checkpoint['products_by_sku'] ?? null) ? $checkpoint['products_by_sku'] : [];
        $checkpoint['failures'] = is_array($checkpoint['failures'] ?? null) ? $checkpoint['failures'] : [];

        return $checkpoint;
    }

    private function filterPendingMappedProducts(array $mappedProducts, array $completedProductsBySku): array
    {
        return array_values(array_filter($mappedProducts, static function (array $mappedProduct) use ($completedProductsBySku): bool {
            $sku = self::normalizeComparableString($mappedProduct['Number'] ?? $mappedProduct['SKU'] ?? '');

            return $sku !== '' && !isset($completedProductsBySku[$sku]);
        }));
    }

    private function fetchProductDetailWithRetry(string $sku, int $level, string $currency, ?string $substatus, int $retries, int $retryDelayMs): ?array
    {
        $attempt = 0;
        $lastException = null;

        while ($attempt < $retries) {
            try {
                return $this->avasamClient->fetchProductDetailBySku($sku, $level, $currency, $substatus);
            } catch (Throwable $throwable) {
                $lastException = $throwable;
                $attempt++;

                if ($attempt >= $retries) {
                    break;
                }

                usleep($retryDelayMs * 1000);
            }
        }

        throw new RuntimeException(
            sprintf('Failed to fetch SKU %s after %d attempt(s): %s', $sku, $retries, $lastException?->getMessage() ?? 'Unknown error'),
            previous: $lastException
        );
    }

    private function recordSkuFailure(array &$state, string $sku, string $message, array $mappedProduct, AvasamPullLogger $logger): void
    {
        $failure = [
            'sku' => $sku,
            'message' => $message,
            'timestamp' => gmdate(DATE_ATOM),
            'mapped_title' => (string) ($mappedProduct['Title'] ?? ''),
            'mapped_reference_id' => (string) (($mappedProduct['Listings'][0]['RefrenceId'] ?? $mappedProduct['Listings'][0]['ReferenceId'] ?? '')),
        ];

        $state['failures'][$sku] = $failure;
        $state['last_checkpoint_at'] = gmdate(DATE_ATOM);
        $logger->log('error', 'Failed to enrich Avasam SKU.', $failure);
    }

    private function persistProgress(
        string $checkpointPath,
        string $rawOutputPath,
        string $matchedOutputPath,
        array $state,
        array $shopifyProducts,
        int $mappedAvasamProductCount,
        int $scopedMappedAvasamProductCount,
        bool $isPartial
    ): void {
        $detailedProducts = array_values($state['products_by_sku']);
        $rawPayload = $this->buildRawPayload($detailedProducts, $mappedAvasamProductCount, $scopedMappedAvasamProductCount, $isPartial, count($state['failures']));
        $matchedPayload = $this->buildMatchedPayload($rawPayload['products'], $shopifyProducts, $isPartial, count($state['failures']));

        if ($isPartial) {
            $state['status'] = ($state['status'] ?? '') === 'failed' ? 'failed' : 'running';
        } else {
            $state['status'] = 'complete';
        }
        $state['raw_output_path'] = $rawOutputPath;
        $state['matched_output_path'] = $matchedOutputPath;
        $state['raw_product_count'] = $rawPayload['product_count'];
        $state['matched_product_count'] = $matchedPayload['matched_product_count'];
        $state['last_checkpoint_at'] = gmdate(DATE_ATOM);

        $this->storage->write($rawOutputPath, $rawPayload);
        $this->storage->write($matchedOutputPath, $matchedPayload);
        $this->storage->write($checkpointPath, $state);
    }

    private function buildRawPayload(
        array $avasamProducts,
        int $mappedAvasamProductCount,
        int $scopedMappedAvasamProductCount,
        bool $isPartial = false,
        int $failureCount = 0
    ): array
    {
        $normalizedProducts = array_map(fn (array $product): array => $this->normalizeAvasamProduct($product), $avasamProducts);

        return [
            'generated_at' => gmdate(DATE_ATOM),
            'source' => 'avasam',
            'source_endpoint' => 'SeekerProductModule/GetProductBySKU',
            'base_url' => $this->avasamBaseUrl,
            'is_partial' => $isPartial,
            'mapped_avasam_product_count' => $mappedAvasamProductCount,
            'scoped_mapped_avasam_product_count' => $scopedMappedAvasamProductCount,
            'product_count' => count($normalizedProducts),
            'failure_count' => $failureCount,
            'available_top_level_fields' => $this->collectTopLevelFields($avasamProducts),
            'available_extended_property_names' => $this->collectExtendedPropertyNames($normalizedProducts),
            'products' => $normalizedProducts,
        ];
    }

    private function buildMatchedPayload(array $avasamProducts, array $shopifyProducts, bool $isPartial = false, int $failureCount = 0): array
    {
        $shopifyVariantMap = $this->buildShopifyVariantMap($shopifyProducts);
        $matches = [];
        $matchedVariantIds = [];
        $unmatchedAvasamProducts = [];

        foreach ($avasamProducts as $product) {
            $match = $this->matchAvasamProduct($product, $shopifyVariantMap);
            if ($match === null) {
                $unmatchedAvasamProducts[] = [
                    'sku' => $product['sku'],
                    'barcode' => $product['barcode'],
                    'title' => $product['title'],
                ];

                continue;
            }

            $matchedVariantIds[$match['shopify_variant']['id']] = true;
            $matches[] = $match;
        }

        $unmatchedShopifyVariants = [];
        foreach ($shopifyProducts as $product) {
            foreach ($product['variants'] as $variant) {
                if (isset($matchedVariantIds[$variant['id']])) {
                    continue;
                }

                $unmatchedShopifyVariants[] = [
                    'shopify_product_id' => $product['shopify_product_id'],
                    'shopify_variant_id' => $variant['shopify_variant_id'],
                    'product_title' => $product['title'],
                    'variant_title' => $variant['title'],
                    'sku' => $variant['sku'],
                    'barcode' => $variant['barcode'],
                ];
            }
        }

        return [
            'generated_at' => gmdate(DATE_ATOM),
            'shop_domain' => $this->shopDomain,
            'is_partial' => $isPartial,
            'match_priority' => ['sku', 'barcode'],
            'avasam_product_count' => count($avasamProducts),
            'shopify_product_count' => count($shopifyProducts),
            'shopify_variant_count' => array_sum(array_map(static fn (array $product): int => count($product['variants']), $shopifyProducts)),
            'matched_product_count' => count($matches),
            'unmatched_avasam_product_count' => count($unmatchedAvasamProducts),
            'unmatched_shopify_variant_count' => count($unmatchedShopifyVariants),
            'failure_count' => $failureCount,
            'matches' => $matches,
            'unmatched_avasam_products' => $unmatchedAvasamProducts,
            'unmatched_shopify_variants' => $unmatchedShopifyVariants,
        ];
    }

    private function fetchShopifyProducts(
        string $collectionHandle = '',
        string $collectionId = '',
        string $vendorFilter = '',
        string $productTypeFilter = ''
    ): array
    {
        $nodes = $collectionHandle !== '' || $collectionId !== ''
            ? $this->fetchProductsForCollection($collectionHandle, $collectionId)
            : $this->shopifyClient->fetchAllNodes(
                'products',
                <<<'GRAPHQL'
id
legacyResourceId
handle
title
vendor
status
tags
variants(first: 100) {
  nodes {
    id
    legacyResourceId
    sku
    barcode
    title
    price
    compareAtPrice
    selectedOptions {
      name
      value
    }
  }
}
GRAPHQL
            );

        $products = array_map(static function (array $product): array {
            return [
                'id' => (string) $product['id'],
                'shopify_product_id' => (string) ($product['legacyResourceId'] ?? ''),
                'handle' => (string) ($product['handle'] ?? ''),
                'title' => (string) ($product['title'] ?? ''),
                'vendor' => (string) ($product['vendor'] ?? ''),
                'product_type' => (string) ($product['productType'] ?? ''),
                'status' => (string) ($product['status'] ?? ''),
                'tags' => array_values(array_filter($product['tags'] ?? [], 'is_string')),
                'variants' => array_map(static function (array $variant): array {
                    return [
                        'id' => (string) $variant['id'],
                        'shopify_variant_id' => (string) ($variant['legacyResourceId'] ?? ''),
                        'sku' => self::normalizeComparableString($variant['sku'] ?? ''),
                        'barcode' => self::normalizeComparableString($variant['barcode'] ?? ''),
                        'title' => (string) ($variant['title'] ?? ''),
                        'price' => $variant['price'] ?? null,
                        'compare_at_price' => $variant['compareAtPrice'] ?? null,
                        'selected_options' => array_map(static fn (array $option): array => [
                            'name' => (string) ($option['name'] ?? ''),
                            'value' => (string) ($option['value'] ?? ''),
                        ], $variant['selectedOptions']['nodes'] ?? $variant['selectedOptions'] ?? []),
                    ];
                }, $product['variants']['nodes'] ?? []),
            ];
        }, $nodes);

        return array_values(array_filter($products, static function (array $product) use ($vendorFilter, $productTypeFilter): bool {
            if ($vendorFilter !== '' && strcasecmp((string) ($product['vendor'] ?? ''), $vendorFilter) !== 0) {
                return false;
            }

            if ($productTypeFilter !== '' && strcasecmp((string) ($product['product_type'] ?? ''), $productTypeFilter) !== 0) {
                return false;
            }

            return true;
        }));
    }

    private function fetchProductsForCollection(string $collectionHandle, string $collectionId): array
    {
        $resolvedCollectionId = $this->resolveCollectionGid($collectionHandle, $collectionId);
        $nodes = [];
        $cursor = null;

        do {
            $data = $this->shopifyClient->graphql(
                <<<'GRAPHQL'
query FetchCollectionProducts($id: ID!, $after: String) {
  node(id: $id) {
    ... on Collection {
      id
      legacyResourceId
      handle
      title
      products(first: 100, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          legacyResourceId
          handle
          title
          vendor
          productType
          status
          tags
          variants(first: 100) {
            nodes {
              id
              legacyResourceId
              sku
              barcode
              title
              price
              compareAtPrice
              selectedOptions {
                name
                value
              }
            }
          }
        }
      }
    }
  }
}
GRAPHQL,
                [
                    'id' => $resolvedCollectionId,
                    'after' => $cursor,
                ]
            );

            $collection = $data['node'] ?? null;
            if (!is_array($collection)) {
                throw new RuntimeException('Unable to load Shopify collection products.');
            }

            $connection = $collection['products'] ?? null;
            if (!is_array($connection)) {
                throw new RuntimeException('Missing Shopify collection products connection.');
            }

            $nodes = array_merge($nodes, $connection['nodes'] ?? []);
            $cursor = $connection['pageInfo']['endCursor'] ?? null;
            $hasNextPage = (bool) ($connection['pageInfo']['hasNextPage'] ?? false);
        } while ($hasNextPage);

        return $nodes;
    }

    private function resolveCollectionGid(string $collectionHandle, string $collectionId): string
    {
        if ($collectionId !== '') {
            if (str_starts_with($collectionId, 'gid://')) {
                return $collectionId;
            }

            return 'gid://shopify/Collection/' . $collectionId;
        }

        if ($collectionHandle === '') {
            throw new RuntimeException('Collection handle or collection id is required.');
        }

        $data = $this->shopifyClient->graphql(
            <<<'GRAPHQL'
query ResolveCollection($query: String!) {
  collections(first: 1, query: $query) {
    nodes {
      id
      legacyResourceId
      handle
      title
    }
  }
}
GRAPHQL,
            [
                'query' => 'handle:' . $collectionHandle,
            ]
        );

        $collection = $data['collections']['nodes'][0] ?? null;
        if (!is_array($collection)) {
            throw new RuntimeException(sprintf('Shopify collection handle "%s" was not found.', $collectionHandle));
        }

        return (string) $collection['id'];
    }

    private function buildShopifyLookup(array $shopifyProducts): array
    {
        $lookup = [
            'sku' => [],
            'barcode' => [],
        ];

        foreach ($shopifyProducts as $product) {
            foreach ($product['variants'] as $variant) {
                if ($variant['sku'] !== '') {
                    $lookup['sku'][$variant['sku']] = true;
                }

                if ($variant['barcode'] !== '') {
                    $lookup['barcode'][$variant['barcode']] = true;
                }
            }
        }

        return $lookup;
    }

    private function filterAvasamProductsToShopify(array $avasamProducts, array $shopifyLookup): array
    {
        return array_values(array_filter($avasamProducts, static function (array $product) use ($shopifyLookup): bool {
            $sku = self::normalizeComparableString($product['Number'] ?? $product['SKU'] ?? '');
            $barcode = self::normalizeComparableString($product['BarCode'] ?? $product['Barcode'] ?? '');

            return ($sku !== '' && isset($shopifyLookup['sku'][$sku]))
                || ($barcode !== '' && isset($shopifyLookup['barcode'][$barcode]));
        }));
    }

    private function mergeMappedListingDataIntoSellerProduct(array $sellerProduct, array $mappedProducts): array
    {
        $feed = is_array($sellerProduct['Feed'] ?? null) ? $sellerProduct['Feed'] : [];
        $sku = self::normalizeComparableString($sellerProduct['SKU'] ?? $feed['SKU'] ?? '');
        $barcode = self::normalizeComparableString($sellerProduct['BarCode'] ?? $sellerProduct['Barcode'] ?? $feed['Barcodes'][0] ?? '');

        foreach ($mappedProducts as $mappedProduct) {
            $mappedSku = self::normalizeComparableString($mappedProduct['Number'] ?? $mappedProduct['SKU'] ?? '');
            $mappedBarcode = self::normalizeComparableString($mappedProduct['BarCode'] ?? $mappedProduct['Barcode'] ?? '');

            if (($sku !== '' && $sku === $mappedSku) || ($barcode !== '' && $barcode === $mappedBarcode)) {
                $sellerProduct['Listings'] = $mappedProduct['Listings'] ?? ($sellerProduct['Listings'] ?? []);
                $sellerProduct['isMapped'] = $mappedProduct['isMapped'] ?? ($sellerProduct['isMapped'] ?? null);
                $sellerProduct['ListingStatus'] = $mappedProduct['ListingStatus'] ?? ($sellerProduct['ListingStatus'] ?? null);
                $sellerProduct['_pull_mode'] = $mappedProduct['_pull_mode'] ?? null;
                $sellerProduct['_mapped_inventory_row'] = $mappedProduct;

                return $sellerProduct;
            }
        }

        return $sellerProduct;
    }

    private function normalizeAvasamProduct(array $product): array
    {
        $feed = is_array($product['Feed'] ?? null) ? $product['Feed'] : [];
        $images = $feed['Images'] ?? $product['ProductImage'] ?? [];
        if (is_string($images) && $images !== '') {
            $images = [$images];
        }
        $images = array_values(array_filter(is_array($images) ? $images : [], 'is_string'));
        $extendedProperties = array_map(static function (array $property): array {
            return [
                'name' => (string) ($property['Name'] ?? ''),
                'value' => is_scalar($property['Value'] ?? null) ? (string) $property['Value'] : json_encode($property['Value'], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
            ];
        }, array_values(array_filter(is_array($feed['MetaData'] ?? null) ? $feed['MetaData'] : [], 'is_array')));
        $listings = array_map(static function (array $listing): array {
            return [
                'channel' => (string) ($listing['Channel'] ?? ''),
                'account' => (string) ($listing['Account'] ?? ''),
                'status' => (string) ($listing['Status'] ?? ''),
                'reference_id' => (string) ($listing['RefrenceId'] ?? $listing['ReferenceId'] ?? ''),
                'error' => is_array($listing['Error'] ?? null) ? $listing['Error'] : [],
            ];
        }, array_values(array_filter(is_array($product['Listings'] ?? null) ? $product['Listings'] : [], 'is_array')));

        return [
            'sku' => self::normalizeComparableString($product['SKU'] ?? $feed['SKU'] ?? $product['Number'] ?? ''),
            'raw_sku' => (string) ($product['SKU'] ?? $feed['SKU'] ?? $product['Number'] ?? ''),
            'title' => (string) ($product['Title'] ?? $feed['Title']['en'] ?? ''),
            'description' => (string) ($product['Description'] ?? $feed['LongDescription']['en'] ?? $product['description'] ?? ''),
            'short_description' => (string) ($feed['ShortDescription']['en'] ?? ''),
            'detailed_specs' => (string) ($feed['DetailedSpecs']['en'] ?? ''),
            'multi_title' => is_array($product['MultiTitle'] ?? $feed['Title'] ?? null) ? ($product['MultiTitle'] ?? $feed['Title']) : null,
            'multi_description' => is_array($product['MultiDescription'] ?? $feed['LongDescription'] ?? null) ? ($product['MultiDescription'] ?? $feed['LongDescription']) : null,
            'price' => $product['Price'] ?? $product['OriginalPrice'] ?? $feed['CostPrice'] ?? null,
            'retail_price' => $product['RetailPrice'] ?? $feed['RRPExVAT'] ?? null,
            'vat' => $product['Vat'] ?? $product['VATPercentage'] ?? $feed['VATPercentage'] ?? null,
            'customer_group' => (string) ($product['CustomerGroup'] ?? ''),
            'barcode' => self::normalizeComparableString($product['BarCode'] ?? $product['Barcode'] ?? $feed['Barcodes'][0] ?? ''),
            'raw_barcode' => is_array($feed['Barcodes'] ?? null) ? implode(',', array_map('strval', $feed['Barcodes'])) : (string) ($product['BarCode'] ?? $product['Barcode'] ?? ''),
            'category' => (string) ($product['Category'] ?? ''),
            'category_id' => (string) ($product['CategoryId'] ?? $feed['CategoryId'] ?? ''),
            'brand' => (string) ($feed['Brand'] ?? ''),
            'mpn' => (string) ($feed['MPN'] ?? ''),
            'model' => (string) ($feed['Model'] ?? ''),
            'source' => (string) ($feed['Source'] ?? ''),
            'minimum_level' => $product['MinimumLevel'] ?? null,
            'stock' => $product['Stock'] ?? $feed['TotalQuantity'] ?? null,
            'product_depth' => $product['ProductDepth'] ?? $feed['ProductDepth'] ?? null,
            'product_height' => $feed['ProductHeight'] ?? null,
            'product_weight' => $product['ProductWeight'] ?? $feed['ProductWeight'] ?? null,
            'product_width' => $product['ProductWidth'] ?? $feed['ProductWidth'] ?? null,
            'package_depth' => $feed['PackageDepth'] ?? null,
            'package_height' => $feed['PackageHeight'] ?? null,
            'package_weight' => $feed['PackageWeight'] ?? null,
            'package_width' => $feed['PackageWidth'] ?? null,
            'colour' => (string) ($feed['Colour'] ?? ''),
            'size' => (string) ($feed['Size'] ?? ''),
            'height' => $product['Height'] ?? null,
            'image' => (string) ($product['Image'] ?? $product['image'] ?? $feed['MainImage'] ?? ''),
            'product_images' => $images,
            'pdf_url' => (string) ($feed['PDFURL'] ?? ''),
            'manufacturer_url' => (string) ($feed['ManufacturerURL'] ?? ''),
            'video_link' => (string) ($feed['VideoLink'] ?? ''),
            'extended_properties' => $extendedProperties,
            'is_variation' => (bool) ($product['IsVariation'] ?? $product['HasVariations'] ?? $feed['HasVariations'] ?? false),
            'parent_sku' => (string) ($product['ParentSKU'] ?? $feed['ParentSKU'] ?? ''),
            'variations' => is_array($product['Variations'] ?? null) ? $product['Variations'] : null,
            'listings' => $listings,
            'listing_status' => (string) ($product['ListingStatus'] ?? ''),
            'is_mapped' => (bool) ($product['isMapped'] ?? false),
            'pull_mode' => (string) ($product['_pull_mode'] ?? ''),
            'raw' => $product,
        ];
    }

    private function collectTopLevelFields(array $products): array
    {
        $fields = [];

        foreach ($products as $product) {
            foreach (array_keys($product) as $field) {
                $fields[$field] = true;
            }
        }

        $fieldNames = array_keys($fields);
        sort($fieldNames);

        return $fieldNames;
    }

    private function collectExtendedPropertyNames(array $products): array
    {
        $fields = [];

        foreach ($products as $product) {
            foreach ($product['extended_properties'] as $property) {
                $name = trim((string) ($property['name'] ?? ''));
                if ($name !== '') {
                    $fields[$name] = true;
                }
            }
        }

        $names = array_keys($fields);
        sort($names, SORT_NATURAL | SORT_FLAG_CASE);

        return $names;
    }

    private function buildShopifyVariantMap(array $shopifyProducts): array
    {
        $map = [
            'sku' => [],
            'barcode' => [],
        ];

        foreach ($shopifyProducts as $product) {
            foreach ($product['variants'] as $variant) {
                $entry = [
                    'shopify_product' => [
                        'id' => $product['id'],
                        'shopify_product_id' => $product['shopify_product_id'],
                        'handle' => $product['handle'],
                        'title' => $product['title'],
                        'vendor' => $product['vendor'],
                        'status' => $product['status'],
                        'tags' => $product['tags'],
                    ],
                    'shopify_variant' => $variant,
                ];

                if ($variant['sku'] !== '') {
                    $map['sku'][$variant['sku']][] = $entry;
                }

                if ($variant['barcode'] !== '') {
                    $map['barcode'][$variant['barcode']][] = $entry;
                }
            }
        }

        return $map;
    }

    private function matchAvasamProduct(array $product, array $shopifyVariantMap): ?array
    {
        foreach (['sku', 'barcode'] as $matchType) {
            $value = $product[$matchType];
            if ($value === '') {
                continue;
            }

            $matches = $shopifyVariantMap[$matchType][$value] ?? [];
            if (count($matches) !== 1) {
                continue;
            }

            return [
                'match_type' => $matchType,
                'match_value' => $value,
                'shopify_product' => $matches[0]['shopify_product'],
                'shopify_variant' => $matches[0]['shopify_variant'],
                'avasam_product' => $product,
            ];
        }

        return null;
    }

    private static function normalizeComparableString(mixed $value): string
    {
        if (!is_string($value) && !is_numeric($value)) {
            return '';
        }

        return trim((string) $value);
    }
}

EnvLoader::load(PROJECT_ROOT . '.env');

$options = CliOptions::parse($argv);
$io = new ConsoleIO();
$storage = new JsonStorage();
$httpClient = new HttpClient();
$shopifyConfig = ShopifyConfig::fromEnv();
$shopifyAccessTokenProvider = new ShopifyAccessTokenProvider($shopifyConfig, $httpClient, $storage);
$shopifyClient = new ShopifyClient($shopifyConfig, $shopifyAccessTokenProvider, $httpClient);
$avasamConfig = AvasamConfig::fromEnv();
$avasamAccessTokenProvider = new AvasamAccessTokenProvider($avasamConfig, $httpClient, $storage);
$avasamClient = new AvasamClient($avasamConfig, $avasamAccessTokenProvider, $httpClient);
$command = new PullAvasamCatalogCommand($io, $avasamClient, $shopifyClient, $storage, $shopifyConfig->shopDomain, $avasamConfig->baseUrl);

try {
    exit($command->run($options));
} catch (Throwable $throwable) {
    $io->error('Avasam pull failed: ' . $throwable->getMessage());

    exit(1);
}
