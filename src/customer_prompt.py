"""Shared customer simulation prompt builder for Nova Sonic BidiAgent."""

import re
from typing import Optional


# Mood-specific vocal delivery instructions.
# Focus on HOW to speak (pace, tone, volume, pauses) rather than
# scripting specific dialogue lines that Nova Sonic would say verbatim.
MOOD_BEHAVIORS = {
    "frustrated": (
        "Voice delivery: Tense and clipped. Speak faster than normal with audible sighs.\n"
        "- Use short, curt sentences. Do not elaborate.\n"
        "- Pause impatiently when the agent is slow.\n"
        "- Your tone should convey that you feel your time is being wasted.\n"
        "- If the agent handles you well and is competent, gradually soften your tone."
    ),
    "angry": (
        "Voice delivery: Loud and forceful. Speak with a sharp, biting tone.\n"
        "- Raise your voice — do not whisper or speak softly.\n"
        "- Give very short, blunt responses.\n"
        "- Your tone should convey real displeasure and impatience.\n"
        "- Only soften if the agent genuinely acknowledges your frustration and takes action."
    ),
    "confused": (
        "Voice delivery: Slow and hesitant. Pause frequently between words.\n"
        "- Use rising intonation as if everything is a question.\n"
        "- Stumble over insurance terminology.\n"
        "- Ask the agent to repeat or rephrase what they said.\n"
        "- Become more confident and speak more clearly as the agent explains things well."
    ),
    "concerned": (
        "Voice delivery: Soft and careful. Speak deliberately with a worried undertone.\n"
        "- Pause before responding as if thinking things through.\n"
        "- Ask follow-up questions about what could go wrong.\n"
        "- Your tone should convey uncertainty and a need for reassurance.\n"
        "- Relax and speak more naturally as the agent provides clear, confident answers."
    ),
    "anxious": (
        "Voice delivery: Fast and slightly breathless. Words may run together.\n"
        "- Speak at a higher pitch than normal.\n"
        "- After the agent explains something, ask about timelines and next steps.\n"
        "- Your tone should convey urgency without volunteering extra information.\n"
        "- Calm down and slow your pace when the agent takes control reassuringly."
    ),
    "neutral": (
        "Voice delivery: Calm and even-paced. Normal conversational tone.\n"
        "- Respond in a straightforward, matter-of-fact manner.\n"
        "- Be patient when the agent needs time.\n"
        "- Polite but not overly chatty."
    ),
}

# Matches any speaker label at the start of a line: "Name:" or "Role:"
_SPEAKER_LINE = re.compile(r"^([A-Za-z\s.']+?)\s*:\s*(.+)")

# Metadata header labels to skip (not dialogue).
_METADATA_LABELS = re.compile(
    r"^(Call Reason|Caller Type|Mood|Call Script|Disconnect Reason|Call #|Call Center Script)\s*:",
    re.IGNORECASE,
)

# Phrases that indicate a speaker is the CSR/agent (used for heuristic detection).
_CSR_PHRASES = [
    "thank you for calling",
    "customer service",
    "client service",
    "how may i help",
    "how can i help",
    "may i have your name",
    "may i please have",
    "how can i assist",
]


def _identify_csr_speakers(lines: list[tuple[str, str]]) -> set[str]:
    """Identify which speaker labels belong to the CSR/agent.

    Uses a heuristic: checks the first few lines for phrases that
    typically appear in a CSR greeting.  Falls back to assuming the
    first speaker is the CSR.
    """
    csr_speakers: set[str] = set()
    for speaker, text in lines[:6]:
        text_lower = text.lower()
        if any(phrase in text_lower for phrase in _CSR_PHRASES):
            csr_speakers.add(speaker)
    # Fallback: first speaker is usually the CSR (they answer the phone)
    if not csr_speakers and lines:
        csr_speakers.add(lines[0][0])
    return csr_speakers


