export interface VoiceInfo {
  id: string;
  label: string;
  locale: string;
  language: string;
  languageName: string;
  gender: 'male' | 'female';
}

export const VOICE_LIST: VoiceInfo[] = [
  // English (US)
  { id: 'matthew',  label: 'Matthew (US English, Masculine)',             locale: 'en-US', language: 'en', languageName: 'English',    gender: 'male' },
  { id: 'tiffany',  label: 'Tiffany (US English, Feminine)',              locale: 'en-US', language: 'en', languageName: 'English',    gender: 'female' },
  // English (UK)
  { id: 'amy',      label: 'Amy (UK English, Feminine)',                  locale: 'en-GB', language: 'en', languageName: 'English',    gender: 'female' },
  // English (AU)
  { id: 'olivia',   label: 'Olivia (AU English, Feminine)',               locale: 'en-AU', language: 'en', languageName: 'English',    gender: 'female' },
  // English (IN) / Hindi
  { id: 'kiara',    label: 'Kiara (Indian English / Hindi, Feminine)',    locale: 'en-IN', language: 'en', languageName: 'English',    gender: 'female' },
  { id: 'arjun',    label: 'Arjun (Indian English / Hindi, Masculine)',   locale: 'en-IN', language: 'en', languageName: 'English',    gender: 'male' },
  // French
  { id: 'ambre',    label: 'Ambre (French, Feminine)',                    locale: 'fr-FR', language: 'fr', languageName: 'French',     gender: 'female' },
  { id: 'florian',  label: 'Florian (French, Masculine)',                 locale: 'fr-FR', language: 'fr', languageName: 'French',     gender: 'male' },
  // Italian
  { id: 'beatrice', label: 'Beatrice (Italian, Feminine)',                locale: 'it-IT', language: 'it', languageName: 'Italian',    gender: 'female' },
  { id: 'lorenzo',  label: 'Lorenzo (Italian, Masculine)',                locale: 'it-IT', language: 'it', languageName: 'Italian',    gender: 'male' },
  // German
  { id: 'tina',     label: 'Tina (German, Feminine)',                     locale: 'de-DE', language: 'de', languageName: 'German',     gender: 'female' },
  { id: 'lennart',  label: 'Lennart (German, Masculine)',                 locale: 'de-DE', language: 'de', languageName: 'German',     gender: 'male' },
  // Spanish (US)
  { id: 'lupe',     label: 'Lupe (Spanish, Feminine)',                    locale: 'es-US', language: 'es', languageName: 'Spanish',    gender: 'female' },
  { id: 'carlos',   label: 'Carlos (Spanish, Masculine)',                 locale: 'es-US', language: 'es', languageName: 'Spanish',    gender: 'male' },
  // Portuguese (BR)
  { id: 'carolina', label: 'Carolina (Portuguese, Feminine)',             locale: 'pt-BR', language: 'pt', languageName: 'Portuguese', gender: 'female' },
  { id: 'leo',      label: 'Leo (Portuguese, Masculine)',                 locale: 'pt-BR', language: 'pt', languageName: 'Portuguese', gender: 'male' },
];

/** Polyglot voices that can speak all languages */
export const POLYGLOT_VOICE_IDS = new Set(['matthew', 'tiffany']);

/** Voices that also support Hindi */
export const HINDI_VOICE_IDS = new Set(['kiara', 'arjun']);

/** Build Cloudscape Select option groups organized by language */
export function getGroupedVoiceOptions() {
  const groups: Record<string, { label: string; options: { label: string; value: string }[] }> = {};
  for (const v of VOICE_LIST) {
    const groupKey = v.locale;
    const groupLabel = `${v.languageName} (${v.locale})`;
    if (!groups[groupKey]) {
      groups[groupKey] = { label: groupLabel, options: [] };
    }
    groups[groupKey].options.push({ label: v.label, value: v.id });
  }
  return Object.values(groups);
}

/** Given a caller gender, pick the best default English voice */
export function autoSelectVoice(callerGender?: string): { label: string; value: string } {
  const gender = callerGender === 'female' ? 'female' : 'male';
  // Prefer US English polyglot voices (matthew/tiffany) as defaults
  const polyglotMatch = VOICE_LIST.find(v => v.language === 'en' && v.gender === gender && POLYGLOT_VOICE_IDS.has(v.id));
  const voice = polyglotMatch || VOICE_LIST.find(v => v.language === 'en' && v.gender === gender) || VOICE_LIST[0];
  return { label: voice.label, value: voice.id };
}

/** Check if a voice is English-only (no "native" mode makes sense) */
export function isEnglishOnlyVoice(voiceId: string): boolean {
  if (HINDI_VOICE_IDS.has(voiceId)) return false;
  const voice = VOICE_LIST.find(v => v.id === voiceId);
  if (!voice) return true;
  return voice.language === 'en';
}

/** Get the native language name for a voice (for the "Native" radio label) */
export function getVoiceNativeLanguageName(voiceId: string): string {
  if (HINDI_VOICE_IDS.has(voiceId)) return 'Hindi';
  const voice = VOICE_LIST.find(v => v.id === voiceId);
  return voice?.languageName || 'English';
}
