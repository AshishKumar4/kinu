// Wire-level constants shared by the cf-backend Worker and the CLI.
//
// The agents SDK routes a Durable Object class at its kebab-cased class name:
// OrchestratorAgent ⇒ /agents/orchestrator-agent/<instance>. The server's
// route matcher, connect-ticket validation, and the CLI's WebSocket URL
// builder must all agree on this slug, so it lives once here.
export const ORCHESTRATOR_AGENT_SLUG = 'orchestrator-agent';
