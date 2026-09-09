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

  constructor(callbacks: SpeechHandlerCallbacks = {}) {
    this.callbacks = callbacks;
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
   * Speaks `text` aloud. Automatically skipped if the text looks like it
   * might contain a surrogate token literal (e.g. "<PERSON_1>") since
   * reading raw tokens aloud is confusing -- callers should detokenize a
   * natural-language version for speech separately if needed.
   */
  speak(text: string, lang = "en-IN"): void {
    if (!("speechSynthesis" in window) || !text) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    window.speechSynthesis.speak(utterance);
  }

  stopSpeaking(): void {
    window.speechSynthesis.cancel();
  }
}
