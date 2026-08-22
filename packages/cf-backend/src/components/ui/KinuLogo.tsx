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
      <svg
        aria-hidden="true"
        className={`${compact ? "size-[17px]" : "size-5"} shrink-0 p-gold`}
        viewBox="0 0 24 24"
      >
        <path
          d="M 11.52 2.1 Q 15.72 4.7 18.65 9.58 Q 16.33 16.2 5.18 21.4 L 4.42 20.6 Q 14.07 13.8 15.35 9.62 Q 13.08 7.7 8.88 5.1 Z"
          fill="currentColor"
        />
      </svg>
      <span className="font-semibold tracking-[.01em]">Kinu</span>
    </span>
  );
}
