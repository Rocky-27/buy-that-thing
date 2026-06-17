<?php

declare(strict_types=1);

const PROJECT_ROOT = __DIR__ . '/../../';

final class EnvLoader
{
    public static function load(string $path): void
    {
        if (!is_file($path)) {
            return;
        }

        $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        if ($lines === false) {
            throw new RuntimeException("Unable to read env file: {$path}");
        }

        foreach ($lines as $line) {
            $trimmed = trim($line);
            if ($trimmed === '' || str_starts_with($trimmed, '#')) {
                continue;
            }

            [$name, $value] = array_pad(explode('=', $line, 2), 2, '');
            $name = trim($name);
            $value = trim($value);

            if ($name === '' || getenv($name) !== false) {
                continue;
            }

            putenv(sprintf('%s=%s', $name, $value));
            $_ENV[$name] = $value;
            $_SERVER[$name] = $value;
        }
    }
}

final class CliOptions
{
    public static function parse(array $argv): array
    {
        $options = [];

        foreach (array_slice($argv, 1) as $arg) {
            if (!str_starts_with($arg, '--')) {
                continue;
            }

            $arg = substr($arg, 2);
            [$key, $value] = array_pad(explode('=', $arg, 2), 2, 'true');
            $options[$key] = $value;
        }

        return $options;
    }
}

final class ConsoleIO
{
    public function prompt(string $label, ?string $default = null): string
    {
        $suffix = ($default !== null && $default !== '') ? " [{$default}]" : '';
        $input = readline($label . $suffix . ': ');
        $input = trim((string) $input);

        if ($input === '' && $default !== null) {
            return $default;
        }

        return $input;
    }

    public function promptYesNo(string $label, bool $default = true): bool
    {
        $defaultLabel = $default ? 'Y/n' : 'y/N';

        while (true) {
            $input = strtolower($this->prompt("{$label} ({$defaultLabel})", ''));
            if ($input === '') {
                return $default;
            }

            if (in_array($input, ['y', 'yes'], true)) {
                return true;
            }

            if (in_array($input, ['n', 'no'], true)) {
                return false;
            }

            $this->error('Please answer yes or no.');
        }
    }

    public function promptChoice(string $label, array $choices, string $default): string
    {
        $choiceList = implode('/', $choices);

        while (true) {
            $value = $this->prompt("{$label} ({$choiceList})", $default);
            if (in_array($value, $choices, true)) {
                return $value;
            }

            $this->error(sprintf('Please choose one of: %s', $choiceList));
        }
    }

    public function write(string $message): void
    {
        fwrite(STDOUT, $message . PHP_EOL);
    }

    public function error(string $message): void
    {
        fwrite(STDERR, $message . PHP_EOL);
    }
}

final class ProjectPath
{
    public static function resolve(string $path): string
    {
        if ($path === '') {
            return PROJECT_ROOT;
        }

        if (str_starts_with($path, '/')) {
            return $path;
        }

        return PROJECT_ROOT . ltrim($path, '/');
    }
}

final class JsonStorage
{
    public function read(string $path): array
    {
        if (!is_file($path)) {
            throw new RuntimeException("JSON file not found: {$path}");
        }

        $content = file_get_contents($path);
        if ($content === false) {
            throw new RuntimeException("Unable to read file: {$path}");
        }

        $decoded = json_decode($content, true);
        if (!is_array($decoded)) {
            throw new RuntimeException("Invalid JSON in file: {$path}");
        }

        return $decoded;
    }

    public function write(string $path, mixed $data): void
    {
        $this->ensureDirectory(dirname($path));
        $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

        if ($json === false) {
            throw new RuntimeException('Unable to encode JSON output.');
        }

        if (file_put_contents($path, $json . PHP_EOL) === false) {
            throw new RuntimeException("Unable to write file: {$path}");
        }
    }

    private function ensureDirectory(string $path): void
    {
        if (is_dir($path)) {
            return;
        }

        if (!mkdir($path, 0777, true) && !is_dir($path)) {
            throw new RuntimeException("Unable to create directory: {$path}");
        }
    }
}

