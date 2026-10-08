import { expect, test } from 'bun:test';
import { cutShareGrant, grantAdmits, slateCapabilityGraph, type SlateBindingCatalog } from '../src/slates/capability-graph';
import { parseSlateProject } from '../src/slates/project';

const root = parseSlateProject({
  main: 'server.js',
  slate: {
    bindings: {
      GITHUB: { kind: 'mcp', server: 'github' },
      FILES: { kind: 'namespace', namespace: 'workspace', members: ['readFile', 'writeFile'] },
      NOTES: { kind: 'memory', members: ['recall', 'remember'] },
      TODO: { kind: 'tasks' },
      NET: { kind: 'web' },
      MODELS: { kind: 'rpc', methods: ['getExecutors'] },
      ASK: { kind: 'agent' },
      BRAIN: { kind: 'ai', tier: 'fast' },
      PEER: { kind: 'app', id: 'digest' },
    },
  },
});

// The hop target's BACK binding names the root: a cycle walked once.
const digest = parseSlateProject({
  main: 'server.js',
  slate: {
    bindings: {
      DIGEST_FILES: { kind: 'namespace', namespace: 'workspace', members: ['readFile'] },
      BACK: { kind: 'app', id: 'issues' },
    },
  },
});

const catalog: SlateBindingCatalog = {
  executors: [{ namespace: 'workspace', members: ['readFile', 'writeFile', 'exec'] }],
  mcp: [{ server: 'github', title: 'GitHub', tools: [{ name: 'read_issue', readOnly: true }, { name: 'create_issue', readOnly: false }] }],
  tools: [],
  tiers: ['fast', 'deep'],
  slates: { issues: root, digest },
};

const graph = slateCapabilityGraph({ slate: 'issues', workspace: 'my-workspace', catalog });

test('the graph renders declared bindings and their effects', () => {
    const bindings = graph.bindings.map(binding => ({ ...binding, members: binding.members.map(member => ({ member: member.member, effect: member.effect })) }));
  expect(graph.slate).toBe('issues');
  expect(graph.slates).toEqual(['issues', 'digest']);
  expect(graph.bindings.map((binding) => [binding.slate, binding.name, binding.kind]))
    .toEqual([
      ['issues', 'GITHUB', 'mcp'], ['issues', 'FILES', 'namespace'], ['issues', 'NOTES', 'memory'],
      ['issues', 'TODO', 'tasks'], ['issues', 'NET', 'web'], ['issues', 'MODELS', 'rpc'],
      ['issues', 'ASK', 'agent'], ['issues', 'BRAIN', 'ai'], ['issues', 'PEER', 'app'],
      ['digest', 'DIGEST_FILES', 'namespace'], ['digest', 'BACK', 'app'],
    ]);

  expect(bindings[0]).toEqual({
    slate: 'issues', name: 'GITHUB', kind: 'mcp',
    capability: { kind: 'mcp', server: 'github', title: 'GitHub' },
    members: [
      { member: 'read_issue', effect: 'read',  },
      {
        member: 'create_issue', effect: 'mutate',

      },
    ],
  });
  expect(bindings[1]).toEqual({
    slate: 'issues', name: 'FILES', kind: 'namespace',
    capability: { kind: 'executor', namespace: 'workspace' },
    members: [
      { member: 'readFile', effect: 'read',  },
      {
        member: 'writeFile', effect: 'mutate',

      },
    ],
  });
  expect(bindings[2]).toEqual({
    slate: 'issues', name: 'NOTES', kind: 'memory',
    capability: { kind: 'memory' },
    members: [
      { member: 'recall', effect: 'read',  },
      {
        member: 'remember', effect: 'mutate',

      },
    ],
  });
  expect(bindings[3]).toMatchObject({
    name: 'TODO', kind: 'tasks', capability: { kind: 'tasks' },
    members: [
      { member: 'list', effect: 'read' },
      { member: 'add', effect: 'mutate' },
      { member: 'update', effect: 'mutate' },
      { member: 'mode', effect: 'mutate' },
    ],
  });

  expect(bindings[4]).toEqual({
    slate: 'issues', name: 'NET', kind: 'web', capability: { kind: 'web' },
    members: [
      { member: 'search', effect: 'read',  },
      { member: 'fetch', effect: 'read',  },
      { member: 'screenshot', effect: 'read',  },
    ],
  });
  expect(bindings[5]).toEqual({
    slate: 'issues', name: 'MODELS', kind: 'rpc', capability: { kind: 'rpc' },
    members: [{ member: 'getExecutors', effect: 'read',  }],
  });
  expect(bindings[6]).toEqual({
    slate: 'issues', name: 'ASK', kind: 'agent', capability: { kind: 'agent' },
    members: [{
      member: 'send', effect: 'mutate',

    }],
  });
  expect(bindings[7]).toEqual({
    slate: 'issues', name: 'BRAIN', kind: 'ai', capability: { kind: 'model', tier: 'fast' },
    members: [{
      member: 'shell', effect: 'mutate',

    }],
  });
  expect(bindings[8]).toEqual({
    slate: 'issues', name: 'PEER', kind: 'app', capability: { kind: 'slate', id: 'digest' }, members: [],
  });
  expect(bindings[9]).toEqual({
    slate: 'digest', name: 'DIGEST_FILES', kind: 'namespace',
    capability: { kind: 'executor', namespace: 'workspace' },
    members: [{ member: 'readFile', effect: 'read',  }],
  });
  expect(bindings[10]).toEqual({
    slate: 'digest', name: 'BACK', kind: 'app', capability: { kind: 'slate', id: 'issues' }, members: [],
  });
});

