/** The account's palette: one row of the user config, which the server names on every signed-in page before it paints. */
import { DEFAULT_THEME, THEME_NAMES, themeNamed, type ThemeName } from '@kinu.run/core';

export const THEME_CONFIG_KEY = 'theme';

/** A stored value the table names; the default for no choice or any other. */
export function accountTheme(stored: string | null): ThemeName {
  return themeNamed(stored) ?? DEFAULT_THEME;
}

export const THEME_CHOICES = THEME_NAMES.join(', ');
