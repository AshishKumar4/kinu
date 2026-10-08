import { expect, test } from 'bun:test';
import { cutShareGrant, grantAdmits, slateCapabilityGraph, type SlateSurfaceCatalog, type SlateUsage } from '../src/slates/capability-graph';

const used = (...paths: string[]): SlateUsage[] => paths.map((path) => {
  const names = path.split('.');

  return { namespace: names.slice(0, -1).join('.'), member: names.at(-1) ?? '' };
});

/** What each slate called as its owner ran it; the digest's way back names the root, a cycle walked once. */
const USAGE = new Map([
  ['issues', used(
    'mcp.github.read_issue', 'mcp.github.create_issue', 'workspace.readFile', 'workspace.writeFile', 'workspace.exec',
    'memory.recall', 'memory.remember', 'tasks.list', 'web.search', 'reads.getExecutors', 'agent.send', 'ai.run', 'slates.digest.count',
  )],
  ['digest', used('workspace.readFile', 'slates.issues.refresh')],
]);

const catalog: SlateSurfaceCatalog = {
  mcp: [{ server: 'github', title: 'GitHub', tools: [{ name: 'read_issue', readOnly: true }, { name: 'create_issue', readOnly: false }] }],
  slates: ['issues', 'digest'],
};

const graph = slateCapabilityGraph({ slate: 'issues', workspace: 'my-workspace', catalog, usage: (slate) => USAGE.get(slate) ?? [] });

const NO_RISK = { public: '', users: '' };

const row = (slate: string, namespace: string) => graph.namespaces.find((each) => each.slate === slate && each.namespace === namespace);

test('the graph names each namespace a slate called, each member with its impact and risk text', () => {
  expect(graph.slate).toBe('issues');
  expect(graph.slates).toEqual(['issues', 'digest']);
  expect(graph.namespaces.map((each) => `${each.slate}:${each.namespace}`)).toEqual([
    'issues:mcp.github', 'issues:workspace', 'issues:memory', 'issues:tasks', 'issues:web', 'issues:reads', 'issues:agent', 'issues:ai',
    'issues:slates.digest', 'digest:workspace', 'digest:slates.issues',
  ]);

  expect(row('issues', 'mcp.github')).toEqual({
    slate: 'issues', namespace: 'mcp.github', title: 'GitHub',
    members: [
      { member: 'read_issue', impact: 'observe', risk: NO_RISK },
      {
        member: 'create_issue', impact: 'externalSend',
        risk: {
          public: 'Calls create_issue on GitHub with your credentials. The server does not mark it read-only, so it can create or change data there. Anyone who opens this share can trigger it.',
          users: 'Calls create_issue on GitHub with your credentials. The server does not mark it read-only, so it can create or change data there. Anyone you named on this share can trigger it.',
        },
      },
    ],
  });
  expect(row('issues', 'workspace')?.members.map((member) => [member.member, member.impact])).toEqual([
    ['readFile', 'observe'], ['writeFile', 'mutate'], ['exec', 'execute'],
  ]);
  expect(row('issues', 'workspace')?.members[1]?.risk.public)
    .toBe('Writes, edits or deletes files in workspace my-workspace as you. Anyone who opens this share can trigger it.');
  expect(row('issues', 'memory')?.members.map((member) => [member.member, member.impact])).toEqual([['recall', 'observe'], ['remember', 'mutate']]);
  expect(row('issues', 'web')?.members).toEqual([{ member: 'search', impact: 'observe', risk: NO_RISK }]);
  expect(row('issues', 'reads')?.members).toEqual([{ member: 'getExecutors', impact: 'observe', risk: NO_RISK }]);
  expect(row('issues', 'agent')?.members.map((member) => member.impact)).toEqual(['externalSend']);
  expect(row('issues', 'ai')?.members[0]).toMatchObject({ member: 'run', impact: 'execute', risk: { public: expect.stringContaining('spends') } });
  expect(row('issues', 'slates.digest')).toEqual({ slate: 'issues', namespace: 'slates.digest', title: 'slates.digest', members: [{ member: 'count', impact: 'observe', risk: NO_RISK }] });
});

