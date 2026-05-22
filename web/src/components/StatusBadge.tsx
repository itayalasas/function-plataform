import clsx from "clsx";

const map: Record<string, string> = {
  running: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  active: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  idle: "bg-slate-700/40 text-slate-300 border-slate-600",
  stopped: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  deploying: "bg-indigo-500/15 text-indigo-300 border-indigo-500/30 animate-pulse",
  validating: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30 animate-pulse",
  queued: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
  success: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  deprecated: "bg-slate-700/40 text-slate-400 border-slate-600",
  passed: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  warning: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  healthy: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  attention: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  pending: "bg-slate-700/40 text-slate-300 border-slate-600",
  not_configured: "bg-slate-700/40 text-slate-300 border-slate-600",
  over_budget: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  unavailable: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  remote_build: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
  available: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  failed: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  error: "bg-rose-500/15 text-rose-300 border-rose-500/30",
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const cls = map[status] || map.idle;
  return (
    <span className={clsx("chip", cls)}>
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {label || status}
    </span>
  );
}
