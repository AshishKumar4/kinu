/** A line of something still being read (docs/DESIGN-SYSTEM.md §2, loading): a bar on the fill, `width` of its row. */
export function Skeleton({ width, className }: { width: string; className?: string }) {
  return <span aria-hidden className={`p-skeleton${className === undefined ? "" : ` ${className}`}`} style={{ width }} />;
}
