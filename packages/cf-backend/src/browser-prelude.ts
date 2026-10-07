/**
 * The sandbox half of `web.*`: `connectBrowser`, `pageTools` and `callPageTool` hold a CDP socket, which no
 * JSON call to the host can. `connectBrowser` dials `codemode-egress.ts`'s gate, which checks the session's owner.
 * `pageTools` and `callPageTool` keep one WebMCP session per page, whose tool set follows the page's reports.
 */
import { BROWSER_GATE_HOST } from './codemode-egress';

export const BROWSER_CLIENT_MODULE = 'kinu-puppeteer.js';

/** The 296 KB client, compiled only when a program that may drive a browser is launched. */
export async function browserClientSource(): Promise<string> {
  return (await import('virtual:kinu-slate-vendor')).default.puppeteer;
}

export const BROWSER_PRELUDE = String.raw`
    // A failure is handed to the host member of the same name, which records it in the program's census and answers
    // the declared Refusal, as a host member's own failure is. Captured before the prelude defines the members.
    const __kinuHostWeb = { connectBrowser: web.connectBrowser, pageTools: web.pageTools, callPageTool: web.callPageTool };
    const __kinuRefusing = (member, run) => async (...args) => {
      const refusal = { reason: 'unavailable' };

      try {
        return await run(refusal, ...args);
      } catch (cause) {
        return __kinuHostWeb[member]({ refused: cause instanceof Error ? cause.message : String(cause), reason: refusal.reason });
      }
    };
    web.connectBrowser = __kinuRefusing('connectBrowser', async (refusal, id) => {
      // Imported on first use: most programs never evaluate the 296 KB client.
      const { default: puppeteer } = await import('./${BROWSER_CLIENT_MODULE}');
      const gate = {
        fetch: async (url, init) => {
          const answer = await globalThis.fetch(String(url).replace(/^https:\/\/[^/]+/, 'https://${BROWSER_GATE_HOST}'), init);

          // The gate refuses in words; without this puppeteer reports only a missing socket.
          if (answer.webSocket === null) {
            if (answer.status === 403) refusal.reason = 'denied';
            throw new Error(await answer.text());
          }

          return answer;
        },
      };

      return puppeteer.connect(gate, String(id));
    });
    // Per page: one CDP session, the live tool set it reports, and each invocation's answer by id.
    const __kinuWebMcp = new WeakMap();
    const __kinuWebMcpOf = async (page) => {
      const known = __kinuWebMcp.get(page);

      if (known !== undefined) return known;
      const cdp = await page.createCDPSession();
      const tools = new Map();
      const answers = new Map();
      const reported = Promise.withResolvers();
      const answerOf = (id) => {
        if (!answers.has(id)) answers.set(id, Promise.withResolvers());

        return answers.get(id);
      };
      cdp.on('WebMCP.toolsAdded', (event) => { for (const tool of event.tools) tools.set(tool.name, tool); reported.resolve(); });
      cdp.on('WebMCP.toolsRemoved', (event) => { for (const tool of event.tools) tools.delete(tool.name); });
      cdp.on('WebMCP.toolResponded', (event) => { answerOf(event.invocationId).resolve(event); });
      await cdp.send('WebMCP.enable');
      // The domain answers no "that is all": a page with no tools reports nothing. Kitesurf reported the hotel-chain
      // demo's tools 2-221 ms after enable (5 runs, 2026-09-28), so the first read waits for a report up to 1 s.
      await Promise.race([reported.promise, new Promise((settled) => { setTimeout(settled, 1000); })]);
      const state = { cdp, tools, answerOf };
      __kinuWebMcp.set(page, state);

      return state;
    };
    web.pageTools = __kinuRefusing('pageTools', async (_refusal, page) => [...(await __kinuWebMcpOf(page)).tools.values()]
      .map(({ name, description, inputSchema }) => ({ name, description, inputSchema })));
    web.callPageTool = __kinuRefusing('callPageTool', async (_refusal, page, name, input) => {
      const { cdp, tools, answerOf } = await __kinuWebMcpOf(page);
      const tool = tools.get(name);

      if (tool === undefined) throw new Error('the page offers no WebMCP tool ' + name + '; it offers ' + ([...tools.keys()].join(', ') || 'none'));
      // An answer may land before invokeTool's own reply names its id, so answers are kept by id.
      const { invocationId } = await cdp.send('WebMCP.invokeTool', { frameId: tool.frameId, toolName: name, input: input ?? {} });
      const answer = await answerOf(invocationId).promise;

      if (answer.status !== 'Completed') throw new Error('WebMCP tool ' + name + ' ' + answer.status + (answer.errorText ? ': ' + answer.errorText : ''));

      return answer.output;
    });
`;
