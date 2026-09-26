/**
 * The scripted model, as a workspace names it and as its endpoint serves it. A leaf importing nothing: the deployed
 * tiers' Worker bundles it (scripts/scripted-protocol.ts), and a suite pins a workspace to the spec.
 */
export const SCRIPTED_MODEL_ID = 'fake-live';

/** An account's `openai-compat` credential names the endpoint; this is the model the tiers' workspaces pin. */
export const SCRIPTED_MODEL_SPEC = `openai-compat/${SCRIPTED_MODEL_ID}`;

/** Where a deployment reaches it: the tiers' Worker on its Custom Domain (scripts/scripted-model-worker.jsonc). */
export const SCRIPTED_MODEL_ORIGIN = 'https://scripted-model.kinu.run';
