// The door's paths, spelled once: client, route table, auth gate and page all read these.

export const DEPLOY_API = '/api/deploy';

export const DEPLOY_PAGE_PATH = '/deploy';

/** OAuth callback. Carries no run key; the `__Host-kinu_deploy_state` cookie proves the browser. */
export const DEPLOY_CALLBACK_PATH = '/deploy/callback';
