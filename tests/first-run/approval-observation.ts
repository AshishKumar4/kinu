export interface CheckboxCount {
  readonly boxes: number;
  readonly checked: number;
}

export function approvalClearsSelection(before: CheckboxCount, after: CheckboxCount): boolean {
  return before.boxes > 0 && before.checked > 0 && after.checked === 0;
}
