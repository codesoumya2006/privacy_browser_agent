/**
 * In-memory referential tokenizer / pseudonymizer.
 *
 * Sensitive entities (names, phone numbers, government IDs, addresses) are
 * mapped to deterministic surrogate tokens for the lifetime of a browsing
 * session. The lookup table lives ONLY in client memory (a plain JS Map);
 * it is never serialized, never written to chrome.storage, and never sent
 * over the network. Only the surrogate tokens (e.g. <PERSON_1>) leave the
 * client -- the backend reasons exclusively over these opaque tokens.
 */

// Mirrors shared_libraries/constants.py so masking rules stay consistent
// between what the backend audits and what the client actually redacts.
const PII_REGEXES: Record<string, RegExp> = {
  aadhaar: /\b\d{4}\s?\d{4}\s?\d{4}\b/g,
  pan: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g,
  ifsc: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
  phone_in: /\b(?:\+91|0)?[6-9]\d{9}\b/g,
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}\b/gi,
  name_label:
    /\b(?:full\s+name|name|username|applicant|patient|customer)\s*[:=-]\s*[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,3}/gi,
  titled_name: /\b(?:Mr|Mrs|Ms|Miss|Dr)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g,
};

// Categories that get bracketed "[X Redacted]" markers instead of numbered
// tokens, since re-identification / consistency across turns matters less
// for these (they're rarely referenced conversationally by the user).
const BRACKETED_CATEGORIES = new Set(["aadhaar", "pan", "ifsc"]);

// Categories that get numbered <TAG_N> tokens because the user or assistant
// may need to refer back to "the same phone number" / "the same person"
// consistently across a multi-turn conversation.
const TOKEN_TAG_BY_CATEGORY: Record<string, string> = {
  name_label: "PERSON",
  titled_name: "PERSON",
  phone_in: "PHONE",
  email: "EMAIL",
};

const BRACKET_LABEL_BY_CATEGORY: Record<string, string> = {
  aadhaar: "Aadhaar Redacted",
  pan: "PAN Redacted",
  ifsc: "IFSC Redacted",
};

export interface TokenizeResult {
  maskedText: string;
  replacements: Record<string, string>; // token -> original raw value (in-memory only)
}

class Pseudonymizer {
  /** token -> raw value */
  private forward = new Map<string, string>();
  /** raw value -> token (dedupes repeated entities within a session) */
  private reverse = new Map<string, string>();
  private counters: Record<string, number> = {};

  private nextToken(category: string): string {
    const tag = TOKEN_TAG_BY_CATEGORY[category] ?? category.toUpperCase();
    const n = (this.counters[tag] ?? 0) + 1;
    this.counters[tag] = n;
    return `<${tag}_${n}>`;
  }

  private tokenFor(category: string, rawValue: string): string {
    const existing = this.reverse.get(rawValue);
    if (existing) return existing;

    const token = BRACKETED_CATEGORIES.has(category)
      ? `[${BRACKET_LABEL_BY_CATEGORY[category]}]`
      : this.nextToken(category);

    this.forward.set(token, rawValue);
    this.reverse.set(rawValue, token);
    return token;
  }

  /**
   * Replaces every PII match in `rawText` with its surrogate token,
   * creating new tokens as needed. Safe to call repeatedly on overlapping
   * text -- same raw value always maps to the same token within a session.
   */
  tokenize(rawText: string): TokenizeResult {
    if (!rawText) return { maskedText: rawText, replacements: {} };

    let maskedText = rawText;
    const replacements: Record<string, string> = {};

    // Bracketed structured-ID categories first (higher specificity, avoids
    // the full_name regex accidentally consuming parts of an ID string).
    const orderedCategories = [
      "aadhaar",
      "pan",
      "ifsc",
      "phone_in",
      "email",
      "name_label",
      "titled_name",
    ];

    for (const category of orderedCategories) {
      const regex = PII_REGEXES[category];
      regex.lastIndex = 0;
      maskedText = maskedText.replace(regex, (match) => {
        const token = this.tokenFor(category, match);
        replacements[token] = match;
        return token;
      });
    }

    return { maskedText, replacements };
  }

  /** Resolves a single surrogate token back to its raw value, right before
   * dispatching a native input event. Returns the token unchanged if it
   * isn't a known mapping (defensive: never silently invents a value). */
  detokenize(tokenText: string): string {
    if (!tokenText) return tokenText;
    const direct = this.forward.get(tokenText.trim());
    if (direct !== undefined) return direct;

    // Support a token embedded inside a larger string, e.g. "Hi <PERSON_1>,"
    let result = tokenText;
    for (const [token, raw] of this.forward.entries()) {
      if (result.includes(token)) {
        result = result.split(token).join(raw);
      }
    }
    return result;
  }

  clearSession(): void {
    this.forward.clear();
    this.reverse.clear();
    this.counters = {};
  }

  maskedEntityCount(): number {
    return this.forward.size;
  }
}

// Singleton: one pseudonymizer per side-panel session/tab context.
export const pseudonymizer = new Pseudonymizer();
export { Pseudonymizer };
