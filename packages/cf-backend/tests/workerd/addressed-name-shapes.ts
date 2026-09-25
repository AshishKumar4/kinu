/** What each entry answered after an id-addressed first entry: `served`, the owner id, the seed status, or a thrown chain. */
export interface AddressedAnswers {
  readonly supervisor: string;
  readonly claim: string;
  readonly seed: string;
}