final class HttpClient
{
    public function postJson(string $url, array $headers = [], ?array $payload = null): array
    {
        return $this->request('POST', $url, $headers, $payload !== null ? json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) : null, 'application/json');
    }

    public function postForm(string $url, array $headers = [], array $payload = []): array
    {
        return $this->request('POST', $url, $headers, http_build_query($payload), 'application/x-www-form-urlencoded');
    }

    private function request(string $method, string $url, array $headers, ?string $body, string $contentType): array
    {
        $ch = curl_init($url);
        if ($ch === false) {
            throw new RuntimeException('Unable to initialise cURL.');
        }

        $httpHeaders = ["Content-Type: {$contentType}"];
        foreach ($headers as $name => $value) {
            $httpHeaders[] = "{$name}: {$value}";
        }

        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CUSTOMREQUEST => strtoupper($method),
            CURLOPT_HTTPHEADER => $httpHeaders,
            CURLOPT_TIMEOUT => 120,
        ]);

        if ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }

        $body = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $error = curl_error($ch);
        curl_close($ch);

        if ($body === false) {
            throw new RuntimeException("HTTP request failed: {$error}");
        }

        $decoded = json_decode($body, true);
        if (!is_array($decoded)) {
            throw new RuntimeException("Unexpected JSON response from {$url}: {$body}");
        }

        if ($status >= 400) {
            throw new RuntimeException("HTTP {$status} returned from {$url}: {$body}");
        }

        return $decoded;
    }
}

final class ShopifyConfig
{
    public function __construct(
        public readonly string $shopDomain,
        public readonly string $apiVersion,
        public readonly ?string $adminAccessToken,
        public readonly ?string $clientId,
        public readonly ?string $clientSecret,
    ) {
    }

    public static function fromEnv(): self
    {
        $shopDomain = self::env('SHOPIFY_SHOP_DOMAIN');
        if ($shopDomain === null || $shopDomain === '') {
            throw new RuntimeException('SHOPIFY_SHOP_DOMAIN must be set in .env.');
        }

        return new self(
            $shopDomain,
            self::env('SHOPIFY_API_VERSION', '2025-10') ?? '2025-10',
            self::nullIfEmpty(self::env('SHOPIFY_ADMIN_ACCESS_TOKEN')),
            self::nullIfEmpty(self::env('SHOPIFY_CLIENT_ID')),
            self::nullIfEmpty(self::env('SHOPIFY_CLIENT_SECRET')),
        );
    }

    private static function env(string $key, ?string $default = null): ?string
    {
        $value = getenv($key);

        return $value === false ? $default : $value;
    }

    private static function nullIfEmpty(?string $value): ?string
    {
        return $value === null || trim($value) === '' ? null : trim($value);
    }
}

final class ShopifyAccessTokenProvider
{
    private const CACHE_PATH = PROJECT_ROOT . 'storage/runtime/shopify-access-token.json';

    public function __construct(
        private readonly ShopifyConfig $config,
        private readonly HttpClient $httpClient,
        private readonly JsonStorage $storage,
    ) {
    }

    public function getAccessToken(): string
    {
        if ($this->config->adminAccessToken !== null) {
            return $this->config->adminAccessToken;
        }

        $cachedToken = $this->loadCachedToken();
        if ($cachedToken !== null) {
            return $cachedToken;
        }

        if ($this->config->clientId === null || $this->config->clientSecret === null) {
            throw new RuntimeException(
                'Shopify credentials are incomplete. Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET for Dev Dashboard apps, or provide SHOPIFY_ADMIN_ACCESS_TOKEN for a legacy admin-created app.'
            );
        }

        return $this->requestClientCredentialsToken();
    }

