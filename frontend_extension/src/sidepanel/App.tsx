import { useCallback, useState } from "react";
import { MessageSquarePlus, ShieldCheck, Sparkles } from "lucide-react";

import ChatInterface, { ChatMessage } from "./components/ChatInterface";
import RedactionPreview, { RedactionSnapshot } from "./components/RedactionPreview";
import SafetyConfirmationModal, { PendingAction } from "./components/SafetyConfirmationModal";

import {
  getActiveTab,
  scrapeActivePage,
  captureAndRedactActiveTab,
  executeActionOnTab,
} from "./extensionBridge";
import { callInteract, ActionCommand, BackendError } from "./backendClient";

type Tab = "chat" | "transparency";

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export default function App() {
  const [sessionId, setSessionId] = useState(() => newId());
  const [activeTabName, setActiveTabName] = useState<Tab>("chat");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [redactionSnapshot, setRedactionSnapshot] = useState<RedactionSnapshot | null>(null);
  const [pendingAction, setPendingAction] = useState<
    (PendingAction & { command: ActionCommand; tabId: number }) | null
  >(null);
  const [isBusy, setIsBusy] = useState(false);
  const [lastSpokenText, setLastSpokenText] = useState<string | null>(null);
  const [lastPageCategory, setLastPageCategory] = useState<string | null>(null);

  const pushMessage = useCallback((msg: Omit<ChatMessage, "id" | "timestamp">) => {
    setMessages((prev) => [...prev, { ...msg, id: newId(), timestamp: Date.now() }]);
  }, []);

  const runTurn = useCallback(
    async (userQuery: string | null) => {
      setIsBusy(true);
      const pendingId = newId();
      setMessages((prev) => [
        ...prev,
        {
          id: pendingId,
          role: "assistant",
          text: "",
          isPending: true,
          timestamp: Date.now(),
        },
      ]);

      try {
        const tab = await getActiveTab();
        if (!tab) throw new Error("No active tab found. Open a page and try again.");

        const scrape = await scrapeActivePage(tab.id);
        if (!scrape?.ok) {
          throw new Error(scrape?.error ?? "Could not read this page (try reloading it).");
        }

        const capture = await captureAndRedactActiveTab(tab.id);

        const snapshot: RedactionSnapshot = {
          redactedImageB64: capture.ok ? capture.redactedImageB64 ?? null : null,
          regionsRedacted: capture.regionsRedacted ?? 0,
          maskedEntityCount: scrape.maskedEntityCount,
          timestamp: Date.now(),
        };
        setRedactionSnapshot(snapshot);

        const response = await callInteract({
          session_id: sessionId,
          url: scrape.url,
          title: scrape.title,
          user_query: userQuery,
          elements: scrape.elements,
          redacted_image_b64: snapshot.redactedImageB64,
          timestamp: Date.now() / 1000,
        });

        setLastPageCategory(response.page_category);
        const { action } = response;

        setMessages((prev) =>
          prev.map((m) =>
            m.id === pendingId
              ? {
                  ...m,
                  isPending: false,
                  text: action.speech_guidance || "Done.",
                  structuredData: action.extracted_data ?? undefined,
                }
              : m
          )
        );
        setLastSpokenText(action.speech_guidance || null);

        if (action.action_type === "none" || action.action_type === "extract") {
          return; // nothing to execute on the page
        }

        setPendingAction({
          actionType: action.action_type,
          targetLabel: action.target_selector || "the highlighted element",
          speechGuidance: action.speech_guidance,
          requiresConfirmation: action.requires_confirmation,
          command: action,
          tabId: tab.id,
        });
        return;
      } catch (err) {
        const message =
          err instanceof BackendError
            ? `Backend error (${err.status}): ${err.message}`
            : (err as Error).message;
        setMessages((prev) =>
          prev.map((m) => (m.id === pendingId ? { ...m, isPending: false, text: message } : m))
        );
      } finally {
        setIsBusy(false);
      }
    },
    [sessionId, pushMessage]
  );

  const handleSend = useCallback(
    (text: string) => {
      pushMessage({ role: "user", text });
      void runTurn(text);
    },
    [pushMessage, runTurn]
  );

  const handleApprove = useCallback(async () => {
    if (!pendingAction) return;
    const { command, tabId } = pendingAction;
    setPendingAction(null);
    const result = await executeActionOnTab(tabId, {
      action_type: command.action_type,
      target_selector: command.target_selector,
      target_bbox: command.target_bbox,
      tokenized_value: command.tokenized_value,
    });
    if (!result.ok) {
      pushMessage({ role: "system", text: `Action failed: ${result.error ?? "unknown error"}` });
    } else {
      pushMessage({ role: "system", text: "Action approved and completed." });
    }
  }, [pendingAction, pushMessage]);

  const handleAbort = useCallback(() => {
    setPendingAction(null);
    pushMessage({ role: "system", text: "Action aborted." });
  }, [pushMessage]);

  const handleNewChat = useCallback(() => {
    setSessionId(newId());
    setMessages([]);
    setRedactionSnapshot(null);
    setPendingAction(null);
    setLastSpokenText(null);
    setLastPageCategory(null);
    setActiveTabName("chat");
  }, []);

  return (
    <div className="flex h-screen flex-col bg-slate-950">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="rounded-full bg-accent/15 p-1.5">
            <Sparkles className="h-4 w-4 text-accent" />
          </div>
          <div>
            <h1 className="text-sm font-semibold text-slate-100">Edge Vision Assistant</h1>
            {lastPageCategory && (
              <p className="text-[11px] capitalize text-slate-400">{lastPageCategory} page</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleNewChat}
            disabled={isBusy}
            title="Start a new chat"
            aria-label="Start a new chat"
            className="rounded-full p-2 text-slate-300 transition hover:bg-white/10 hover:text-accent disabled:opacity-40"
          >
            <MessageSquarePlus className="h-4 w-4" />
          </button>
          <nav className="flex gap-1 rounded-full bg-white/5 p-1">
          {(["chat", "transparency"] as Tab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTabName(tab)}
              className={`rounded-full px-3 py-1 text-xs font-medium capitalize transition ${
                activeTabName === tab
                  ? "bg-accent text-slate-950"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {tab === "transparency" ? (
                <span className="flex items-center gap-1">
                  <ShieldCheck className="h-3 w-3" /> Privacy
                </span>
              ) : (
                "Chat"
              )}
            </button>
          ))}
          </nav>
        </div>
      </header>

      {/* Body */}
      <div className="relative flex-1 overflow-hidden">
        {activeTabName === "chat" ? (
          <div className="flex h-full flex-col">
            {redactionSnapshot && (
              <div className="px-4 pt-3">
                <RedactionPreview snapshot={redactionSnapshot} />
              </div>
            )}
            <div className="min-h-0 flex-1">
              <ChatInterface
                key={sessionId}
                messages={messages}
                onSend={handleSend}
                speakingText={lastSpokenText}
                disabled={isBusy}
              />
            </div>
          </div>
        ) : (
          <div className="h-full overflow-y-auto px-4 py-4">
            <RedactionPreview snapshot={redactionSnapshot} />
            <p className="mt-4 text-xs leading-relaxed text-slate-400">
              Every screenshot is redacted with solid black rectangles over faces, signatures,
              and sensitive text before it's rendered here or sent anywhere. Names, phone
              numbers, and government IDs are replaced with placeholder tokens like{" "}
              <code className="rounded bg-white/10 px-1 py-0.5 text-accent">&lt;PERSON_1&gt;</code>{" "}
              in-memory on this device — the real values never leave your browser.
            </p>
          </div>
        )}

      </div>

      <SafetyConfirmationModal
        pendingAction={pendingAction}
        onApprove={handleApprove}
        onAbort={handleAbort}
      />
    </div>
  );
}
