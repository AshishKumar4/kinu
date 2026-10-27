/**
 * The front Worker a deployment on its own domain has (cf-backend src/front.ts): it answers a page open and passes every
 * other request to its main Worker. Its config is derived from the main Worker's, by the build (cf-backend
 * front-config.ts) and by a self-hosted deploy (steps.ts) alike; it holds no secret.
 */

export function frontWorkerName(main: string): string {
  return `${main}-front`;
}

/** The main Worker's objects a page open reaches, bound in the front under the main Worker's names. */
export const FRONT_OBJECTS = ['UserDO', 'OrchestratorAgent'] as const;

/** The binding the front reaches its main Worker through. */
export const MAIN_SERVICE_BINDING = 'MAIN';
