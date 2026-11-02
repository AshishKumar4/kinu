/**
 * The front Worker of a deployment (cf-backend src/front.ts): it answers a page open and passes every other request to
 * its main Worker. Its config is derived from the main Worker's, by the build (cf-backend front-config.ts) and by a
 * self-hosted deploy (steps.ts) alike; it holds no secret.
 */

/** The front of kinu.run's and staging's own main Worker (scripts/promote.ts), deployed by wrangler. */
export function frontWorkerName(main: string): string {
  return `${main}-front`;
}

/**
 * The two Workers a self-hosted deployment is: the front, which holds the deployment's name and answers its address, and
 * the main Worker behind it, which holds its objects, secrets and mail. A workers.dev address is a Worker's own name, so
 * the front takes the name there; it takes it on a domain too, so a deployment that moves from workers.dev to its
 * domain keeps both Workers.
 */
export function deploymentWorkers(instanceName: string) {
  return { main: `${instanceName}${MAIN_SUFFIX}`, front: instanceName };
}

const MAIN_SUFFIX = '-app';

/** The deployment a main Worker is (`deploymentWorkers`'s inverse); null for a Worker not named as one. */
export function deploymentOfMain(worker: string): string | null {
  return worker.endsWith(MAIN_SUFFIX) ? worker.slice(0, -MAIN_SUFFIX.length) : null;
}

/** The main Worker's objects a page open reaches, bound in the front under the main Worker's names. */
export const FRONT_OBJECTS = ['UserDO', 'OrchestratorAgent'] as const;

/** The binding the front reaches its main Worker through. */
export const MAIN_SERVICE_BINDING = 'MAIN';
