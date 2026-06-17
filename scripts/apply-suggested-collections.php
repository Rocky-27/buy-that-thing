#!/usr/bin/env php
<?php

declare(strict_types=1);

require __DIR__ . '/lib/bootstrap.php';

final class ApplySuggestedCollectionsCommand
{
    private const PARENT_NAMESPACE = 'custom';
    private const PARENT_KEY = 'parent_collection';
    private const CHILDREN_NAMESPACE = 'custom';
    private const CHILDREN_KEY = 'child_collections';

    public function __construct(
        private readonly ConsoleIO $io,
        private readonly JsonStorage $storage,
        private readonly ShopifyClient $shopifyClient,
    ) {
    }

    public function run(array $options): int
    {
        $dryRun = array_key_exists('dry-run', $options)
            ? filter_var($options['dry-run'], FILTER_VALIDATE_BOOL)
            : $this->io->promptYesNo('Dry run', true);

        $proposalPath = ProjectPath::resolve($this->io->prompt(
            'Suggested collections JSON path',
            'storage/taxonomy/suggested-collections.json'
        ));
        $reportPath = ProjectPath::resolve($this->io->prompt(
            'Apply report output path',
            'storage/taxonomy/suggested-collections-apply-report.json'
        ));

        $proposal = $this->storage->read($proposalPath);
        $actions = $proposal['recommended_shopify_actions'] ?? [];
        $relationships = $proposal['suggested_parent_child_relationships'] ?? [];

        if (!is_array($actions) || !is_array($relationships)) {
            throw new RuntimeException('Proposal file is missing expected arrays.');
        }

        $existingCollections = $this->fetchCollections();
        $collectionsByTag = [];
        foreach ($existingCollections as $collection) {
            $tag = CatalogHelper::extractCollectionTag($collection);
            if ($tag !== null) {
                $collectionsByTag[$tag] = $collection;
            }
        }

        $publications = $this->fetchPublications();
        $results = [
            'generated_at' => gmdate(DATE_ATOM),
            'dry_run' => $dryRun,
            'proposal_path' => $proposalPath,
            'actions' => [],
            'relationships' => [],
            'publications' => $publications,
        ];

        foreach ($actions as $action) {
            if (!is_array($action)) {
                continue;
            }

            $result = $this->applyCollectionAction($action, $collectionsByTag, $publications, $dryRun);
            $results['actions'][] = $result;
        }

        foreach ($relationships as $relationship) {
            if (!is_array($relationship)) {
                continue;
            }

            $results['relationships'][] = $this->applyRelationship($relationship, $collectionsByTag, $dryRun);
        }

        $this->storage->write($reportPath, $results);
        $this->io->write(sprintf('Wrote apply report to %s', $reportPath));

        return 0;
    }

