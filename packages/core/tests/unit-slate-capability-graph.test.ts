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

// The app hop target: its own bindings walk after the root's, and its BACK
// binding names the root — a cycle the walk must not follow twice.
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

const NO_RISK = { public: '', users: '' };

/** The two risk strings of one member, so the expected structure reads the
 *  wording once per visibility instead of repeating each sentence. */
function risk(member: { risk: { public: string; users: string } }): [string, string] {
  return [member.risk.public, member.risk.users];
}

test('the graph renders every binding with members, effects and risk text', () => {
  expect(graph.slate).toBe('issues');
  // Root first, then the app hop target — and BACK does not walk issues again.
  expect(graph.slates).toEqual(['issues', 'digest']);
  expect(graph.bindings.map((binding) => [binding.slate, binding.name, binding.kind]))
    .toEqual([
      ['issues', 'GITHUB', 'mcp'], ['issues', 'FILES', 'namespace'], ['issues', 'NOTES', 'memory'],
      ['issues', 'TODO', 'tasks'], ['issues', 'NET', 'web'], ['issues', 'MODELS', 'rpc'],
      ['issues', 'ASK', 'agent'], ['issues', 'BRAIN', 'ai'], ['issues', 'PEER', 'app'],
      ['digest', 'DIGEST_FILES', 'namespace'], ['digest', 'BACK', 'app'],
    ]);

  expect(graph.bindings[0]).toEqual({
    slate: 'issues', name: 'GITHUB', kind: 'mcp',
    capability: { kind: 'mcp', server: 'github', title: 'GitHub' },
    members: [
      { member: 'read_issue', effect: 'read', risk: NO_RISK },
      {
        member: 'create_issue', effect: 'mutate',
        risk: {
          public: 'Calls create_issue on GitHub with your credentials. The server does not mark it read-only, so it can create or change data there. Anyone who opens this share can trigger it.',
          users: 'Calls create_issue on GitHub with your credentials. The server does not mark it read-only, so it can create or change data there. Anyone you named on this share can trigger it.',
        },
      },
    ],
  });
  expect(graph.bindings[1]).toEqual({
    slate: 'issues', name: 'FILES', kind: 'namespace',
    capability: { kind: 'executor', namespace: 'workspace' },
    members: [
      { member: 'readFile', effect: 'read', risk: NO_RISK },
      {
        member: 'writeFile', effect: 'mutate',
        risk: {
          public: 'Writes, edits or deletes files in workspace my-workspace as you. Anyone who opens this share can trigger it.',
          users: 'Writes, edits or deletes files in workspace my-workspace as you. Anyone you named on this share can trigger it.',
        },
      },
    ],
  });
  expect(graph.bindings[2]).toEqual({
    slate: 'issues', name: 'NOTES', kind: 'memory',
    capability: { kind: 'memory' },
    members: [
      { member: 'recall', effect: 'read', risk: NO_RISK },
      {
        member: 'remember', effect: 'mutate',
        risk: {
          public: 'Changes your workspace memory as you: notes and remembered facts your agent reads back later. Anyone who opens this share can trigger it.',
          users: 'Changes your workspace memory as you: notes and remembered facts your agent reads back later. Anyone you named on this share can trigger it.',
        },
      },
    ],
  });
  // No members declared: the whole table's member list.
  expect(graph.bindings[3]).toMatchObject({
    name: 'TODO', kind: 'tasks', capability: { kind: 'tasks' },
    members: [
      { member: 'list', effect: 'read' },
      { member: 'add', effect: 'mutate' },
      { member: 'update', effect: 'mutate' },
      { member: 'mode', effect: 'mutate' },
    ],
  });
  expect(risk(graph.bindings[3]!.members[1]!)).toEqual([
    "Changes your agent's task list and role as you. Anyone who opens this share can trigger it.",
    "Changes your agent's task list and role as you. Anyone you named on this share can trigger it.",
  ]);
  expect(graph.bindings[4]).toEqual({
    slate: 'issues', name: 'NET', kind: 'web', capability: { kind: 'web' },
    members: [
      { member: 'search', effect: 'read', risk: NO_RISK },
      { member: 'fetch', effect: 'read', risk: NO_RISK },
    ],
  });
  expect(graph.bindings[5]).toEqual({
    slate: 'issues', name: 'MODELS', kind: 'rpc', capability: { kind: 'rpc' },
    members: [{ member: 'getExecutors', effect: 'read', risk: NO_RISK }],
  });
  expect(graph.bindings[6]).toEqual({
    slate: 'issues', name: 'ASK', kind: 'agent', capability: { kind: 'agent' },
    members: [{
      member: 'send', effect: 'mutate',
      risk: {
        public: "Sends a message to your agent's inbox as this slate. Your agent reads it and acts on it in workspace my-workspace. Anyone who opens this share can trigger it.",
        users: "Sends a message to your agent's inbox as this slate. Your agent reads it and acts on it in workspace my-workspace. Anyone you named on this share can trigger it.",
      },
    }],
  });
  expect(graph.bindings[7]).toEqual({
    slate: 'issues', name: 'BRAIN', kind: 'ai', capability: { kind: 'model', tier: 'fast' },
    members: [{
      member: 'run', effect: 'mutate',
      risk: {
        public: 'Runs a model call on your fast tier. Every call spends your inference. Anyone who opens this share can trigger it.',
        users: 'Runs a model call on your fast tier. Every call spends your inference. Anyone you named on this share can trigger it.',
      },
    }],
  });
  expect(graph.bindings[8]).toEqual({
    slate: 'issues', name: 'PEER', kind: 'app', capability: { kind: 'slate', id: 'digest' }, members: [],
  });
  expect(graph.bindings[9]).toEqual({
    slate: 'digest', name: 'DIGEST_FILES', kind: 'namespace',
    capability: { kind: 'executor', namespace: 'workspace' },
    members: [{ member: 'readFile', effect: 'read', risk: NO_RISK }],
  });
  expect(graph.bindings[10]).toEqual({
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

test('approving a read member or an unknown member refuses', () => {
  expect(() => cutShareGrant(graph, [{ slate: 'issues', binding: 'FILES', member: 'readFile' }]))
    .toThrow('FILES.readFile is not a mutating member of slate issues');
  expect(() => cutShareGrant(graph, [{ slate: 'issues', binding: 'GITHUB', member: 'delete_issue' }]))
    .toThrow('GITHUB.delete_issue is not a mutating member of slate issues');
  expect(() => cutShareGrant(graph, [{ slate: 'issues', binding: 'NOPE', member: 'x' }]))
    .toThrow('NOPE.x is not a mutating member of slate issues');
});

test('bindings the workspace cannot honour carry their problem on the row', () => {
  const broken = parseSlateProject({
    main: 'server.js',
    slate: {
      bindings: {
        FILES: { kind: 'namespace', namespace: 'nonexistent' },
        GH: { kind: 'mcp', server: 'gitlab' },
        TOOL: { kind: 'tool', name: 'run' },
        MISSING_TOOL: { kind: 'tool', name: 'not_a_tool' },
        DELEGATE: { kind: 'tool', name: 'agents' },
        EXEC: { kind: 'tool', name: 'execute_tools' },
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

  expect(problem('FILES')).toBe('no executor named nonexistent is available in this workspace');
  expect(problem('GH')).toBe('MCP server gitlab is not connected');
  expect(problem('MISSING_TOOL')).toBe('no tool named not_a_tool is available');
  expect(problem('DELEGATE')).toBe('a slate cannot delegate or control its calling agent');
  expect(problem('EXEC')).toBe('a slate cannot run execute_tools');
  expect(problem('SELF')).toBe('a slate cannot delegate or control its calling agent');
  expect(problem('MODEL')).toBe('you have no quantum tier');
  expect(problem('GONE')).toBe('no slate named missing');

  const tool = slateCapabilityGraph({
    slate: 'broken', workspace: 'ws',
    catalog: { ...catalog, slates: { broken }, tools: ['crafted_one'] },
  }).bindings.find((binding) => binding.name === 'TOOL');

  expect(tool).toMatchObject({ capability: { kind: 'tool', name: 'run' }, members: [{ member: 'call', effect: 'mutate' }] });

  expect(() => slateCapabilityGraph({ slate: 'gone', workspace: 'ws', catalog }))
    .toThrow('No slate named gone');
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

  // No declared members: the catalog's members, narrowed to the file five.
  expect(whole.bindings[0]!.members.map((member) => member.member)).toEqual(['readFile']);

  const declared = parseSlateProject({
    main: 'server.js',
    slate: { bindings: { FILES: { kind: 'namespace', namespace: 'workspace', members: ['exec', 'readFile'], paths: ['/a'] } } },
  });

  const narrowed = slateCapabilityGraph({
    slate: 'declared', workspace: 'ws',
    catalog: { ...catalog, slates: { declared } },
  });

  expect(narrowed.bindings[0]!.members.map((member) => member.member)).toEqual(['readFile']);
});