test('a cut grant is every read member plus exactly the approved mutations', () => {
  const grant = cutShareGrant(graph, []);

  expect(grant.slates).toEqual(['issues', 'digest']);
  expect(grant.members).toEqual([
    { slate: 'issues', binding: 'GITHUB', member: 'read_issue', effect: 'read' },
    { slate: 'issues', binding: 'FILES', member: 'readFile', effect: 'read' },
    { slate: 'issues', binding: 'NOTES', member: 'recall', effect: 'read' },
    { slate: 'issues', binding: 'TODO', member: 'list', effect: 'read' },
    { slate: 'issues', binding: 'NET', member: 'search', effect: 'read' },
    { slate: 'issues', binding: 'NET', member: 'fetch', effect: 'read' },
    { slate: 'issues', binding: 'NET', member: 'screenshot', effect: 'read' },
    { slate: 'issues', binding: 'MODELS', member: 'getExecutors', effect: 'read' },
    { slate: 'digest', binding: 'DIGEST_FILES', member: 'readFile', effect: 'read' },
  ]);

  const approved = cutShareGrant(graph, [{ slate: 'issues', binding: 'GITHUB', member: 'create_issue' }]);
  expect(approved.members).toEqual([
    ...grant.members,
    { slate: 'issues', binding: 'GITHUB', member: 'create_issue', effect: 'mutate' },
  ]);

  expect(grantAdmits(grant, 'issues', 'FILES', 'readFile'))
    .toEqual({ slate: 'issues', binding: 'FILES', member: 'readFile', effect: 'read' });
  expect(grantAdmits(grant, 'issues', 'FILES', 'writeFile')).toBeNull();
  expect(grantAdmits(grant, 'digest', 'DIGEST_FILES', 'writeFile')).toBeNull();
  expect(grantAdmits(approved, 'issues', 'GITHUB', 'create_issue'))
    .toEqual({ slate: 'issues', binding: 'GITHUB', member: 'create_issue', effect: 'mutate' });
});

test('a default share reads through the web namespace, but never lets the native web tool write', () => {
  // The native tool's fetch spills a page and its screenshot saves an image into the workspace; the namespace writes nothing.
  const project = parseSlateProject({
    main: 'server.js',
    slate: { bindings: { NATIVE: { kind: 'tool', name: 'web' }, NET: { kind: 'web' } } },
  });

  const shared = cutShareGrant(slateCapabilityGraph({
    slate: 'reader', workspace: 'my-workspace', catalog: { ...catalog, tools: ['web'], slates: { reader: project } },
  }), []);

  expect(shared.members.map(({ binding, member, effect }) => `${binding}.${member}:${effect}`)).toEqual([
    'NATIVE.search:read', 'NET.search:read', 'NET.fetch:read', 'NET.screenshot:read',
  ]);
});

