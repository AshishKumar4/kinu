import type { HTMLAttributes } from "react";

function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`animate-pulse rounded-lg ${className ?? ""}`} style={{ background: "var(--c-border)" }} {...props} />;
}

export { Skeleton };
