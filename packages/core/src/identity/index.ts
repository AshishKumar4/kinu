export {
  createInlineWorkspace, inlineWorkspaceStorage, sqlStorageOver, wrapDatabase, type AgentDatabase,
} from './inline-primitives';

export {
  builtinAdmission, createBuiltinInvite, findPasskeyAccount, findPasswordAccount, hasBuiltinOwner, initBuiltinAccounts, invitedEmail, isBuiltinOwner,
  issuePasskeyChallenge, recordPasskeyUse, registerBuiltinAccount, spendPasskeyChallenge, type BuiltinSql,
  clearAttempts, replacePassword, reserveAttempt, NOT_ADMITTED, type AttemptBucket,
} from './builtin-accounts';

export type {
  Admission, ChallengePurpose, NewBuiltinAccount, NewInvite, PasskeyAccount, PasswordAccount, PasswordHash, PendingChallenge,
} from './builtin-accounts';

export { BUILTIN_ACCOUNTS_OBJECT } from './builtin-accounts';
