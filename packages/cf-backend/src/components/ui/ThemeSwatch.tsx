/** A page in miniature, drawn in a look's own tokens: rail, ground, a card with two lines of text and a brass action. */
import type { ThemeName } from "@kinu.run/core";
import type { ThemeMode } from "@/hooks/use-theme";

export function ThemeSwatch({ theme, mode }: { theme: ThemeName; mode: ThemeMode }) {
  return (
    <span data-theme={theme} data-mode={mode} aria-hidden="true"
      className="flex h-21 overflow-hidden rounded-[var(--r-row)] border border-[var(--c-border)] bg-[var(--c-bg)]">
      <span className="flex w-1/4 flex-col gap-2 border-r border-[var(--c-border)] bg-[var(--c-sidebar)] p-2">
        <span className="h-1.5 w-3/4 rounded-[var(--r-pill)] bg-[var(--c-selected)]" />
        <span className="h-1.5 w-1/2 rounded-[var(--r-pill)] bg-[var(--c-hover)]" />
        <span className="h-1.5 w-2/3 rounded-[var(--r-pill)] bg-[var(--c-hover)]" />
      </span>
      <span className="flex flex-1 flex-col justify-center p-2">
        <span className="flex flex-col gap-2 rounded-[var(--r-inner)] border border-[var(--c-border)] bg-[var(--c-surface)] p-2">
          <span className="h-1.5 w-4/5 rounded-[var(--r-pill)] bg-[var(--c-text)]" />
          <span className="h-1.5 w-3/5 rounded-[var(--r-pill)] bg-[var(--c-text-3)]" />
          <span className="mt-px h-2.5 w-8 self-end rounded-[var(--r-pill)] bg-[var(--c-accent)]" />
        </span>
      </span>
    </span>
  );
}
