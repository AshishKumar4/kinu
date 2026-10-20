/**
 * The one button (design review 2026-10-20). Two sizes: `md` (32) for page, dialog and flow actions (header actions,
 * Install, Compose, New, Connect, Next), `sm` (28) in rows and cards (Disconnect, Reply, Test, Save). Four looks at r8:
 * `primary` (brass, one per view), `secondary` (surface with an edge), `ghost` (ink only) and `danger` (the secondary
 * shape in danger ink); `destructive` (filled danger) is the confirm dialog's alone. A call site never sizes the box.
 */
import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "destructive";

export type ButtonSize = "md" | "sm";

/** The classes for anything drawn as a button, a link included. `iconOnly`: a square of the size's height. */
export function buttonClass({ variant = "secondary", size = "md", iconOnly = false }: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  iconOnly?: boolean;
} = {}): string {
  return `p-button p-button-${size} p-button-${variant}${iconOnly ? " p-button-icon" : ""}`;
}

/** A page's primary action on a phone: the 32 square of its icon, its label hidden (`max-sm:hidden` on the label). */
export const ICON_ON_PHONE = "max-sm:!w-8 max-sm:!px-0";

export function Button({ variant = "secondary", size = "md", icon, className, type = "button", children, ...rest }: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Before the label; alone, it is the whole button and `aria-label` names it. */
  icon?: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const iconOnly = children === undefined || children === null || children === false;
  // Layout only (a margin, `shrink-0`, `max-sm:` collapse); the box itself is the variant's and the size's.
  const extra = className === undefined ? "" : ` ${className}`;

  return (
    <button type={type} className={`${buttonClass({ variant, size, iconOnly })}${extra}`} {...rest}>
      {icon}
      {children}
    </button>
  );
}
