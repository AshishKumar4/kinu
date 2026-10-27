/** What the front Worker binds of the main Worker's, read by its routes (front-routes.ts) and its build (front-config.ts).
 *  No secret: each object checks the session itself, so the front holds nothing a self-host's Update cannot carry. */

/** The objects a page open reaches: the account's and the workspace's, the main Worker's classes under its names. */
export const FRONT_OBJECTS = ['UserDO', 'OrchestratorAgent'] as const;

/** The main Worker, as the front reaches it for every request it does not answer. */
export const MAIN_SERVICE_BINDING = 'MAIN';