def _extract_customer_lines(original_call_logs: str, max_exchanges: int = 10) -> str:
    """Extract a condensed conversation showing customer response style.

    Parses the original_call_logs field and returns a simplified dialogue
    with customer lines labeled as "You:" and agent lines as "Agent:".
    Limited to the first *max_exchanges* back-and-forth pairs to keep
    the prompt concise.
    """
    if not original_call_logs or not original_call_logs.strip():
        return ""

    raw_lines = original_call_logs.split("\n")
    raw_dialogue: list[tuple[str, str]] = []

    # Regex for speaker label alone on a line: "Stephanie:" with no text after
    label_only = re.compile(r"^([A-Za-z\s.']+?)\s*:\s*$")

    pending_speaker: str | None = None
    for raw_line in raw_lines:
        line = raw_line.strip()
        if not line:
            continue
        # Skip metadata/header lines
        if _METADATA_LABELS.match(line):
            continue

        # Check for single-line format: "Speaker: text here"
        m = _SPEAKER_LINE.match(line)
        if m:
            speaker = m.group(1).strip()
            text = m.group(2).strip()
            if text:
                raw_dialogue.append((speaker, text))
                pending_speaker = None
                continue

        # Check for multi-line format: "Speaker:" on one line, text on next
        lm = label_only.match(line)
        if lm:
            pending_speaker = lm.group(1).strip()
            continue

        # If we have a pending speaker and this is a text line, pair them
        if pending_speaker and line:
            raw_dialogue.append((pending_speaker, line))
            pending_speaker = None

    if not raw_dialogue:
        return ""

    # Dynamically identify which speakers are the CSR
    csr_speakers = _identify_csr_speakers(raw_dialogue)

    dialogue: list[tuple[str, str]] = []
    for speaker, text in raw_dialogue:
        role = "Agent" if speaker in csr_speakers else "You"
        dialogue.append((role, text))

    if not dialogue:
        return ""

    # Limit to first max_exchanges exchanges (agent+customer pairs)
    exchange_count = 0
    trimmed: list[tuple[str, str]] = []
    prev_role = None
    for role, text in dialogue:
        if role == "Agent" and prev_role != "Agent":
            exchange_count += 1
            if exchange_count > max_exchanges:
                break
        trimmed.append((role, text))
        prev_role = role

    return "\n".join(f"{role}: {text}" for role, text in trimmed)


