import { defineTaskEval } from '../src/eval';
import { defineEvalTask } from '../src/task';

// Facts an owner hands the agent to keep, one of them corrected a turn later; then the workspace restarts, the chat is
// cleared, and a new conversation asks for them. Nothing of the first two turns is in that conversation, so the answer
// comes from what the agent kept in memory, and the corrected fact must replace the old one.

const MISSION = "Juniper Row Bakery's workspace. We run two shops and keep our suppliers, accounts and codes here.";

const CLOSED_ACCOUNT = 'HM-48213';

const ACCOUNT = 'HM-90577';

const ALARM_CODE = '7341';

const task = defineEvalTask({
  id: 'memory-recall',
  mission: MISSION,
  turns: [{
    prompt: `Some things to keep for later, please. Our flour supplier is Hollins Mill and our account number there is
${CLOSED_ACCOUNT}. The back-door alarm code at the Elm Street shop is ${ALARM_CODE}. I'll ask for these in a new chat.`,
  }, {
    prompt: `A correction: Hollins Mill moved us to a new account last week. Our account number there is now ${ACCOUNT}, and
${CLOSED_ACCOUNT} is closed. Keep the new one, not the old.`,
  }, {
    fresh: true,
    prompt: "What's our account number at the flour supplier, and the back-door alarm code at the Elm Street shop? Reply with just the two, separated by a comma.",
    verify: async (verifier) => {
      const answer = verifier.bareAnswer(/^([A-Z]{2}-\d{5}\s*,\s*\d{4})$/);
      const [account, code] = (answer ?? '').split(',').map((part) => part.trim());

      await verifier.check('recalls-the-corrected-account', async () => ({
        pass: account === ACCOUNT, evidence: { account, expected: ACCOUNT, closed: CLOSED_ACCOUNT, replies: verifier.recentReplies() },
      }));

      await verifier.check('recalls-the-alarm-code', async () => ({
        pass: code === ALARM_CODE, evidence: { code, expected: ALARM_CODE, replies: verifier.recentReplies() },
      }));
    },
  }],
});

defineTaskEval(task);
