// Loaded before the egress server (node --import): chatgpt.com answers with a header Node's response refuses
// (DEL, which fetch admits and writeHead rejects), and the server listens on a free port, printed, not its fixed one.
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';

globalThis.fetch = async () => new Response('ok', { headers: { 'x-upstream': 'a\x7fb' } });

class FreePortServer extends http.Server {
  listen() {
    this.once('listening', () => { console.log(`listening ${this.address().port}`); });

    return super.listen(0);
  }
}

http.createServer = (listener) => new FreePortServer(listener);

syncBuiltinESMExports();