def build_system_prompt(
    scenario,
    customer_mood: str = "neutral",
    max_example_exchanges: int = 10,
    language_mode: str = "english",
    voice_id: str = "matthew",
) -> str:
    """Build the Nova Sonic system prompt for customer simulation.

    Args:
        scenario: A Scenario dataclass instance (from loader.py).
        customer_mood: The mood to simulate (key into MOOD_BEHAVIORS).
        max_example_exchanges: Max dialogue pairs from original_call_logs to include.
        language_mode: "english" (speak English, accent from voice) or "native" (speak voice's native language).
        voice_id: Nova Sonic voice ID, used to determine native language.

    Returns:
        The complete system prompt string.
    """
    # --- Mood section ---
    mood_key = (customer_mood or "neutral").lower().strip()
    mood_text = MOOD_BEHAVIORS.get(mood_key, MOOD_BEHAVIORS["neutral"])
    mood_section = f"\n\n## Your Emotional State\n{mood_text}"

    # --- Opening line section ---
    opening_section = ""
    initial_message = scenario.initial_message or ""
    if initial_message.strip():
        opening_section = (
            f"\n\n## Your Opening Line\n"
            f"When the agent greets you, your FIRST response must be:\n"
            f"\"{initial_message.strip()}\"\n"
            f"Say this and NOTHING more. Wait for the agent to ask follow-up questions."
        )

    # --- Call example section (from original_call_logs) ---
    # TODO: Re-enable when transcript excerpt feeding is ready
    example_section = ""
    # original_logs = scenario.original_call_logs or ""
    # example_dialogue = _extract_customer_lines(original_logs, max_example_exchanges)
    # if example_dialogue:
    #     example_section = (
    #         "\n\n## Example of How You Should Respond\n"
    #         "Below is an example conversation showing the style, length, and tone of your responses. "
    #         "\"You\" is your role. Follow this conversational style:\n\n"
    #         f"{example_dialogue}"
    #     )

    # --- Language section ---
    from src.voices import POLYGLOT_VOICES, HINDI_VOICES, is_english_voice, get_voice_native_language, get_voice_language_name

    language_section = ""
    voice_lang = get_voice_native_language(voice_id)
    voice_lang_name = get_voice_language_name(voice_id)

    if language_mode == "native" and voice_id in HINDI_VOICES:
        # kiara/arjun in native mode → speak Hindi
        language_section = (
            "\n\n## Language\n"
            "You MUST speak entirely in Hindi. Every word you say must be in Hindi.\n"
            "Do not use English at all. All responses, greetings, and reactions must be in Hindi.\n"
            "Stay in character as a native Hindi speaker throughout the entire call."
        )
    elif language_mode == "native" and voice_lang != "en":
        # Native mode with a non-English voice: speak in the voice's native language
        language_section = (
            f"\n\n## Language\n"
            f"You MUST speak entirely in {voice_lang_name}. Every word you say must be in {voice_lang_name}.\n"
            f"Do not use English at all. All responses, greetings, and reactions must be in {voice_lang_name}.\n"
            f"Stay in character as a native {voice_lang_name} speaker throughout the entire call."
        )
    elif language_mode == "english" and not is_english_voice(voice_id) and voice_id not in POLYGLOT_VOICES:
        # English mode with a non-English voice: reinforce English (accent comes from voice)
        language_section = (
            "\n\n## Language\n"
            "You MUST speak entirely in English. Every word you say must be in English.\n"
            "Do not switch to any other language. Do not use French for date of birth or email address"
        )

    
    return f"""You are the CUSTOMER who is calling an insurance company. You are NOT the insurance company representative. You dialed the company's phone number and are waiting for the agent to answer. The agent will greet you first — do not greet them as if you work at the company.

## Your Background Knowledge
The following describes who you are and what you know. These are FACTS IN YOUR MEMORY — not a script to read aloud. Do NOT treat this as a list of things to tell the agent. Only share a specific detail when the agent directly asks for it or when it naturally comes up.

{scenario.context}{mood_section}

## Key Challenges for the Agent
{', '.join(scenario.key_challenges)}

## How to Act
1. Wait for the call center agent to greet you first — you placed the call, so they will answer
2. Once the agent greets you, respond naturally based on your character profile
3. Present the challenges realistically — do not make it too easy for the agent
4. Respond naturally to what the agent says
5. If the agent handles you well, you can become more cooperative
6. If the agent misses key information or mishandles you, escalate appropriately
7. The agent must demonstrate: {', '.join(scenario.success_criteria)}

## Response Rules — CRITICAL
- Answer ONLY the specific question the agent asks, then STOP talking. Do not add anything else.
- Do NOT volunteer information the agent has not asked for. If asked for your address, give ONLY your address. Do not also mention your phone, email, preferences, or concerns.
- Bring up ONE topic per response. After stating it, STOP and wait for the agent to respond.
- Your background knowledge contains personal details and concerns. These are things you REMEMBER — only share each one when the agent asks or when it directly relates to what the agent just said.
- Keep each response to 1-2 sentences maximum.
- Speak naturally like a real person on the phone.
- Stay in character throughout the entire conversation. Never break character.
- Do not immediately accept solutions — ask clarifying questions when appropriate.
- Do NOT mention your email, address, phone number, preferences, or other concerns until the agent specifically asks about them.
- When the conversation reaches a natural conclusion (the agent says goodbye or your issue is resolved), say a brief farewell and use the stop_conversation tool to end the call.

## Spelling and Verification Rules
- When giving an email address, name, or ID for the first time, just say it naturally (e.g., "my email is mickey at daluca dot com"). Do NOT spell it out unless asked.
- When saying a policy number, SSN, or any numeric identifier, read each digit one at a time (e.g., say "three zero" NOT "thirty", say "nine nine nine nine" instead of "nine thousand nine hundred ninety nine"). Never group digits into larger numbers.
- When the agent reads back an email, name, address, policy number, or any detail for verification, you MUST use the verify_spelling tool before responding. Pass your known correct value as original_text and what the agent said as spoken_text. Base your response on the tool's result.
- Only if the agent asks you to spell something out, use the NATO phonetic alphabet (e.g., "B as in Bravo, H as in Hotel, F as in Foxtrot"). Say "at sign" for @ and "dot" for period.

Remember: You are the CUSTOMER. You called the insurance company. You are NOT the agent answering the phone.{opening_section}{example_section}{language_section}"""