test('approving a read member or an unknown member refuses', () => {
  expect(() => cutShareGrant(graph, [{ slate: 'issues', binding: 'FILES', member: 'readFile' }]))
    .toThrow(expect.objectContaining({ code: 'bad_input' }));
  expect(() => cutShareGrant(graph, [{ slate: 'issues', binding: 'GITHUB', member: 'delete_issue' }]))
    .toThrow(expect.objectContaining({ code: 'bad_input' }));
  expect(() => cutShareGrant(graph, [{ slate: 'issues', binding: 'NOPE', member: 'x' }]))
    .toThrow(expect.objectContaining({ code: 'bad_input' }));
});

test('bindings the workspace cannot honour carry their problem on the row', () => {
  const broken = parseSlateProject({
    main: 'server.js',
    slate: {
      bindings: {
        FILES: { kind: 'namespace', namespace: 'nonexistent' },
        GH: { kind: 'mcp', server: 'gitlab' },
        TOOL: { kind: 'tool', name: 'shell' },
        MISSING_TOOL: { kind: 'tool', name: 'not_a_tool' },
        DELEGATE: { kind: 'tool', name: 'agents' },
        EXEC: { kind: 'tool', name: 'eval' },
        SELF: { kind: 'namespace', namespace: 'agents' },
        MODEL: { kind: 'ai', tier: 'quantum' },
        GONE: { kind: 'app', id: 'missing' },
      },
    },
  });

  const problem = (name: string) => slateCapabilityGraph({
    slate: 'broken', workspace: 'ws',
    catalog: { ...catalog, slates: { broken }, tools: ['crafted_one'] },
  }).bindings.find((binding) => binding.name === name)?.problem;

  expect(problem('FILES')).toBeDefined();
  expect(problem('GH')).toBeDefined();
  expect(problem('MISSING_TOOL')).toBeDefined();
  expect(problem('DELEGATE')).toBeDefined();
  expect(problem('EXEC')).toBeDefined();
  expect(problem('SELF')).toBeDefined();
  expect(problem('MODEL')).toBeDefined();
  expect(problem('GONE')).toBeDefined();

  const tool = slateCapabilityGraph({
    slate: 'broken', workspace: 'ws',
    catalog: { ...catalog, slates: { broken }, tools: ['crafted_one'] },
  }).bindings.find((binding) => binding.name === 'TOOL');

  expect(tool).toMatchObject({ capability: { kind: 'tool', name: 'shell' }, members: [{ member: 'call', effect: 'mutate' }] });

  expect(() => slateCapabilityGraph({ slate: 'gone', workspace: 'ws', catalog }))
    .toThrow(expect.objectContaining({ code: 'missing' }));
});

test('a path-scoped binding offers only the file members it declares', () => {
  const scoped = parseSlateProject({
    main: 'server.js',
    slate: { bindings: { FILES: { kind: 'namespace', namespace: 'workspace', paths: ['/a'] } } },
  });

  const whole = slateCapabilityGraph({
    slate: 'scoped', workspace: 'ws',
    catalog: { executors: [{ namespace: 'workspace', members: ['readFile', 'exec'] }], mcp: [], tools: [], tiers: [], slates: { scoped } },
  });

  expect(whole.bindings[0].members.map((member) => member.member)).toEqual(['readFile']);

  const declared = parseSlateProject({
    main: 'server.js',
    slate: { bindings: { FILES: { kind: 'namespace', namespace: 'workspace', members: ['exec', 'readFile'], paths: ['/a'] } } },
  });

  const narrowed = slateCapabilityGraph({
    slate: 'declared', workspace: 'ws',
    catalog: { ...catalog, slates: { declared } },
  });

  expect(narrowed.bindings[0].members.map((member) => member.member)).toEqual(['readFile']);
});
