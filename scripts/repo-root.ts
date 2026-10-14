/** The repository's root, with its trailing slash: every script's paths are this joined with a tracked path. */
export const REPO_ROOT = new URL('..', import.meta.url).pathname;
