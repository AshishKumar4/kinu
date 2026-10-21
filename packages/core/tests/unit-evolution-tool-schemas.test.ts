// What evolution edits as a tool's field text is the field text that tool offers: both read the one catalog, so an
// operation the catalog adds to a native tool, or keeps off it, shows in evolution's schemas too.
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { bundledArtifact, toolArtifact } from '../src/evolution/artifacts';
import { fieldDescriptions } from '../src/tools/tool-text';
import { nativeTool } from '../src/tools/operation-surfaces';
import { serveWeb } from '../src/tools/web-operations';
import { BUILTIN_TOOL_DESCRIPTIONS } from '../src/tools/registry';
import { createTestWorkspace, fileToolOver } from './helpers';
import type { WebSearchProvider } from '../src/web/provider';
import { TurnFileLedger } from '../src/vfs/file-ledger';
import { TurnContextBudget } from '../src/context-budget';
import { WORKSPACE_ROOT } from '../src/vfs/workspace-path';
import { cloudPlanes } from '../src/vfs/resolve';

/** A provider no schema read ever calls. */
const uncalled = async (): Promise<never> => { throw new Error('a schema read called the provider'); };

const UNCALLED: WebSearchProvider = { search: uncalled, fetch: uncalled, render: uncalled, screenshot: uncalled };

const evolved = (tool: string) => v.parse(v.record(v.string(), v.string()), JSON.parse(bundledArtifact(toolArtifact(tool, 'schema')) ?? 'null'));

describe("evolution's tool schemas are the tools' own", () => {
  test('the web tool', () => {
    const tool = nativeTool(BUILTIN_TOOL_DESCRIPTIONS.web, serveWeb({ provider: UNCALLED, files: null }));

    expect(evolved('web')).toEqual(fieldDescriptions(tool.inputSchema));
  });

  test('the file tool', () => {
    const { vfs } = createTestWorkspace();
    const tool = fileToolOver({ home: WORKSPACE_ROOT, planes: cloudPlanes(WORKSPACE_ROOT), vfs, ledger: new TurnFileLedger(), budget: new TurnContextBudget() });

    expect(evolved('file')).toEqual(fieldDescriptions(tool.inputSchema));
  });
});
