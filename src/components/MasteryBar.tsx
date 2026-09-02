const STATUS_STYLES: Record<string, { chip: string; bar: string; label: string }> = {
  strong: { chip: "bg-green-100 text-green-800", bar: "bg-green-500", label: "Strong" },
  developing: { chip: "bg-amber-100 text-amber-800", bar: "bg-amber-500", label: "Developing" },
  weak: { chip: "bg-red-100 text-red-700", bar: "bg-red-500", label: "Weak" },
  untested: { chip: "bg-slate-100 text-slate-600", bar: "bg-slate-300", label: "Untested" },
};

export function MasteryBar({
  mastery,
  status,
  confidence,
}: {
  mastery: number;
  status: string;
  confidence?: number;
}) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.untested;
  const pct = Math.round(mastery * 100);
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${style.chip}`}>{style.label}</span>
        <span className="text-xs text-slate-500" title="Mastery estimate (0–100)">
          {status === "untested" ? "no data yet" : `${pct}%`}
          {confidence !== undefined && confidence > 0 && (
            <span title="Confidence grows with the number of attempts"> · conf {Math.round(confidence * 100)}%</span>
          )}
        </span>
      </div>
      <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
        <div className={`h-full ${style.bar} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
