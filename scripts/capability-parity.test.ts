import { describe, expect, test } from 'bun:test';
import { findAsymmetries, keyOf } from './capability-parity';

const contracts = `
export interface WorkspaceAuthority { workspaceId: string; ownerUserId: string }
export interface ForkDestination {
  workspaceId: string; ownerUserId: string; destination: string;
  transaction?: (write: () => void) => void;
  writeSoulFile?: (text: string) => void;
}
`;

function survey(cli: string) {
  return findAsymmetries(new Map([
    ['packages/core/src/contracts.ts', contracts],
    ['packages/cf-backend/src/adapter.ts', `const target = { workspaceId: 'workspace', ownerUserId: 'owner', destination: 'fork', transaction: (write) => write(), writeSoulFile: (text) => persist(text) };`],
    ['packages/cli-backend/src/adapter.ts', cli],
  ])).asymmetries.map(keyOf);
}

describe('capability contract attribution', () => {
  test('a required-only authority is not a fork with missing optional effects', () => {
    expect(survey(`const authority = { workspaceId: 'workspace', ownerUserId: 'owner' };`)).toEqual([]);
  });

  test('a real fork omission stays red beside the narrower authority', () => {
    expect(survey(`
      const authority = { workspaceId: 'workspace', ownerUserId: 'owner' };
      const target = { workspaceId: 'workspace', ownerUserId: 'owner', destination: 'fork' };
    `)).toEqual([
      'asymmetry ForkDestination.transaction#absent-in-cli',
      'asymmetry ForkDestination.writeSoulFile#absent-in-cli',
    ]);
  });
});
