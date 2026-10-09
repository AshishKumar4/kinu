/** What `ask_owner` takes: one to four questions, each with two to four choices. The store is `plans/owner-questions.ts`. */
import * as v from 'valibot';

/** What the owner types in place of a choice; a question never offers it itself. */
export const OTHER_OPTION = 'Other';

const OptionSchema = v.strictObject({
  label: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(60), v.description('What the owner picks: one to five words.')),
  description: v.optional(v.pipe(v.string(), v.maxLength(400), v.description('What choosing it means: its tradeoff or consequence.'))),
  preview: v.optional(v.pipe(v.string(), v.maxLength(4000), v.description(
    'A mockup, code snippet or configuration shown in a monospace box beside the options, to compare; single-choice questions only.'))),
});

export const OwnerQuestionSchema = v.pipe(
  v.strictObject({
    id: v.pipe(v.string(), v.regex(/^[\w-]{1,40}$/u), v.description('A short id the answer names this question by, e.g. "auth".')),
    question: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(500), v.description('The whole question, ending in a question mark.')),
    header: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(12), v.description('A label of at most 12 characters shown as a chip, e.g. "Library".'))),
    options: v.pipe(v.array(OptionSchema), v.minLength(2), v.maxLength(4), v.description('Two to four distinct choices; "Other" is added for the owner.')),
    multi: v.optional(v.pipe(v.boolean(), v.description('The owner may pick several; the choices need not exclude each other.'))),
    recommended: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.description('The index of the option you recommend.'))),
  }),
  v.check((question) => question.recommended === undefined || question.recommended < question.options.length, 'recommended must index one of the options'),
  v.check((question) => new Set(question.options.map((option) => option.label.toLowerCase())).size === question.options.length, 'each option needs its own label'),
  v.check((question) => !question.options.some((option) => /^other\b/iu.test(option.label)), '"Other" is added for the owner; leave it out'),
  v.check((question) => question.multi !== true || question.options.every((option) => option.preview === undefined), 'a preview belongs to single-choice questions'),
);

export const AskOwnerInputSchema = v.strictObject({
  questions: v.pipe(
    v.array(OwnerQuestionSchema), v.minLength(1), v.maxLength(4), v.description('One to four related questions, asked together.'),
    v.check((questions) => new Set(questions.map((question) => question.id)).size === questions.length, 'each question needs its own id'),
  ),
});

export type OwnerQuestion = v.InferOutput<typeof OwnerQuestionSchema>;

