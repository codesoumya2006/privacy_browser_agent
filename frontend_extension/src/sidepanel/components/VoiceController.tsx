import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Mic, MicOff, Volume2 } from "lucide-react";
import { SpeechHandler } from "../../utils/speechHandler";

interface VoiceControllerProps {
  onTranscript: (text: string, isFinal: boolean) => void;
  speakingText: string | null; // set this to have the assistant speak a new guidance message
}

export default function VoiceController({ onTranscript, speakingText }: VoiceControllerProps) {
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const handlerRef = useRef<SpeechHandler | null>(null);

  useEffect(() => {
    handlerRef.current = new SpeechHandler({
      onListeningChange: setIsListening,
      onInterimResult: (text) => {
        setInterim(text);
        onTranscript(text, false);
      },
      onFinalResult: (text) => {
        setInterim("");
        onTranscript(text, true);
      },
      onError: (message) => {
        setIsListening(false);
        setError(
          message === "not-allowed"
            ? "Microphone permission is blocked. Allow microphone access for this extension."
            : `Voice input failed: ${message}`
        );
      },
    });
    return () => handlerRef.current?.stopListening();
  }, [onTranscript]);

  useEffect(() => {
    if (!speakingText || !handlerRef.current) return;
    setIsSpeaking(true);
    handlerRef.current.speak(speakingText);
    // speechSynthesis has no reliable cross-browser "end" promise wrapper
    // exposed here, so approximate a speaking indicator window.
    const estimatedMs = Math.min(6000, Math.max(1200, speakingText.length * 55));
    const t = setTimeout(() => setIsSpeaking(false), estimatedMs);
    return () => clearTimeout(t);
  }, [speakingText]);

  const toggleListening = () => {
    if (!handlerRef.current) return;
    setError(null);
    if (isListening) {
      handlerRef.current.stopListening();
    } else {
      handlerRef.current.startListening();
    }
  };

  const supported = handlerRef.current?.isSupported() ?? true;

  return (
    <div className="relative flex shrink-0 items-center">
      {interim && (
        <div className="pointer-events-none absolute bottom-10 right-0 w-48 rounded-lg bg-slate-900 px-3 py-2 text-xs text-slate-300 shadow-lg">
          {interim}
        </div>
      )}
      {error && (
        <div className="pointer-events-none absolute bottom-10 right-0 w-56 rounded-lg bg-red-950 px-3 py-2 text-[11px] text-red-200 shadow-lg">
          {error}
        </div>
      )}
      <motion.button
        type="button"
        disabled={!supported}
        onClick={toggleListening}
        whileTap={{ scale: 0.94 }}
        aria-label={isListening ? "Stop voice input" : "Start voice input"}
        className={`glass-pill flex h-8 w-8 items-center justify-center text-sm transition disabled:opacity-40 ${
          isListening ? "animate-pulse-ring text-accent" : "text-slate-200"
        }`}
      >
        {isSpeaking ? (
          <Volume2 className="h-4 w-4 text-accent" />
        ) : isListening ? (
          <Mic className="h-4 w-4 text-accent" />
        ) : (
          <MicOff className="h-4 w-4" />
        )}
      </motion.button>
    </div>
  );
}
