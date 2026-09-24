/**
 * Issue #28: an `eval` program drives a real slate as an object, `workspace.slates.<id>.<method>(...)`.
 * The whole path is production: the codemode sandbox, the workspace provider, the slate host and a
 * booted resident process. Workerd-only: the sandbox and the resident need `LOADER` and facets.
 */
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

// The issue's own program, with its one call written on the new surface.
const HOUSE = String.raw`// Draw a little house + sun on the whiteboard via addStroke calls
function circle(cx, cy, r, n=40) {
  const pts = [];
  for (let i=0;i<=n;i++) { const a = (i/n)*Math.PI*2; pts.push({x: cx + r*Math.cos(a), y: cy + r*Math.sin(a)}); }
  return pts;
}
const strokes = [
  { id: "house-body", color: "#111111", width: 4, tool: "pen",
    points: [{x:100,y:200},{x:100,y:320},{x:300,y:320},{x:300,y:200},{x:100,y:200}] },
  { id: "roof", color: "#e5484d", width: 4, tool: "pen",
    points: [{x:80,y:200},{x:200,y:120},{x:320,y:200}] },
  { id: "door", color: "#2563eb", width: 4, tool: "pen",
    points: [{x:180,y:320},{x:180,y:250},{x:220,y:250},{x:220,y:320}] },
  { id: "window", color: "#2563eb", width: 4, tool: "pen",
    points: [{x:240,y:240},{x:270,y:240},{x:270,y:270},{x:240,y:270},{x:240,y:240}] },
  { id: "sun", color: "#f59e0b", width: 4, tool: "pen",
    points: circle(400, 90, 32) },
  { id: "ground", color: "#16a34a", width: 4, tool: "pen",
    points: [{x:40,y:322},{x:480,y:322}] },
];
let last = null;
for (const s of strokes) {
  last = await workspace.slates.whiteboard.addStroke(s);
}
const drawn = await workspace.slates.whiteboard.strokes();
return { last, ids: drawn.map((s) => s.id), sunPoints: drawn[4].points.length, methods: (await workspace.slates.whiteboard.$methods()).sort() };`;

it('a program draws the issue house on a real whiteboard slate through workspace.slates', async () => {
  const subject = env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('whiteboard-house'));

  const answer: unknown = JSON.parse(await subject.programOnWhiteboard({
    workspace: 'slate-program', owner: 'program-owner', program: HOUSE,
  }));

  expect(answer).toMatchObject({
    result: {
      last: { count: 6 },
      ids: ['house-body', 'roof', 'door', 'window', 'sun', 'ground'],
      sunPoints: 41,
      methods: ['addStroke', 'strokes'],
    },
  });
});
