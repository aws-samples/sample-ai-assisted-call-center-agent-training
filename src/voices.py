"""Nova Sonic voice registry — maps voice IDs to language metadata."""

# Each entry: voice_id -> {locale, language, language_name, gender}
# kiara/arjun serve both en-IN and hi-IN
VOICE_REGISTRY = {
    "matthew":   {"locale": "en-US", "language": "en", "language_name": "English",    "gender": "male"},
    "tiffany":   {"locale": "en-US", "language": "en", "language_name": "English",    "gender": "female"},
    "amy":       {"locale": "en-GB", "language": "en", "language_name": "English",    "gender": "female"},
    "olivia":    {"locale": "en-AU", "language": "en", "language_name": "English",    "gender": "female"},
    "kiara":     {"locale": "en-IN", "language": "en", "language_name": "English",    "gender": "female"},
    "arjun":     {"locale": "en-IN", "language": "en", "language_name": "English",    "gender": "male"},
    "ambre":     {"locale": "fr-FR", "language": "fr", "language_name": "French",     "gender": "female"},
    "florian":   {"locale": "fr-FR", "language": "fr", "language_name": "French",     "gender": "male"},
    "beatrice":  {"locale": "it-IT", "language": "it", "language_name": "Italian",    "gender": "female"},
    "lorenzo":   {"locale": "it-IT", "language": "it", "language_name": "Italian",    "gender": "male"},
    "tina":      {"locale": "de-DE", "language": "de", "language_name": "German",     "gender": "female"},
    "lennart":   {"locale": "de-DE", "language": "de", "language_name": "German",     "gender": "male"},
    "lupe":      {"locale": "es-US", "language": "es", "language_name": "Spanish",    "gender": "female"},
    "carlos":    {"locale": "es-US", "language": "es", "language_name": "Spanish",    "gender": "male"},
    "carolina":  {"locale": "pt-BR", "language": "pt", "language_name": "Portuguese", "gender": "female"},
    "leo":       {"locale": "pt-BR", "language": "pt", "language_name": "Portuguese", "gender": "male"},
}

# Polyglot voices that can speak ALL supported languages
POLYGLOT_VOICES = {"matthew", "tiffany"}

# Voices that also support Hindi (same IDs as en-IN)
HINDI_VOICES = {"kiara", "arjun"}

# Language code to human-readable name
LANGUAGE_NAMES = {
    "en": "English",
    "fr": "French",
    "it": "Italian",
    "de": "German",
    "es": "Spanish",
    "pt": "Portuguese",
    "hi": "Hindi",
}


def get_voice_native_language(voice_id: str) -> str:
    """Return the ISO language code for a voice's native language."""
    entry = VOICE_REGISTRY.get(voice_id, {})
    return entry.get("language", "en")


def get_voice_language_name(voice_id: str) -> str:
    """Return the human-readable language name for a voice."""
    entry = VOICE_REGISTRY.get(voice_id, {})
    return entry.get("language_name", "English")


def is_english_voice(voice_id: str) -> bool:
    """Return True if voice's primary language is English."""
    return get_voice_native_language(voice_id) == "en"


def get_locale_voice_id(voice_id: str, language_mode: str = "english") -> str:
    """Return locale-prefixed voice ID for Nova Sonic, e.g. 'en-us.matthew'.

    Uses the voice's native locale by default. For Hindi voices in native mode,
    switches to hi-IN locale.
    """
    entry = VOICE_REGISTRY.get(voice_id)
    if not entry:
        return voice_id  # unknown voice, pass through as-is

    # For Hindi voices in native mode, use hi-IN locale
    if voice_id in HINDI_VOICES and language_mode == "native":
        locale = "hi-IN"
    else:
        locale = entry["locale"]

    return f"{locale.lower()}.{voice_id}"