    private function fetchCollections(): array
    {
        return $this->shopifyClient->fetchAllNodes(
            'collections',
            <<<'GRAPHQL'
id
legacyResourceId
handle
title
descriptionHtml
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
    }

    private function fetchPublications(): array
    {
        $query = <<<'GRAPHQL'
query FetchPublications {
  publications(first: 20) {
    nodes {
      id
      name
      catalog {
        ... on AppCatalog {
          title
        }
      }
    }
  }
}
GRAPHQL;

        try {
            $data = $this->shopifyClient->graphql($query);
        } catch (RuntimeException $exception) {
            if (str_contains($exception->getMessage(), 'read_publications')) {
                $this->io->error('Skipping publication step because the token does not have read_publications access.');

                return [];
            }

            throw $exception;
        }

        $nodes = $data['publications']['nodes'] ?? [];

        return array_values(array_filter(array_map(static function (array $node): ?array {
            $id = (string) ($node['id'] ?? '');
            if ($id === '') {
                return null;
            }

            return [
                'id' => $id,
                'name' => $node['catalog']['title'] ?? $node['name'] ?? $id,
            ];
        }, is_array($nodes) ? $nodes : [])));
    }

    private function applyCollectionAction(array $action, array &$collectionsByTag, array $publications, bool $dryRun): array
    {
        $tag = (string) ($action['tag'] ?? '');
        $mode = (string) ($action['action'] ?? '');
        $title = (string) ($action['title'] ?? '');
        $handle = (string) ($action['handle'] ?? '');
        $description = (string) ($action['description'] ?? '');

        if ($tag === '' || $mode === '') {
            throw new RuntimeException('Collection action is missing tag or action.');
        }

        $existing = $collectionsByTag[$tag] ?? null;
        $status = [
            'action' => $mode,
            'tag' => $tag,
            'title' => $title,
            'handle' => $handle,
            'status' => $existing === null ? 'create' : 'update',
            'dry_run' => $dryRun,
        ];

        if ($dryRun) {
            return $status;
        }

        if ($existing === null) {
            $created = $this->createSmartCollection($title, $handle, $description, $tag);
            $collectionsByTag[$tag] = $created;
            $status['collection_id'] = $created['id'];
            $status['published_to'] = $this->publishCollection($created['id'], $publications);

            return $status;
        }

        $updated = $this->updateCollection((string) $existing['id'], $title, $handle, $description);
        $collectionsByTag[$tag] = array_merge($existing, $updated);
        $status['collection_id'] = $existing['id'];

        return $status;
    }

    private function createSmartCollection(string $title, string $handle, string $description, string $tag): array
    {
        $mutation = <<<'GRAPHQL'
mutation CreateCollection($input: CollectionInput!) {
  collectionCreate(input: $input) {
    collection {
      id
      handle
      title
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
                'title' => $title,
                'handle' => $handle,
                'descriptionHtml' => sprintf('<p>%s</p>', htmlspecialchars($description, ENT_QUOTES | ENT_HTML5)),
                'ruleSet' => [
                    'appliedDisjunctively' => false,
                    'rules' => [
                        [
                            'column' => 'TAG',
                            'relation' => 'EQUALS',
                            'condition' => $tag,
                        ],
                    ],
                ],
            ],
        ]);

        $errors = $result['collectionCreate']['userErrors'] ?? [];
        if (!empty($errors)) {
            throw new RuntimeException('Shopify collectionCreate failed: ' . json_encode($errors, JSON_UNESCAPED_SLASHES));
        }

        return $result['collectionCreate']['collection'] ?? throw new RuntimeException('Shopify collectionCreate returned no collection.');
    }

    private function updateCollection(string $id, string $title, string $handle, string $description): array
    {
        $mutation = <<<'GRAPHQL'
mutation UpdateCollection($input: CollectionInput!) {
  collectionUpdate(input: $input) {
    collection {
      id
      handle
      title
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
                'id' => $id,
                'title' => $title,
                'handle' => $handle,
                'descriptionHtml' => sprintf('<p>%s</p>', htmlspecialchars($description, ENT_QUOTES | ENT_HTML5)),
            ],
        ]);

        $errors = $result['collectionUpdate']['userErrors'] ?? [];
        if (!empty($errors)) {
            throw new RuntimeException('Shopify collectionUpdate failed: ' . json_encode($errors, JSON_UNESCAPED_SLASHES));
        }

        return $result['collectionUpdate']['collection'] ?? throw new RuntimeException('Shopify collectionUpdate returned no collection.');
    }

    private function publishCollection(string $collectionId, array $publications): array
    {
        if ($publications === []) {
            return [];
        }

        $mutation = <<<'GRAPHQL'
mutation PublishResource($id: ID!, $input: [PublicationInput!]!) {
  publishablePublish(id: $id, input: $input) {
    userErrors {
      field
      message
    }
  }
}
GRAPHQL;

        $input = array_map(static fn (array $publication): array => ['publicationId' => $publication['id']], $publications);
        $result = $this->shopifyClient->graphql($mutation, [
            'id' => $collectionId,
            'input' => $input,
        ]);

        $errors = $result['publishablePublish']['userErrors'] ?? [];
        if (!empty($errors)) {
            throw new RuntimeException('Shopify publishablePublish failed: ' . json_encode($errors, JSON_UNESCAPED_SLASHES));
        }

        return array_map(static fn (array $publication): string => (string) $publication['name'], $publications);
    }

    private function applyRelationship(array $relationship, array $collectionsByTag, bool $dryRun): array
    {
        $parentTag = (string) ($relationship['parent_tag'] ?? '');
        $childTags = array_values(array_filter($relationship['child_tags'] ?? [], 'is_string'));
        $parent = $collectionsByTag[$parentTag] ?? null;

        if ($parentTag === '' || $parent === null) {
            return [
                'parent_tag' => $parentTag,
                'status' => 'skipped',
                'reason' => 'Parent collection not found',
                'dry_run' => $dryRun,
            ];
        }

        $childIds = [];
        foreach ($childTags as $childTag) {
            if (isset($collectionsByTag[$childTag]['id'])) {
                $childIds[] = (string) $collectionsByTag[$childTag]['id'];
            }
        }

        $status = [
            'parent_tag' => $parentTag,
            'child_tags' => $childTags,
            'resolved_child_count' => count($childIds),
            'dry_run' => $dryRun,
        ];

        if ($dryRun) {
            return $status;
        }

        $metafields = [
            [
                'ownerId' => (string) $parent['id'],
                'namespace' => self::CHILDREN_NAMESPACE,
                'key' => self::CHILDREN_KEY,
                'type' => 'list.collection_reference',
                'value' => json_encode($childIds, JSON_UNESCAPED_SLASHES),
            ],
        ];

        foreach ($childTags as $childTag) {
            $child = $collectionsByTag[$childTag] ?? null;
            if ($child === null) {
                continue;
            }

            $metafields[] = [
                'ownerId' => (string) $child['id'],
                'namespace' => self::PARENT_NAMESPACE,
                'key' => self::PARENT_KEY,
                'type' => 'collection_reference',
                'value' => (string) $parent['id'],
            ];
        }

        $this->setMetafields($metafields);

        return $status + ['status' => 'applied'];
    }

    private function setMetafields(array $metafields): void
    {
        $mutation = <<<'GRAPHQL'
mutation SetMetafields($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    userErrors {
      field
      message
      code
    }
  }
}
GRAPHQL;

        $result = $this->shopifyClient->graphql($mutation, ['metafields' => $metafields]);
        $errors = $result['metafieldsSet']['userErrors'] ?? [];
        if (!empty($errors)) {
            throw new RuntimeException('Shopify metafieldsSet failed: ' . json_encode($errors, JSON_UNESCAPED_SLASHES));
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
$command = new ApplySuggestedCollectionsCommand($io, $storage, $shopifyClient);

exit($command->run($options));