test('a namespace naming something absent is a problem row that keeps its members', () => {
  const lone = slateCapabilityGraph({
    slate: 'issues', workspace: 'w', catalog: { mcp: [], slates: ['issues'] }, usage: () => used('mcp.gone.read', 'slates.missing.count'),
  });

  expect(lone.namespaces).toEqual([
    { slate: 'issues', namespace: 'mcp.gone', title: 'mcp.gone', members: [expect.objectContaining({ member: 'read', impact: 'externalSend' })], problem: 'MCP server gone is not connected' },
    { slate: 'issues', namespace: 'slates.missing', title: 'slates.missing', members: [expect.objectContaining({ member: 'count' })], problem: 'no slate named missing' },
  ]);
  expect(lone.slates).toEqual(['issues']);
  expect(() => slateCapabilityGraph({ slate: 'nope', workspace: 'w', catalog, usage: () => [] })).toThrow('No slate named nope');
});

test('a cut grant is every observing member plus exactly the approved ones that act', () => {
  const grant = cutShareGrant(graph, []);

  expect(grant.slates).toEqual(['issues', 'digest']);
  expect(grant.members).toEqual([
    { slate: 'issues', namespace: 'mcp.github', member: 'read_issue', impact: 'observe' },
    { slate: 'issues', namespace: 'workspace', member: 'readFile', impact: 'observe' },
    { slate: 'issues', namespace: 'memory', member: 'recall', impact: 'observe' },
    { slate: 'issues', namespace: 'tasks', member: 'list', impact: 'observe' },
    { slate: 'issues', namespace: 'web', member: 'search', impact: 'observe' },
    { slate: 'issues', namespace: 'reads', member: 'getExecutors', impact: 'observe' },
    { slate: 'issues', namespace: 'slates.digest', member: 'count', impact: 'observe' },
    { slate: 'digest', namespace: 'workspace', member: 'readFile', impact: 'observe' },
    { slate: 'digest', namespace: 'slates.issues', member: 'refresh', impact: 'observe' },
  ]);

  const approved = cutShareGrant(graph, [{ slate: 'issues', namespace: 'mcp.github', member: 'create_issue' }]);
  expect(approved.members).toEqual([...grant.members, { slate: 'issues', namespace: 'mcp.github', member: 'create_issue', impact: 'externalSend' }]);

  expect(grantAdmits(grant, 'issues', 'workspace', 'readFile')).toEqual({ slate: 'issues', namespace: 'workspace', member: 'readFile', impact: 'observe' });
  expect(grantAdmits(grant, 'issues', 'workspace', 'writeFile')).toBeNull();
  expect(grantAdmits(grant, 'digest', 'workspace', 'writeFile')).toBeNull();

  expect(() => cutShareGrant(graph, [{ slate: 'issues', namespace: 'workspace', member: 'readFile' }])).toThrow('is not a member of slate issues that acts');
  expect(() => cutShareGrant(graph, [{ slate: 'issues', namespace: 'workspace', member: 'remove' }])).toThrow('is not a member of slate issues that acts');
});

test('a dotted slate or server name is walked and looked up whole', () => {
  const dotted = slateCapabilityGraph({
    slate: 'root', workspace: 'w',
    catalog: { mcp: [{ server: 'files.prod', title: 'Files', tools: [{ name: 'read', readOnly: true }] }], slates: ['root', 'budget.board'] },
    usage: (slate) => (slate === 'root' ? used('slates.budget.board.count', 'mcp.files.prod.read') : used('memory.recall')),
  });

  expect(dotted.slates).toEqual(['root', 'budget.board']);
  expect(dotted.namespaces.map((each) => [each.slate, each.namespace, each.problem ?? null, each.members.map((member) => member.impact)])).toEqual([
    ['root', 'slates.budget.board', null, ['observe']],
    ['budget.board', 'memory', null, ['observe']],
    ['root', 'mcp.files.prod', null, ['observe']],
  ]);
});
