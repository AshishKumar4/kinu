import type { ReactElement } from "react";

export interface KinuLogoProps {
  className?: string;
  compact?: boolean;
}

export function KinuLogo({ className, compact = false }: KinuLogoProps): ReactElement {
  return (
    <span
      className={`inline-flex items-center gap-[9px] font-serif ${compact ? "text-[18px]" : "text-[20px]"}${className ? ` ${className}` : ""}`}
    >
      <span aria-hidden="true" className="inline-block rotate-12 leading-none p-gold">❯</span>
      <span className="font-semibold tracking-[.01em]">Kinu</span>
    </span>
  );
}
