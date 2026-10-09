// Three rows as a suite runs them under a runner's bound (`endedNearSilence`): the first waits on what never comes,
// as the approval-stack flow waited on staging d930f2537, and the two after it answer. Prints each row's verdict.
import { endedNearSilence, rowVerdicts } from '../../row-verdicts';

const { attempt, broken } = rowVerdicts('rows', () => null);

const ended: string[] = [];

const row = (name: string, work: Promise<string>) => attempt(name, () => endedNearSilence(work, async () => { ended.push(name); }, () => `${name}'s stack cleared`));

const verdicts = [
  await row('hangs', new Promise<string>(() => undefined)),
  await row('answers', Promise.resolve('answered')),
  await row('answers too', Promise.resolve('answered too')),
];

console.log(JSON.stringify({ verdicts, ended, broke: broken() }));
