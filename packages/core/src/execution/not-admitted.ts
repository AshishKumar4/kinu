/**
 * A call sent once more when Nimbus answers that its process's replacement refused it at admission
 * (`ProcessNotAdmitted`, ask 63): it ran nowhere, and the old process reads exited before that answer, so the next send
 * reaches a new one. Only Nimbus's own class: an error a program throws crosses as a plain one, whatever its name.
 */
import { Effect } from 'effect';
import { ProcessNotAdmitted } from '@nimbus-sh/core/runtime/os-contracts.js';
import { settle } from '../obs/index';

export function onceMoreIfNotAdmitted<T>(send: () => Promise<T>): Promise<T> {
  return settle(Effect.promise(send).pipe(
    Effect.catchDefect((defect) => (defect instanceof ProcessNotAdmitted ? Effect.promise(send) : Effect.die(defect))),
  ));
}
