import type { EvalVerifier } from '../src/verifier';
import { defineTaskEval } from '../src/eval';
import { defineEvalTask } from '../src/task';

// A public repository cloned into the workspace and served twice, the way an engineer checks a site
// before touching it: a dev server in the workspace and one in the sandbox, each exposed and opened
// through its preview address; then a change to the page that both previews must show. Checked from
// outside: the cloned files over the files route, the ports each executor lists, and each preview
// fetched with no credential, as a person's browser opens it.

const MISSION = "Paperwing Studio's workspace. We keep our marketing site's sources here and preview changes before they ship.";

const REPOSITORY = 'https://github.com/octocat/Spoon-Knife';

const SITE_DIR = '/home/user/site';

/** Spoon-Knife has served this page unchanged since 2014 (d0dd1f61, read 2026-09-30). */
const PAGE_TITLE = '<title>Spoon-Knife</title>';

const PAGE_TEXT = 'Fork me? Fork you, @octocat!';

const NEW_TEXT = 'Launching Friday';

type Executor = 'workspace' | 'sandbox';

/** The preview addresses `executor` lists whose page holds `text`, and what every address answered. */
async function serving(verifier: EvalVerifier, executor: Executor, text: string): Promise<{ urls: string[]; answered: { url: string; status: number; holds: boolean }[] }> {
  const answered = await Promise.all((await verifier.previews(executor)).map(async ({ url }) => {
    const page = await verifier.open(url);

    return { url, status: page.status, holds: page.status === 200 && page.body.includes(PAGE_TITLE) && page.body.includes(text) };
  }));

  return { urls: answered.filter((answer) => answer.holds).map((answer) => answer.url), answered };
}

const bare = (url: string): string => url.trim().replace(/\/+$/, '');

async function checkPreview(verifier: EvalVerifier, id: string, executor: Executor, text: string): Promise<void> {
  await verifier.check(id, async () => {
    const found = await serving(verifier, executor, text);

    return { pass: found.urls.length > 0, evidence: found.answered };
  });
}

const task = defineEvalTask({
  id: 'site-preview',
  mission: MISSION,
  turns: [{
    prompt: `Clone ${REPOSITORY} into ${SITE_DIR}. Run a dev server for it in this workspace and expose its port,
then run one for it in the sandbox too and expose that port. Reply with exactly two lines: the workspace
preview URL, then the sandbox preview URL.`,
    verify: async (verifier) => {
      await verifier.check('the-repository-is-cloned', async () => {
        const [page, readme] = await Promise.all([verifier.readFile(`${SITE_DIR}/index.html`), verifier.readFile(`${SITE_DIR}/README.md`)]);

        return { pass: page.includes(PAGE_TITLE) && page.includes(PAGE_TEXT) && readme !== '', evidence: { page: page.slice(0, 300), readme: readme.slice(0, 200) } };
      });

      await checkPreview(verifier, 'the-workspace-previews-the-site', 'workspace', PAGE_TEXT);
      await checkPreview(verifier, 'the-sandbox-previews-the-site', 'sandbox', PAGE_TEXT);

      await verifier.check('the-reply-names-both-previews', async () => {
        const [workspace, sandbox] = await Promise.all([serving(verifier, 'workspace', PAGE_TEXT), serving(verifier, 'sandbox', PAGE_TEXT)]);
        const lines = (verifier.replies.at(-1) ?? '').split('\n').map((line) => bare(line.replace(/^[-*\d.\s]+|[`*]/g, ''))).filter((line) => line !== '');

        return {
          pass: lines.length === 2 && workspace.urls.map(bare).includes(lines[0] ?? '') && sandbox.urls.map(bare).includes(lines[1] ?? ''),
          evidence: { lines, workspace: workspace.urls, sandbox: sandbox.urls },
        };
      });
    },
  }, {
    prompt: `Change the page's paragraph to read "${NEW_TEXT}" and make both previews show it.`,
    verify: async (verifier) => {
      await checkPreview(verifier, 'the-workspace-preview-shows-the-change', 'workspace', NEW_TEXT);
      await checkPreview(verifier, 'the-sandbox-preview-shows-the-change', 'sandbox', NEW_TEXT);
    },
  }],
});

defineTaskEval(task);
