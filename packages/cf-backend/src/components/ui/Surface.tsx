/**
 * The design system's named grounds (docs/DESIGN-SYSTEM.md §1.2, §1.5): a box takes its ground, edge and radius from
 * one of these looks, never from classes of its own. `page` the page's ground; `chrome` the sidebar's; `panel` a card's
 * ground, edge and radius; `sheet` the surface alone; `well` the recessed ground of text as it is; `tile` the fill of a
 * small mark; `wash` the hover wash at rest; `selected` the selected ground; `outlined` an edge alone; `round` a circle;
 * `clip` a picture's corners. `as` is the element it is; `className` places it and lays out what is inside.
 */
import { createElement, type AllHTMLAttributes, type IframeHTMLAttributes, type ImgHTMLAttributes, type ReactNode, type Ref } from "react";

export type SurfaceLook = "page" | "chrome" | "panel" | "sheet" | "well" | "tile" | "wash" | "selected" | "outlined" | "round" | "clip";

type SurfaceTag = "div" | "span" | "section" | "aside" | "header" | "footer" | "li" | "ul" | "ol" | "pre" | "code" | "nav" | "main" | "article" | "figure" | "img" | "p" | "label" | "a" | "iframe" | "video";

export function Surface({ look, round = false, as: Tag = "div", className, children, ...rest }: {
  look: SurfaceLook;
  /** A circle or a pill of the look's ground: an avatar, a count, a dot. */
  round?: boolean;
  as?: SurfaceTag;
  className?: string;
  children?: ReactNode;
  /** The element's ref, typed as the `div` most surfaces are. */
  ref?: Ref<HTMLDivElement>;
} & Omit<AllHTMLAttributes<HTMLElement>, "className" | "children" | "as">
  & Pick<ImgHTMLAttributes<HTMLElement>, "loading" | "decoding" | "referrerPolicy">
  & Pick<IframeHTMLAttributes<HTMLElement>, "sandbox" | "allow">
  & Readonly<Record<`data-${string}`, string | number | boolean | undefined>>) {
  return createElement(Tag, { className: `p-surface-${look}${round ? " p-surface-round" : ""}${className === undefined ? "" : ` ${className}`}`, ...rest }, children);
}
