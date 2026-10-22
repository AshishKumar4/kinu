/**
 * The one button (design review 2026-10-20). Two sizes: `md` (32) for page, dialog and flow actions (header actions,
 * Install, Compose, New, Connect, Next), `sm` (28) in rows and cards (Disconnect, Reply, Test, Save); and `lg` (38, the
 * public pages' 14) for a signed-out public page's call to action alone. Four looks at r8:
 * `primary` (brass, one per view), `secondary` (surface with an edge), `ghost` (ink only) and `danger` (the secondary
 * shape in danger ink); `destructive` (filled danger) is the confirm dialog's alone. A call site never sizes the box.
 */
import type { ComponentProps, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "destructive";

/** `lg` is a public page's call to action only (role.public-control): the deploy flow's Continue and Deploy. */
export type ButtonSize = "lg" | "md" | "sm";

/** The classes for anything drawn as a button, a link included. `iconOnly`: a square of the size's height. */
export function buttonClass({ variant = "secondary", size = "md", iconOnly = false }: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  iconOnly?: boolean;
} = {}): string {
  return `p-button p-button-${size} p-button-${variant}${iconOnly ? " p-button-icon" : ""}`;
}

/** A page's or a tool's primary on a phone: the 32 square of its icon, its label hidden (`max-sm:hidden` on the label). */
export const ICON_ON_PHONE = "max-sm:!size-8 max-sm:!px-0";

export function Button({ variant = "secondary", size = "md", icon, busy = false, className, type = "button", children, disabled, ...rest }: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Before the label; alone, it is the whole button and `aria-label` names it. */
  icon?: ReactNode;
  /** Working: a spinner takes the icon's place and the button holds its width, pressed no more until it is done. */
  busy?: boolean;
} & ComponentProps<"button">) {
  const iconOnly = children === undefined || children === null || children === false;
  // Layout only (a margin, `shrink-0`, `max-sm:` collapse); the box itself is the variant's and the size's.
  const extra = className === undefined ? "" : ` ${className}`;

  return (
    <button type={type} className={`${buttonClass({ variant, size, iconOnly })}${extra}`} disabled={disabled === true || busy} aria-busy={busy || undefined} {...rest}>
      {busy ? <span aria-hidden className="p-button-spinner" /> : icon}
      {children}
    </button>
  );
}