    private function loadCachedToken(): ?string
    {
        if (!is_file(self::CACHE_PATH)) {
            return null;
        }

        try {
            $payload = $this->storage->read(self::CACHE_PATH);
        } catch (RuntimeException) {
            return null;
        }

        if (($payload['shop_domain'] ?? null) !== $this->config->shopDomain) {
            return null;
        }

        $token = $payload['access_token'] ?? null;
        $expiresAt = strtotime((string) ($payload['expires_at'] ?? ''));
        if (!is_string($token) || $token === '' || $expiresAt === false) {
            return null;
        }

        // Refresh slightly early so long-running jobs do not start on an almost-expired token.
        if ($expiresAt <= time() + 300) {
            return null;
        }

        return $token;
    }

    private function requestClientCredentialsToken(): string
    {
        $response = $this->httpClient->postForm(
            sprintf('https://%s/admin/oauth/access_token', $this->config->shopDomain),
            ['Accept' => 'application/json'],
            [
                'grant_type' => 'client_credentials',
                'client_id' => $this->config->clientId,
                'client_secret' => $this->config->clientSecret,
            ],
        );

        $accessToken = trim((string) ($response['access_token'] ?? ''));
        $expiresIn = (int) ($response['expires_in'] ?? 0);

        if ($accessToken === '' || $expiresIn <= 0) {
            throw new RuntimeException('Shopify token response did not include a valid access_token and expires_in.');
        }

        $this->storage->write(self::CACHE_PATH, [
            'shop_domain' => $this->config->shopDomain,
            'access_token' => $accessToken,
            'scope' => $response['scope'] ?? null,
            'expires_at' => gmdate(DATE_ATOM, time() + $expiresIn),
            'generated_at' => gmdate(DATE_ATOM),
        ]);

        return $accessToken;
    }
}

final class ShopifyClient
{
    public function __construct(
        private readonly ShopifyConfig $config,
        private readonly ShopifyAccessTokenProvider $accessTokenProvider,
        private readonly HttpClient $httpClient,
    ) {
    }

    public function graphql(string $query, array $variables = []): array
    {
        $url = sprintf('https://%s/admin/api/%s/graphql.json', $this->config->shopDomain, $this->config->apiVersion);
        $response = $this->httpClient->postJson($url, [
            'X-Shopify-Access-Token' => $this->accessTokenProvider->getAccessToken(),
        ], [
            'query' => $query,
            'variables' => $variables === [] ? (object) [] : $variables,
        ]);

        if (!empty($response['errors'])) {
            throw new RuntimeException('Shopify GraphQL errors: ' . json_encode($response['errors'], JSON_UNESCAPED_SLASHES));
        }

        return $response['data'] ?? [];
    }

    public function fetchAllNodes(string $rootField, string $queryBody): array
    {
        $items = [];
        $cursor = null;

        do {
            $query = <<<GRAPHQL
query FetchPage(\$after: String) {
  {$rootField}(first: 100, after: \$after) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      {$queryBody}
    }
  }
}
GRAPHQL;

            $data = $this->graphql($query, ['after' => $cursor]);
            $connection = $data[$rootField] ?? null;
            if (!is_array($connection)) {
                throw new RuntimeException("Missing {$rootField} connection in Shopify response.");
            }

            $items = array_merge($items, $connection['nodes'] ?? []);
            $cursor = $connection['pageInfo']['endCursor'] ?? null;
            $hasNextPage = (bool) ($connection['pageInfo']['hasNextPage'] ?? false);
        } while ($hasNextPage);

        return $items;
    }
}

final class CatalogHelper
{
    public static function normalizeHtmlToText(?string $html): string
    {
        $text = html_entity_decode(strip_tags((string) $html), ENT_QUOTES | ENT_HTML5);
        $text = preg_replace('/\s+/', ' ', $text);

        return trim((string) $text);
    }

    public static function extractCollectionTag(array $collection): ?string
    {
        $rules = $collection['ruleSet']['rules'] ?? [];
        if (!is_array($rules)) {
            return null;
        }

        foreach ($rules as $rule) {
            $column = strtolower((string) ($rule['column'] ?? ''));
            if (str_contains($column, 'tag')) {
                $condition = trim((string) ($rule['condition'] ?? ''));

                return $condition !== '' ? $condition : null;
            }
        }

        return null;
    }

