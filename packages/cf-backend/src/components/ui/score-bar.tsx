interface Props {
  value: number;
  className?: string;
  showLabel?: boolean;
}

function ScoreBar({ value, className, showLabel = true }: Props) {
  const color = value >= 0.7 ? "p-dot-success" : value >= 0.4 ? "p-dot-warning" : "p-dot-danger";
  return (
    <div className={`flex items-center gap-2 ${className ?? ""}`}>
      <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: "var(--c-border)" }}>
        <div className={`h-full rounded-full transition-all duration-500 ${color}`} style={{ width: `${value * 100}%` }} />
      </div>
      {showLabel && <span className="text-xs font-mono p-text-2 w-8 text-right">{value.toFixed(2)}</span>}
    </div>
  );
}

export { ScoreBar };
