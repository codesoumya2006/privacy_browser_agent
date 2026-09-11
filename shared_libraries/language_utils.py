"""Language utilities for multilingual support."""

LANGUAGE_MAP = {
    "en-IN": "English",
    "bn-IN": "Bengali (বাংলা)",
    "hi-IN": "Hindi (हिन्दी)",
}


def get_language_name(locale: str) -> str:
    """Return the human-readable language name for a BCP-47 locale code."""
    return LANGUAGE_MAP.get(locale, "English")


def build_language_system_suffix(locale: str) -> str:
    """
    Build a strong system-prompt suffix that forces the LLM to produce
    all user-facing text (speech_guidance, answer_summary, summary, etc.)
    in the requested language.

    If the locale is English, returns an empty string (no override needed).
    """
    if locale.startswith("en"):
        return ""

    lang = get_language_name(locale)
    return (
        f"\n\n=== MANDATORY LANGUAGE OVERRIDE ===\n"
        f"The user has selected {lang} as their preferred language.\n"
        f"You MUST write ALL user-facing text fields in {lang}.\n"
        f"This includes: speech_guidance, answer_summary, summary, "
        f"focal_area_description — any field the user will read or hear.\n"
        f"Technical field names (action_type, target_selector, etc.) stay in English.\n"
        f"DO NOT respond in English for user-facing text. Use {lang} ONLY.\n"
    )
