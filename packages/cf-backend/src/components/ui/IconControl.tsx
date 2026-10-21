/**
 * An icon that is a control in the app's own chrome (docs/DESIGN-SYSTEM.md §2, IconButton): the workspace bar, a tab, a
 * chat pill, the composer. The third ink until the pointer or the keys are on it, then the text's on the hover wash; a
 * `danger` one turns danger. One shape per place: `bar` a 28 square, `tab` a 22 square inside a tab (20 inside a
 * page's), `pill` a 26 circle, `composer` a 32 circle. A button where it acts, a link where it goes somewhere.
 */
import type { ComponentProps } from "react";
import { Link } from "react-router-dom";

export type IconPlace = "bar" | "tab" | "pill" | "composer";

const look = (place: IconPlace, className: string | undefined) => `p-icon-control p-icon-control-${place}${className === undefined ? "" : ` ${className}`}`;

export function IconControl({ place, danger = false, className, type = "button", ...rest }: ComponentProps<"button"> & { place: IconPlace; danger?: boolean }) {
  return <button type={type} className={look(place, className)} data-danger={danger ? "" : undefined} {...rest} />;
}

export function IconLink({ place, className, ...rest }: ComponentProps<typeof Link> & { place: IconPlace }) {
  return <Link className={look(place, className)} {...rest} />;
}

/** To a file or page outside the app: a download, a picture at full size. */
export function IconAnchor({ place, className, ...rest }: ComponentProps<"a"> & { place: IconPlace }) {
  return <a className={look(place, className)} {...rest} />;
}
