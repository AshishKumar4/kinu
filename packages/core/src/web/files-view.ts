/** How the Files tab draws a folder: an account's choice, kept in its user config so every device shows it the same. */
import * as v from 'valibot';

/** The user config row the account's Files view is kept in, as JSON text. */
export const FILES_VIEW_CONFIG_KEY = 'files_view';

const FilesViewSchema = v.object({
  layout: v.picklist(['list', 'tiles']),
  /** Hidden items (`isHiddenEntry`) listed, dimmed, among the rest. */
  hidden: v.boolean(),
});

const StoredFilesViewSchema = v.pipe(v.string(), v.parseJson(), FilesViewSchema);

export type FilesView = v.InferOutput<typeof FilesViewSchema>;

export const DEFAULT_FILES_VIEW: FilesView = { layout: 'tiles', hidden: false };

/** A stored or sent view the schema holds; null for any other. */
export function filesViewNamed(value: string | null | undefined): FilesView | null {
  const view = v.safeParse(StoredFilesViewSchema, value);

  return view.success ? view.output : null;
}

/** A stored value the schema holds; the default for no choice or any other. */
export function accountFilesView(stored: string | null): FilesView {
  return filesViewNamed(stored) ?? DEFAULT_FILES_VIEW;
}
