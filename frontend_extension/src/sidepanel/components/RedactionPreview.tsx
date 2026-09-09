import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ShieldCheck, ChevronDown, EyeOff } from "lucide-react";

export interface RedactionSnapshot {
  redactedImageB64: string | null;
  regionsRedacted: number;
  maskedEntityCount: number;
  timestamp: number;
}

interface RedactionPreviewProps {
  snapshot: RedactionSnapshot | null;
}

export default function RedactionPreview({ snapshot }: RedactionPreviewProps) {
  const [expanded, setExpanded] = useState(false);

  if (!snapshot) return null;

  const hasMasking = snapshot.regionsRedacted > 0 || snapshot.maskedEntityCount > 0;

  return (
    <div className="glass-card overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className="shrink-0 rounded-full bg-accent/15 p-1.5">
            <ShieldCheck className="h-4 w-4 text-accent" strokeWidth={2} />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-100">Privacy Shield</p>
            <p className="text-xs text-slate-400 truncate">
              {hasMasking
                ? `${snapshot.regionsRedacted} region${snapshot.regionsRedacted === 1 ? "" : "s"} blacked out · ${snapshot.maskedEntityCount} entit${snapshot.maskedEntityCount === 1 ? "y" : "ies"} tokenized`
                : "No sensitive content detected on this view"}
            </p>
          </div>
        </div>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="border-t border-white/10 px-4 py-3">
              <p className="mb-2 text-xs text-slate-400">
                This is exactly what the backend sees — nothing more.
              </p>
              {snapshot.redactedImageB64 ? (
                <img
                  src={`data:image/jpeg;base64,${snapshot.redactedImageB64}`}
                  alt="Redacted view sent to the backend"
                  className="w-full rounded-lg border border-white/10"
                />
              ) : (
                <div className="flex items-center gap-2 rounded-lg border border-dashed border-white/15 px-3 py-4 text-xs text-slate-500">
                  <EyeOff className="h-4 w-4" />
                  No screenshot captured for this turn — text-only reasoning.
                </div>
              )}
              <div className="mt-3 flex gap-2">
                <span className="rounded-full bg-white/5 px-2.5 py-1 text-[11px] text-slate-300">
                  {snapshot.regionsRedacted} blacked-out region{snapshot.regionsRedacted === 1 ? "" : "s"}
                </span>
                <span className="rounded-full bg-white/5 px-2.5 py-1 text-[11px] text-slate-300">
                  {snapshot.maskedEntityCount} tokenized entit{snapshot.maskedEntityCount === 1 ? "y" : "ies"}
                </span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
