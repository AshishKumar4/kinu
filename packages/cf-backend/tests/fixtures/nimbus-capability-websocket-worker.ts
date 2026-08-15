import { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import { handleFetch } from '../../../../node_modules/@nimbus-sh/worker/dist/session/routes.js';

const PORT = 4321;
const PID = 17;
const CAPABILITY = '0123456789abcdef01234567';

export default {
  async fetch(request: Request, env: { GUEST: Fetcher }): Promise<Response> {
    const portRegistry = new PortRegistry();
    portRegistry.bindFacetStub(PID, env.GUEST);
    portRegistry.register(PORT, PID);
    portRegistry.restoreCapability(PORT, CAPABILITY);

    return handleFetch({
      env: {},
      portRegistry,
      _viteShimPort: PORT,
      viteDevServer: null,
      cirrusReal: {
        isRunning: true,
        attachHmrClient() { return 'workerd-hmr-client'; },
      },
      _cirrusHmrWsClients: null,
      hydrateSessionBasePath: async () => {},
      ctx: {
        acceptWebSocket(socket: WebSocket) { socket.accept(); },
        storage: {
          get: async () => undefined,
          primary: undefined,
        },
      },
    }, request);
  },
};
