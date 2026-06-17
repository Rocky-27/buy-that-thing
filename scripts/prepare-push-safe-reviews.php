#!/usr/bin/env php
<?php

declare(strict_types=1);

require __DIR__ . '/lib/bootstrap.php';

final class PreparePushSafeReviewsCommand
{
    public function __construct(
        private readonly ConsoleIO $io,
        private readonly JsonStorage $storage,
    ) {
    }

    public function run(array $options): int
    {
        $inputPath = ProjectPath::resolve($this->io->prompt(
            'Review input path',
            'storage/reviews/product-reviews.json'
        ));
        $outputPath = ProjectPath::resolve($this->io->prompt(
            'Push-safe output path',
            'storage/reviews/product-reviews-push-safe.json'
        ));
        $reportPath = ProjectPath::resolve($this->io->prompt(
            'Preparation report path',
            'storage/reviews/product-reviews-push-safe-report.json'
        ));

        $payload = $this->storage->read($inputPath);
        $products = $payload['products'] ?? null;
        if (!is_array($products)) {
            throw new RuntimeException('Input review file is missing the expected products array.');
        }

        $stats = [
            'products_read' => count($products),
            'preserved_current_collection_tag' => 0,
            'description_html_sanitized' => 0,
            'description_html_fallback_to_current' => 0,
            'empty_suggested_title_replaced' => 0,
        ];

        $preparedProducts = [];

        foreach ($products as $product) {
            if (!is_array($product)) {
                continue;
            }

            $prepared = $product;

            $currentTag = $this->nullableString($product['current_collection_tag'] ?? null);
            $suggestedTag = $this->nullableString($product['suggested_collection_tag'] ?? null);
            if ($suggestedTag === null && $currentTag !== null) {
                $prepared['suggested_collection_tag'] = $currentTag;
                $prepared['proposed_tags'] = $this->replaceCollectionTag(
                    is_array($product['proposed_tags'] ?? null) ? $product['proposed_tags'] : [],
                    $currentTag
                );
                $prepared['reasoning'] = trim((string) ($product['reasoning'] ?? '')) .
                    ' Preserved the current collection tag because the model returned no replacement.';
                $stats['preserved_current_collection_tag']++;
            }

            $suggestedTitle = trim((string) ($product['suggested_title'] ?? ''));
            if ($suggestedTitle === '') {
                $prepared['suggested_title'] = (string) ($product['current_title'] ?? $product['original_title'] ?? '');
                $stats['empty_suggested_title_replaced']++;
            }

            $currentDescription = (string) ($product['current_description_html'] ?? $product['original_description_html'] ?? '');
            $suggestedDescription = (string) ($product['suggested_description_html'] ?? '');
            [$sanitizedDescription, $changed, $valid] = $this->sanitizeHtmlFragment($suggestedDescription);

            if (!$valid) {
                $prepared['suggested_description_html'] = $currentDescription;
                $prepared['reasoning'] = trim((string) ($prepared['reasoning'] ?? '')) .
                    ' Reused the current description because the suggested HTML could not be sanitized safely.';
                $stats['description_html_fallback_to_current']++;
            } else {
                $prepared['suggested_description_html'] = $sanitizedDescription;
                if ($changed) {
                    $stats['description_html_sanitized']++;
                }
            }

            $preparedProducts[] = $prepared;
        }

        $preparedPayload = $payload;
        $preparedPayload['generated_at'] = gmdate(DATE_ATOM);
        $preparedPayload['prepared_for_push_at'] = gmdate(DATE_ATOM);
        $preparedPayload['source_review_file'] = $inputPath;
        $preparedPayload['product_count'] = count($preparedProducts);
        $preparedPayload['products'] = $preparedProducts;

        $this->storage->write($outputPath, $preparedPayload);
        $this->storage->write($reportPath, [
            'generated_at' => gmdate(DATE_ATOM),
            'input_path' => $inputPath,
            'output_path' => $outputPath,
            'stats' => $stats,
        ]);

        $this->io->write(sprintf('Wrote push-safe review file to %s', $outputPath));
        $this->io->write(sprintf('Wrote preparation report to %s', $reportPath));

        return 0;
    }

    private function replaceCollectionTag(array $tags, string $tagToEnsure): array
    {
        $filtered = [];

        foreach ($tags as $tag) {
            if (!is_string($tag)) {
                continue;
            }

            $trimmed = trim($tag);
            if ($trimmed === '') {
                continue;
            }

            if (!str_starts_with($trimmed, 'taxonomy:')) {
                $filtered[] = $trimmed;
            }
        }

        $filtered[] = $tagToEnsure;

        return array_values(array_unique($filtered));
    }

    /**
     * Convert common malformed HTML/entity output into a stable fragment Shopify can store.
     *
     * @return array{0:string,1:bool,2:bool}
     */
    private function sanitizeHtmlFragment(string $html): array
    {
        $html = trim($html);
        if ($html === '') {
            return ['', false, false];
        }

        $normalized = preg_replace('/&(?!amp;|lt;|gt;|quot;|#39;|#\d+;|#x[0-9a-fA-F]+;)/', '&amp;', $html);
        $normalized = $normalized ?? $html;

        libxml_use_internal_errors(true);
        $dom = new DOMDocument('1.0', 'UTF-8');
        $ok = $dom->loadHTML(
            '<?xml encoding="utf-8" ?><div id="review-root">' . $normalized . '</div>',
            LIBXML_HTML_NOIMPLIED | LIBXML_HTML_NODEFDTD
        );

        if (!$ok) {
            libxml_clear_errors();

            return [$html, false, false];
        }

        $root = $dom->getElementById('review-root');
        if (!$root instanceof DOMElement) {
            libxml_clear_errors();

            return [$html, false, false];
        }

        $sanitized = '';
        foreach ($root->childNodes as $childNode) {
            $sanitized .= $dom->saveHTML($childNode);
        }

        libxml_clear_errors();
        $sanitized = trim($sanitized);

        if (preg_match('/<\/?[a-z][a-z0-9_-]*[.:][^>]*>/i', $sanitized) === 1) {
            return [$html, false, false];
        }

        return [$sanitized, $sanitized !== $html, $sanitized !== ''];
    }

    private function nullableString(mixed $value): ?string
    {
        if (!is_string($value)) {
            return null;
        }

        $trimmed = trim($value);

        return $trimmed === '' ? null : $trimmed;
    }
}

EnvLoader::load(PROJECT_ROOT . '.env');

$options = CliOptions::parse($argv);
$command = new PreparePushSafeReviewsCommand(new ConsoleIO(), new JsonStorage());

exit($command->run($options));
