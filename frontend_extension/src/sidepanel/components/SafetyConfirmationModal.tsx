import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle, X, Check } from "lucide-react";

export interface PendingAction {
  actionType: string;
  targetLabel: string;
  speechGuidance: string;
  requiresConfirmation: boolean;
}

interface SafetyConfirmationModalProps {
  pendingAction: PendingAction | null;
  onApprove: () => void;
  onAbort: () => void;
}

export default function SafetyConfirmationModal({
  pendingAction,
  onApprove,
  onAbort,
}: SafetyConfirmationModalProps) {
  return (
    <AnimatePresence>
      {pendingAction && (
        <motion.div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onAbort}
        >
          <motion.div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="safety-modal-title"
            className="glass-card w-full max-w-sm p-5 mb-4"
            initial={{ y: 24, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 24, opacity: 0 }}
            transition={{ type: "spring", damping: 22, stiffness: 260 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="mt-0.5 shrink-0 rounded-full bg-amber-400/15 p-2">
                <AlertTriangle className="h-5 w-5 text-amber-400" strokeWidth={2} />
              </div>
              <div className="min-w-0">
                <h2 id="safety-modal-title" className="text-sm font-semibold text-slate-100">
                  {pendingAction.requiresConfirmation ? "Confirm this action" : "Ready for the next step?"}
                </h2>
                <p className="mt-1 text-sm text-slate-300">{pendingAction.speechGuidance}</p>
                <div className="mt-3 rounded-lg border border-white/10 bg-white/5 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-slate-400">
                    {pendingAction.actionType}
                  </p>
                  <p className="text-sm text-slate-200 truncate">{pendingAction.targetLabel}</p>
                </div>
              </div>
            </div>

            <div className="mt-5 flex gap-2">
              <button
                onClick={onAbort}
                className="flex-1 flex items-center justify-center gap-1.5 rounded-xl border border-white/15 bg-white/5 px-3 py-2.5 text-sm font-medium text-slate-200 transition hover:bg-white/10"
              >
                <X className="h-4 w-4" />
                Abort
              </button>
              <button
                onClick={onApprove}
                className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-accent px-3 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-accent-dim accent-glow"
              >
                <Check className="h-4 w-4" />
                {pendingAction.requiresConfirmation ? "Approve Action" : "Next"}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
