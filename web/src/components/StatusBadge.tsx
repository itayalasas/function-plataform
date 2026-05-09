import clsx from "clsx";

const map: Record<string, string> = {
  running: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  active: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  idle: "bg-slate-700/40 text-slate-300 border-slate-600",
  stopped: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  deploying: "bg-indigo-500/15 text-indigo-300 border-indigo-500/30 animate-pulse",
  error: "bg-rose-500/15 text-rose-300 border-rose-500/30",
};

export function StatusBadge({ status }: { status: string }) {
  const cls = map[status] || map.idle;
  return (
    <span className={clsx("chip", cls)}>
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
}
