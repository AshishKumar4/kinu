/** Field-name judgment shared by the action tools: a field outside the called action is refused, naming the one meant. */

const MAX_FIELD_EDIT_DISTANCE = 2;

/** Normalizes naming convention so `budgetUsd`, `budget-usd` and `Budget USD` reach `budget_usd`. */
const FIELD_NAME_SEPARATORS = /[^a-z0-9]/gi;

/** Levenshtein distance, abandoned once a row exceeds `limit`; returns `limit + 1` for "too far". */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);

  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    let best = i;

    for (let j = 1; j <= b.length; j += 1) {
      const substitute = diagonal + (a[i - 1] === b[j - 1] ? 0 : 1);
      diagonal = row[j];
      const next = Math.min(substitute, row[j] + 1, row[j - 1] + 1);
      row[j] = next;

      if (next < best) best = next;
    }

    if (best > limit) return limit + 1;
  }

  return row[b.length];
}

/** The field `name` was probably meant to be (convention, then one or two edits), or undefined. */
export function nearestField(name: string, candidates: readonly string[]): string | undefined {
  const target = name.replace(FIELD_NAME_SEPARATORS, '').toLowerCase();
  let nearest: string | undefined;
  let shortest = MAX_FIELD_EDIT_DISTANCE + 1;

  for (const candidate of candidates) {
    const collapsed = candidate.replace(FIELD_NAME_SEPARATORS, '').toLowerCase();
    const distance = editDistance(target, collapsed, MAX_FIELD_EDIT_DISTANCE);

    if (distance >= shortest) continue;
    nearest = candidate;
    shortest = distance;

    if (distance === 0) break;
  }

  return nearest;
}

/**
 * What is wrong with the field names a call to `action` sent, or undefined. `fields` names every action's
 * fields; `action` itself is never judged here, the tool's enum refuses an unknown one.
 */
export function actionFieldRefusal<Action extends string>(input: {
  readonly fields: Readonly<Record<Action, readonly string[]>>;
  readonly action: Action;
  readonly sent: readonly string[];
}): string | undefined {
  const { fields, action } = input;
  const actions = Object.keys(fields).filter((name): name is Action => Object.hasOwn(fields, name));
  const readers = (field: string) => actions.filter((other) => fields[other].includes(field)).join('/');
  const known = [...new Set(actions.flatMap((other) => fields[other]))];
  const problems: string[] = [];

  for (const field of input.sent) {
    if (field === 'action' || fields[action].includes(field)) continue;

    if (known.includes(field)) {
      problems.push(`field "${field}" does not apply to action "${action}": it is read by ${readers(field)}.`);
      continue;
    }

    const meant = nearestField(field, fields[action]);

    if (meant !== undefined) {
      problems.push(`unknown field "${field}": did you mean "${meant}"?`);
      continue;
    }

    const elsewhere = nearestField(field, known);

    problems.push(elsewhere === undefined
      ? `unknown field "${field}".`
      : `unknown field "${field}": "${elsewhere}" is read by ${readers(elsewhere)}, not ${action}.`);
  }

  if (problems.length === 0) return undefined;

  return `${problems.join(' ')} action "${action}" takes: ${fields[action].join(', ')}.`;
}
