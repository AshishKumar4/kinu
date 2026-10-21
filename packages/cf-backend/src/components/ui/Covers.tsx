/**
 * What a file is, drawn as its tile's cover (docs/DESIGN-SYSTEM.md §2, Tiles): a picture, or its kind's glyph on the
 * recessed ground, or its first rows, lines or page as they read; an upload's progress, or why it failed. Each fills
 * the tile's 16:10 frame.
 */
import type { ReactNode } from "react";
import { WarningIcon } from "@phosphor-icons/react";

/** A picture as itself, else the kind's glyph large with its extension under it. */
export function GlyphCover({ icon, extension, image }: { icon: ReactNode; extension: string; image?: string }) {
  if (image !== undefined) return <img src={image} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" />;

  return (
    <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-sunken">
      <span className="p-cover-glyph p-text-3">{icon}</span>
      {extension !== "" && <span className="t-meta t-mono uppercase p-text-3">{extension}</span>}
    </span>
  );
}

/** A table's first rows: its head on the recessed ground, numbers to the right. */
export function SheetCover({ rows, numeric }: { rows: readonly (readonly string[])[]; numeric: readonly boolean[] }) {
  const columns = numeric.length;
  const grid = { gridTemplateColumns: `repeat(${String(columns)}, minmax(0, 1fr))` };

  return (
    <span className="t-meta absolute inset-0 overflow-hidden p-surface">
      {rows.map((row, index) => (
        <span key={index} data-drive-sheet-row style={grid}
          className={`grid gap-2 px-4 ${index === 0 ? "t-status p-sunken py-2 p-text-2" : "t-mono border-t p-border py-1 p-text-3"}`}>
          {row.slice(0, columns).map((cell, column) => <span key={column} className={`truncate ${numeric[column] === true ? "text-right" : ""}`}>{cell}</span>)}
        </span>
      ))}
    </span>
  );
}

/** A source file's first lines, numbered. */
export function CodeCover({ lines }: { lines: readonly string[] }) {
  return (
    <span className="t-meta t-mono absolute inset-0 overflow-hidden p-sunken px-3 pt-3">
      {lines.map((line, index) => (
        <span key={index} data-drive-code-line className="flex gap-3">
          <span className="min-w-3 shrink-0 text-right tabular-nums p-text-3">{index + 1}</span>
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-pre p-text-3">{line === "" ? "\u00a0" : line}</span>
        </span>
      ))}
    </span>
  );
}

/** A document's first page: its title, then its lines, its headings a step darker. */
export function PageCover({ heading, lines }: { heading: string | null; lines: readonly { readonly text: string; readonly heading: boolean }[] }) {
  return (
    <span className="p-page-cover absolute inset-0 overflow-hidden p-sunken">
      <span className="t-meta block h-full overflow-hidden rounded-t-[var(--r-inner)] border border-b-0 p-border p-surface px-3 pt-2 p-text-3">
        {heading !== null && <span data-drive-page-heading className="t-micro mb-1 block truncate p-text">{heading}</span>}
        {lines.map((line, index) => (
          <span key={index} data-drive-page-line className={`block truncate ${line.heading ? "t-status mt-px p-text-2" : ""}`}>
            {line.text === "" ? "\u00a0" : line.text}
          </span>
        ))}
      </span>
    </span>
  );
}

/** An upload under way, by the share of it gone; or refused, by a danger mark. */
export function TransferCover({ failed, percent }: { failed: boolean; percent: number }) {
  if (failed) return <span className="absolute inset-0 flex items-center justify-center p-sunken"><WarningIcon size={24} className="p-danger" /></span>;

  return (
    <span className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-sunken">
      <span className="t-meta tabular-nums p-text-2">{percent}%</span>
      <span role="progressbar" aria-label="Uploading" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}
        className="h-1 w-1/2 overflow-hidden rounded-[var(--r-pill)] bg-[var(--c-border-strong)]">
        <span className="block h-full rounded-[var(--r-pill)] bg-[var(--c-accent-mark)] transition-[width] duration-[var(--dur-state)]" style={{ width: `${String(percent)}%` }} />
      </span>
    </span>
  );
}
