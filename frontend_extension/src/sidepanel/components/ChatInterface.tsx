import React, { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Bot, User, Loader2, Send } from "lucide-react";
import VoiceController from "./VoiceController";

export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  structuredData?: Record<string, unknown> | null;
  isPending?: boolean;
  timestamp: number;
}

interface ChatInterfaceProps {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  speakingText: string | null;
  disabled?: boolean;
}

/** Very small, safe subset of markdown: **bold**, `code`, and line breaks.
 * No external markdown library is used (nothing is rendered as raw HTML),
 * so this can never introduce an injection surface from model output. */
function renderInline(text: string): React.ReactNode[] {
  const tokens = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return tokens.map((token, i) => {
    if (token.startsWith("**") && token.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold text-slate-50">
          {token.slice(2, -2)}
        </strong>
      );
    }
    if (token.startsWith("`") && token.endsWith("`")) {
      return (
        <code key={i} className="rounded bg-white/10 px-1 py-0.5 text-[12px] text-accent">
          {token.slice(1, -1)}
        </code>
      );
    }
    return <React.Fragment key={i}>{token}</React.Fragment>;
  });
}

function StructuredDataTable({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data);
  if (entries.length === 0) return null;

  // If every value is a primitive, render as a simple key/value table.
  const allPrimitive = entries.every(([, v]) => typeof v !== "object" || v === null);

  if (allPrimitive) {
    return (
      <div className="mt-2 overflow-hidden rounded-lg border border-white/10">
        <table className="w-full text-xs">
          <tbody>
            {entries.map(([key, value]) => (
              <tr key={key} className="border-b border-white/5 last:border-0">
                <td className="px-3 py-1.5 text-slate-400">{key}</td>
                <td className="px-3 py-1.5 text-right text-slate-100">{String(value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-white/10 bg-black/30 p-3 text-[11px] text-slate-300">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className={`flex gap-2.5 ${isUser ? "flex-row-reverse" : ""}`}
    >
      <div
        className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
          isUser ? "bg-accent/20" : "bg-white/10"
        }`}
      >
        {isUser ? (
          <User className="h-3.5 w-3.5 text-accent" />
        ) : (
          <Bot className="h-3.5 w-3.5 text-slate-300" />
        )}
      </div>
      <div className={`max-w-[80%] ${isUser ? "items-end" : "items-start"} flex flex-col`}>
        <div
          className={`rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
            isUser
              ? "bg-accent text-slate-950"
              : "glass-card text-slate-100"
          }`}
        >
          {message.isPending ? (
            <div className="flex items-center gap-2 text-slate-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>Thinking…</span>
            </div>
          ) : (
            <>
              <p className="whitespace-pre-wrap">{renderInline(message.text)}</p>
              {message.structuredData && Object.keys(message.structuredData).length > 0 && (
                <StructuredDataTable data={message.structuredData} />
              )}
            </>
          )}
        </div>
      </div>
    </motion.div>
  );
}

export default function ChatInterface({ messages, onSend, speakingText, disabled }: ChatInterfaceProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [inputValue, setInputValue] = useState("");
  const voiceInterimRef = useRef("");

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const value = inputValue.trim();
    if (!value || disabled) return;
    onSend(value);
    setInputValue("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleVoiceTranscript = useCallback((text: string, isFinal: boolean) => {
    setInputValue((current) => {
      const base = voiceInterimRef.current ? current.slice(0, -voiceInterimRef.current.length) : current;
      const next = `${base}${base && !base.endsWith(" ") ? " " : ""}${text}`;
      voiceInterimRef.current = isFinal ? "" : text;
      return next;
    });
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <div className="glass-card px-4 py-6 text-center text-sm text-slate-400">
            Ask me to read something on this page, or tell me what you'd like to do next —
            I'll guide you through it safely.
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
      </div>

      <form onSubmit={handleSubmit} className="border-t border-white/10 px-3 py-3">
        <div className="glass-pill flex items-end gap-2 px-3 py-2">
          <textarea
            value={inputValue}
            onChange={(event) => setInputValue(event.target.value)}
            rows={1}
            placeholder="Type or tap the mic to speak…"
            disabled={disabled}
            onKeyDown={handleKeyDown}
            className="max-h-24 flex-1 resize-none bg-transparent text-sm text-slate-100 placeholder:text-slate-500 outline-none disabled:opacity-40"
          />
          <VoiceController
            speakingText={speakingText}
            onTranscript={handleVoiceTranscript}
          />
          <button
            type="submit"
            disabled={disabled}
            className="shrink-0 rounded-full bg-accent p-2 text-slate-950 transition hover:bg-accent-dim disabled:opacity-40"
            aria-label="Send message"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </form>
    </div>
  );
}
