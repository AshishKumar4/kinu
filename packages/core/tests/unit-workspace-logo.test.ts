// Defends: a logo a model wrote reaching the page with anything that runs or reaches out, a logo lost to a
// recoverable slip in its markup, and a new workspace that never asks for its logo.
import { describe, expect, test } from 'bun:test';
import { declareTerminalRoster, sanitizeWorkspaceLogoSvg } from '../src/index';

const svg = (body: string) => `<svg viewBox="0 0 64 64" width="64" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;

describe('a drawn logo, rebuilt from the allowlist', () => {
  test('keeps shapes, gradients, transforms and both kinds of animation', () => {
    const drawn = svg('<defs><linearGradient id="g"><stop offset="0" stop-color="#F6C27F"/></linearGradient></defs>'
      + '<style>.spin{animation:spin 4s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style>'
      + '<g class="spin" transform="translate(2 2)"><circle cx="32" cy="32" r="20" fill="url(#g)">'
      + '<animate attributeName="r" values="20;22;20" dur="3s" repeatCount="indefinite"/></circle></g>');

    expect(sanitizeWorkspaceLogoSvg(`Here is the logo:\n\`\`\`svg\n${drawn}\n\`\`\``)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g"><stop offset="0" stop-color="#F6C27F"/></linearGradient></defs>'
      + '<style>.spin{animation:spin 4s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style>'
      + '<g class="spin" transform="translate(2 2)"><circle cx="32" cy="32" r="20" fill="url(#g)">'
      + '<animate attributeName="r" values="20;22;20" dur="3s" repeatCount="indefinite"/></circle></g></svg>',
    );
  });

  test('drops scripts, foreign content, handlers and every reference outside the document', () => {
    const kept = sanitizeWorkspaceLogoSvg(svg(
      '<script>alert(1)</script><foreignObject><div onclick="x()">hi</div></foreignObject>'
      + '<rect width="9" height="9" onload="alert(1)" fill="url(https://evil.example/p)"/>'
      + '<image href="https://evil.example/x.png"/><use href="https://evil.example/s.svg#a"/><use xlink:href="#ok"/>'
      + '<a href="javascript:alert(1)"><circle r="3"/></a><set attributeName="href" to="javascript:alert(1)"/>'
      + '<style>@import url(https://evil.example/x.css);</style>'
      + '<rect width="1" height="1" fill="&#x6A;avascript:x" style="background:url(&quot;https://evil.example&quot;)"/>',
    ));

    expect(kept).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="9" height="9"/><use/>'
      + '<use href="#ok"/><style></style><rect width="1" height="1"/></svg>');
  });

  test('judges a style sheet whole, so a tag inside it cannot split a reference past the check', () => {
    expect(sanitizeWorkspaceLogoSvg(svg('<style>.a{fill:u</x>rl(https://evil.example/p)}</style><circle class="a" r="4"/>')))
      .toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><style></style><circle class="a" r="4"/></svg>');
  });

  test('stays well-formed XML: a repeated attribute keeps its first, and an xlink reference becomes plain href', () => {
    expect(sanitizeWorkspaceLogoSvg(svg('<circle r="4" fill="#abc" fill="#def"/><use xlink:href="#a"/>')))
      .toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle r="4" fill="#abc"/><use href="#a"/></svg>');
  });

  test('closes what a slip left open, and refuses an empty, absent or oversized drawing', () => {
    expect(sanitizeWorkspaceLogoSvg('<svg viewBox="0 0 8 8"><g><circle r="3"><br></g>')).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><g><circle r="3"></circle></g></svg>',
    );
    expect(sanitizeWorkspaceLogoSvg('I cannot draw that.')).toBeNull();
    expect(sanitizeWorkspaceLogoSvg(svg('<g><defs></defs></g>'))).toBeNull();
    expect(sanitizeWorkspaceLogoSvg(svg('<rect width="1" height="1"/>'.repeat(400)))).toBeNull();
  });
});

describe('the logo a new workspace owes', () => {
  const facts = (completed: boolean): Parameters<typeof declareTerminalRoster>[0] => ({
    messageId: 'genesis-1', status: completed ? 'completed' : 'error', workMode: 'build', continuity: 'conversation', completed,
    userText: 'Keep the shop fast', assistantText: '', scopedTurn: {}, recordedAt: 1, evolutionEnabled: false,
  });

  test('is owed by the first turn however it ended, from the mission or else the owner\'s words', () => {
    for (const completed of [true, false]) {
      expect(declareTerminalRoster(facts(completed), { logo: { mission: 'Run the storefront' } }).filter((effect) => effect.name === 'workspace_logo'))
        .toEqual([{ name: 'workspace_logo', scope: 'genesis-1', lane: 'detached', input: { subject: 'Run the storefront' } }]);
    }

    expect(declareTerminalRoster(facts(true), { logo: { mission: null } }).find((effect) => effect.name === 'workspace_logo')?.input)
      .toEqual({ subject: 'Keep the shop fast' });
    expect(declareTerminalRoster(facts(true), {}).some((effect) => effect.name === 'workspace_logo')).toBe(false);
  });
});
