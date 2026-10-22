/** Text as it is (docs/DESIGN-SYSTEM.md §1.3, code): code's face on the recessed ground at the inner radius, its lines kept. */
import type { ComponentProps } from "react";

export function Preformatted({ className, wrap = true, ...rest }: ComponentProps<"pre"> & {
  /** Long lines wrap; off, they scroll sideways. */
  wrap?: boolean;
}) {
  return <pre className={`p-preformatted t-code${wrap ? " p-preformatted-wrap" : ""}${className === undefined ? "" : ` ${className}`}`} {...rest} />;
}
