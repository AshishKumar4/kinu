/**
 * An account's class, read from its email and its standing: an operator's email is listed by the deployment, an eval
 * account's is the eval identity's own or one it names, and only an operator sets an account invited.
 */
import { evalAccountEmail, isEvalAccountEmail, LIMITED_EVAL_ACCOUNT } from '../cloud-wire';
import type { AccountClass } from './policy';
import type { Standing } from './store';

export function accountClassOf(input: {
  readonly email: string;
  /** Whether the deployment lists the email as an operator's (`CONTROL_PLANE_ADMINS`). */
  readonly operator: boolean;
  /** The deployment's eval identity (`DEV_USER_EMAIL`); '' where it has none. */
  readonly devEmail: string;
  readonly standing: Standing;
}): AccountClass {
  const { email, devEmail, standing } = input;

  if (input.operator) return 'operator';

  // Every eval account is exempt but one, which the deployed flow test of the limits runs as.
  if (isEvalAccountEmail(devEmail, email) && email !== evalAccountEmail(devEmail, LIMITED_EVAL_ACCOUNT)) return 'eval';

  return standing.class;
}
