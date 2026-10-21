export const discoveryQueries = [
  ['search code', 'search_code', 'Search code across repositories by language, symbol or text.'],
  ['read file contents', 'get_file_contents', 'Read file contents at a repository path and revision.'],
  ['create issue', 'create_issue', 'Create an issue with a title and body in a repository.'],
  ['list pull requests', 'list_pull_requests', 'List pull requests filtered by repository, state and branch.'],
  ['read pull request diff', 'pull_request_read', 'Read a pull request diff, its status or changed files.'],
  ['add review comment', 'add_pull_request_review_comment', 'Add a review comment on a pull request line.'],
  ['list workflow runs', 'list_workflow_runs', 'List workflow runs and their completion status.'],
  ['download workflow artifact', 'download_workflow_run_artifact', 'Download a workflow run artifact by its identifier.'],
  ['search users', 'search_users', 'Search users by login, name or organization.'],
  ['get commit details', 'get_commit', 'Get commit details including changed files and author.'],
] as const;

export const largeMcpCatalog = [
  ...Array.from({ length: 110 }, (_, index) => ({
    name: `archive_${String(index).padStart(3, '0')}`,
    description: index === 0 ? undefined : `Read archived telemetry record ${String(index)}.`,
    inputSchema: {
      type: 'object' as const,
      properties: { record: { type: 'string', description: 'Archived telemetry record identifier. '.repeat(30) } },
      required: ['record'],
    },
    annotations: { readOnlyHint: true },
  })),
  ...discoveryQueries.map(([, name, description]) => ({
    name, description,
    inputSchema: { type: 'object' as const, properties: { query: { type: 'string' } }, required: ['query'] },
    annotations: { readOnlyHint: true },
  })),
];