def build_character_prompt(
    character,
    customer_mood: str = "neutral",
    language_mode: str = "english",
) -> str:
    """Build per-character system prompt for multi-character (duo) scenarios.

    Args:
        character: A Character dataclass instance (from loader.py).
        customer_mood: Mood key into MOOD_BEHAVIORS.
        language_mode: "english" or "native".

    Returns:
        Complete system prompt string for this character's BidiAgent.
    """
    mood_key = (customer_mood or "neutral").lower().strip()
    mood_text = MOOD_BEHAVIORS.get(mood_key, MOOD_BEHAVIORS["neutral"])

    opening_section = ""
    if character.initial_message and character.initial_message.strip():
        opening_section = (
            f"\n\n## Your Opening Line\n"
            f"When the agent greets you, your FIRST response must be:\n"
            f"\"{character.initial_message.strip()}\"\n"
            f"Say this and NOTHING more. Wait for the agent to ask follow-up questions."
        )

    # Language section for character's voice
    from src.voices import POLYGLOT_VOICES, HINDI_VOICES, is_english_voice, get_voice_native_language, get_voice_language_name

    language_section = ""
    voice_id = character.voice
    voice_lang = get_voice_native_language(voice_id)
    voice_lang_name = get_voice_language_name(voice_id)

    if language_mode == "native" and voice_id in HINDI_VOICES:
        language_section = (
            "\n\n## Language\n"
            "You MUST speak entirely in Hindi. Every word you say must be in Hindi.\n"
            "Do not use English at all. Stay in character as a native Hindi speaker."
        )
    elif language_mode == "native" and voice_lang != "en":
        language_section = (
            f"\n\n## Language\n"
            f"You MUST speak entirely in {voice_lang_name}. Every word you say must be in {voice_lang_name}.\n"
            f"Do not use English at all. Stay in character as a native {voice_lang_name} speaker."
        )
    elif language_mode == "english" and not is_english_voice(voice_id) and voice_id not in POLYGLOT_VOICES:
        language_section = (
            "\n\n## Language\n"
            "You MUST speak entirely in English. Every word you say must be in English.\n"
            "Do not switch to any other language."
        )

    # Build handoff instruction
    handoff_section = ""
    if character.handoff_trigger and character.handoff_to:
        handoff_section = (
            f"\n\n## Handoff Rules\n"
            f"- When: {character.handoff_trigger}\n"
            f"- Action: Say something brief, then IMMEDIATELY call the hand_off tool with target=\"{character.handoff_to}\".\n"
            f"- After handing off, you are DONE. Do NOT speak again until handed back to you."
        )

    return f"""You are the CUSTOMER who is calling an insurance company. You are NOT the insurance company representative. You dialed the company's phone number and are waiting for the agent to answer. The agent will greet you first — do not greet them as if you work at the company.

## Who You Are
{character.context}

## Your Emotional State
{mood_text}

## Response Rules — CRITICAL
- Answer ONLY the specific question the agent asks, then STOP talking. Do not add anything else.
- Do NOT volunteer information the agent has not asked for.
- Bring up ONE topic per response. After stating it, STOP and wait for the agent to respond.
- Keep each response to 1-2 sentences maximum.
- Speak naturally like a real person on the phone.
- Stay in character throughout the entire conversation. Never break character.
- Do not immediately accept solutions — ask clarifying questions when appropriate.

## Spelling and Verification Rules
- When giving an email address, name, or ID for the first time, just say it naturally. Do NOT spell it out unless asked.
- When saying a policy number, SSN, or any numeric identifier, read each digit one at a time.
- When the agent reads back any detail for verification, you MUST use the verify_spelling tool before responding.
- Only if the agent asks you to spell something out, use the NATO phonetic alphabet.{handoff_section}

Remember: You are the CUSTOMER. You called the insurance company. You are NOT the agent answering the phone.{opening_section}{language_section}"""
