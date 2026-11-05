/** A line of something still being read (docs/DESIGN-SYSTEM.md §2, loading): a bar on the fill a light crosses, `width`
 *  of its row, where the text will sit. */
export function Skeleton({ width = "100%" }: { width?: string }) {
  return <span aria-hidden className="p-skeleton p-skeleton-bar" style={{ width }} />;
}
