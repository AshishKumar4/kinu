/** Which band a 0–1 score falls in. One ladder for every surface that grades
 *  a score — this bar and the swarm tree's node fill share it, so a threshold
 *  change lands in both places instead of one. */
export function scoreBand(value: number): "success" | "warning" | "danger" {
  return value >= 0.7 ? "success" : value >= 0.4 ? "warning" : "danger";
}

interface Props {
  value: number;
  className?: string;
}

const BAND_DOT = {
  success: "p-dot-success",
  warning: "p-dot-warning",
  danger: "p-dot-danger",
} as const;

function ScoreBar({ value, className }: Props) {
  const color = BAND_DOT[scoreBand(value)];
  return (
    <div className={`flex items-center gap-2 ${className ?? ""}`}>
      <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: "var(--c-border)" }}>
        <div className={`h-full rounded-full transition-all duration-500 ${color}`} style={{ width: `${value * 100}%` }} />
      </div>
      <span className="text-xs font-mono p-text-2 w-8 text-right">{value.toFixed(2)}</span>
    </div>
  );
}

export { ScoreBar };
