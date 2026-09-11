/**
 * Browser-native Speech-to-Text (webkitSpeechRecognition) and
 * Text-to-Speech (window.speechSynthesis) wrappers. No audio ever leaves
 * the browser except through the browser's own OS-level speech APIs --
 * there is no server-side speech component, keeping voice interaction
 * fully local.
 */

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  [index: number]: { transcript: string };
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionErrorEventLike {
  error: string;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface SpeechHandlerCallbacks {
  onInterimResult?: (text: string) => void;
  onFinalResult?: (text: string) => void;
  onError?: (error: string) => void;
  onListeningChange?: (isListening: boolean) => void;
}

export class SpeechHandler {
  private recognition: SpeechRecognitionLike | null = null;
  private callbacks: SpeechHandlerCallbacks;
  private listening = false;
  private cachedVoices: SpeechSynthesisVoice[] = [];

  constructor(callbacks: SpeechHandlerCallbacks = {}) {
    this.callbacks = callbacks;
    // Eagerly load voices — some browsers populate them asynchronously.
    this._loadVoices();
    if ("speechSynthesis" in window) {
      window.speechSynthesis.addEventListener("voiceschanged", () => this._loadVoices());
    }
  }

  private _loadVoices(): void {
    if ("speechSynthesis" in window) {
      this.cachedVoices = window.speechSynthesis.getVoices();
    }
  }

  /**
   * Find the best matching voice for a given BCP-47 language tag.
   * Tries exact match first (e.g. "bn-IN"), then prefix match (e.g. "bn"),
   * then falls back to null (browser default).
   */
  private _findVoice(lang: string): SpeechSynthesisVoice | null {
    // Refresh cache in case voices loaded after construction.
    if (this.cachedVoices.length === 0) this._loadVoices();

    const langLower = lang.toLowerCase();
    const prefix = langLower.split("-")[0]; // e.g. "bn" from "bn-IN"

    // 1. Exact match
    const exact = this.cachedVoices.find(
      (v) => v.lang.toLowerCase() === langLower
    );
    if (exact) return exact;

    // 2. Prefix match (e.g. voice.lang "bn-BD" matches request "bn-IN")
    const prefixMatch = this.cachedVoices.find(
      (v) => v.lang.toLowerCase().startsWith(prefix)
    );
    if (prefixMatch) return prefixMatch;

    return null;
  }

  isSupported(): boolean {
    return getRecognitionCtor() !== null;
  }

  startListening(lang = "en-IN"): void {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      this.callbacks.onError?.("Speech recognition is not supported in this browser.");
      return;
    }
    if (this.listening) return;

    // Cancel any in-progress TTS so the mic doesn't pick up our own voice.
    window.speechSynthesis.cancel();

    this.recognition = new Ctor();
    this.recognition.continuous = false;
    this.recognition.interimResults = true;
    this.recognition.lang = lang;

    this.recognition.onstart = () => {
      this.listening = true;
      this.callbacks.onListeningChange?.(true);
    };

    this.recognition.onresult = (event: SpeechRecognitionEventLike) => {
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          final += transcript;
        } else {
          interim += transcript;
        }
      }
      if (interim) this.callbacks.onInterimResult?.(interim);
      if (final) this.callbacks.onFinalResult?.(final);
    };

    this.recognition.onerror = (event: SpeechRecognitionErrorEventLike) => {
      this.callbacks.onError?.(event.error);
    };

    this.recognition.onend = () => {
      this.listening = false;
      this.callbacks.onListeningChange?.(false);
    };

    this.recognition.start();
  }

  stopListening(): void {
    this.recognition?.stop();
    this.listening = false;
  }

  isListening(): boolean {
    return this.listening;
  }

  /**
   * Speaks `text` aloud in the given language. Explicitly finds and sets
   * a matching SpeechSynthesisVoice so the browser actually uses the
   * correct language instead of falling back to the default English voice.
   */
  speak(text: string, lang = "en-IN"): void {
    if (!("speechSynthesis" in window) || !text) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;

    // Explicitly set a voice matching the language.
    const voice = this._findVoice(lang);
    if (voice) {
      utterance.voice = voice;
    }

    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    window.speechSynthesis.speak(utterance);
  }

  stopSpeaking(): void {
    window.speechSynthesis.cancel();
  }
}
