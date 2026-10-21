/**
 * The one unstyled clickable for a whole row or tile (docs/DESIGN-SYSTEM.md §2): a button with the system's hover wash
 * and focus ring and nothing else, so a feature never writes a raw `<button>` to make a block pressable.
 */
import type { ButtonHTMLAttributes } from "react";

export function Pressable({ className, type = "button", ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={`p-pressable${className === undefined ? "" : ` ${className}`}`} {...rest} />;
}
