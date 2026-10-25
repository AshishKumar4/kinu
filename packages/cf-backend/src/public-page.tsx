import { diagnostics, KinuError } from '@kinu.run/core/obs';

import { startTheme } from '@/hooks/use-theme';
import "virtual:kinu-theme.css";
import './index.css';

/**
 * The root a public document draws its page in, its mode store started; null, reported, where the document has none.
 * Each document is its own entry, and none awaits at its top level: one top-level await anywhere in the client build
 * turns off the bundler's chunk merging for every entry (the app's first load went from 82 to 221 files under
 * rolldown's own splitting, rolldown 1.2.14, 2026-10-25).
 */
export function publicRoot(rootId: string): HTMLElement | null {
  const root = document.getElementById(rootId);

  if (root === null) {
    diagnostics.failure('public_page.root_missing', new KinuError('missing', `This document has no #${rootId} to draw its page in.`));

    return null;
  }

  // The head painted the mode (core's MODE_BOOT); from here the store holds it and follows the system.
  startTheme();

  return root;
}