    public static function collectionTags(array $collections): array
    {
        $tags = [];

        foreach ($collections as $collection) {
            $tag = trim((string) ($collection['tag'] ?? ''));
            if ($tag !== '') {
                $tags[] = $tag;
            }
        }

        return array_values(array_unique($tags));
    }

    public static function buildOverwriteTags(array $existingTags, array $knownCollectionTags, ?string $suggestedCollectionTag): array
    {
        $preserved = array_values(array_filter(
            $existingTags,
            static fn (string $tag): bool => !in_array($tag, $knownCollectionTags, true)
        ));

        if ($suggestedCollectionTag !== null && $suggestedCollectionTag !== '') {
            $preserved[] = $suggestedCollectionTag;
        }

        return self::deduplicateTags($preserved);
    }

    public static function buildAppendTags(array $existingTags, ?string $suggestedCollectionTag): array
    {
        $tags = $existingTags;
        if ($suggestedCollectionTag !== null && $suggestedCollectionTag !== '' && !in_array($suggestedCollectionTag, $tags, true)) {
            $tags[] = $suggestedCollectionTag;
        }

        return self::deduplicateTags($tags);
    }

    private static function deduplicateTags(array $tags): array
    {
        $unique = [];

        foreach ($tags as $tag) {
            $trimmed = trim((string) $tag);
            if ($trimmed !== '' && !in_array($trimmed, $unique, true)) {
                $unique[] = $trimmed;
            }
        }

        return $unique;
    }
}

final class OllamaClient
{
    public function __construct(
        private readonly HttpClient $httpClient,
        private readonly string $baseUrl,
    ) {
    }

    /**
     * The review step depends on structured JSON so downstream scripts can stay deterministic.
     */
    public function generateStructured(string $model, array $schema, string $prompt, string|int|null $keepAlive = null): array
    {
        $payload = [
            'model' => $model,
            'prompt' => $prompt,
            'stream' => false,
            'think' => false,
            'format' => $schema,
        ];

        if ($keepAlive !== null && $keepAlive !== '') {
            $payload['keep_alive'] = $keepAlive;
        }

        $response = $this->httpClient->postJson(rtrim($this->baseUrl, '/') . '/api/generate', [], $payload);

        $content = $this->extractStructuredContent($response);
        $decoded = json_decode($content, true);
        if (!is_array($decoded)) {
            throw new RuntimeException(sprintf(
                'Ollama returned invalid JSON. JSON error: %s. Response preview: %s',
                json_last_error_msg(),
                mb_substr($content, 0, 200)
            ));
        }

        return $decoded;
    }

    /**
     * Preload the model so later review batches avoid paying cold-start cost.
     */
    public function warmup(string $model, string|int|null $keepAlive = null): void
    {
        $payload = [
            'model' => $model,
            'stream' => false,
            'think' => false,
        ];

        if ($keepAlive !== null && $keepAlive !== '') {
            $payload['keep_alive'] = $keepAlive;
        }

        $this->httpClient->postJson(rtrim($this->baseUrl, '/') . '/api/generate', [], $payload);
    }

    private function extractStructuredContent(array $response): string
    {
        $responseText = trim((string) ($response['response'] ?? ''));
        if ($responseText !== '') {
            return $this->extractJsonObject($responseText);
        }

        $thinkingText = trim((string) ($response['thinking'] ?? ''));
        if ($thinkingText !== '') {
            return $this->extractJsonObject($thinkingText);
        }

        throw new RuntimeException('Ollama returned an empty response.');
    }

    private function extractJsonObject(string $content): string
    {
        if ($content === '') {
            throw new RuntimeException('Ollama returned an empty response.');
        }

        $firstBrace = strpos($content, '{');
        $lastBrace = strrpos($content, '}');

        if ($firstBrace === false || $lastBrace === false || $lastBrace < $firstBrace) {
            return $content;
        }

        return substr($content, $firstBrace, $lastBrace - $firstBrace + 1);
    }
}
