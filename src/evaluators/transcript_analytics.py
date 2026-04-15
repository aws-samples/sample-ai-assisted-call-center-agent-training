"""Transcript-based call analytics — computes metrics from ConversationTurn data.

No external dependencies. Operates purely on SessionRecording transcript metadata.
"""

from typing import Dict, Any, List
from src.recording.session_types import SessionRecording, ConversationTurn

# Minimum gap (seconds) between customer ending and agent starting to count as silence
SILENCE_THRESHOLD_SECONDS = 1.0

# Maximum acceptable silence gap (seconds) before flagging a violation
SILENCE_VIOLATION_THRESHOLD_SECONDS = 20.0

# Minimum overlap (seconds) to count as a talk-over (filters timing imprecision)
TALK_OVER_MIN_OVERLAP_SECONDS = 0.5

# Minimum time (seconds) the current speaker must have been talking before the next
# speaker starts, to count as a talk-over (filters transcript fragmentation)
TALK_OVER_MIN_INTO_TURN_SECONDS = 1.0

# Phrases that indicate lack of confidence / hedging
WEAK_PHRASES = [
    "i don't know",
    "i'm not sure",
    "i am not sure",
    "it looks like",
    "i think maybe",
    "i guess",
]

# Hold-related phrases the agent might use
HOLD_PHRASES = [
    "put you on hold",
    "place you on hold",
    "one moment please",
    "brief hold",
    "hold for a moment",
    "place you on a brief",
    "may i place you on",
]


def compute_transcript_analytics(session: SessionRecording) -> Dict[str, Any]:
    """Compute call analytics from a session recording's transcript.

    Args:
        session: SessionRecording with transcript turns

    Returns:
        Dict with analytics metrics
    """
    turns = session.transcript
    duration = session.duration_seconds

    silence_seconds, avg_response_time, max_gap, gaps = _compute_agent_silence(turns, duration)
    silence_violations = _count_silence_violations(gaps)
    talk_over_count = _compute_talk_overs(turns)
    questions_asked, questions_answered, questions_unanswered = _compute_questions(turns)
    hold_count = _detect_holds(turns)
    weak_phrase_count = _count_weak_phrases(turns)
    silence_pct = (silence_seconds / duration * 100) if duration > 0 else 0.0

    return {
        'call_duration_seconds': round(duration, 1),
        'agent_silence_seconds': round(silence_seconds, 1),
        'agent_silence_percentage': round(silence_pct, 1),
        'max_silence_gap_seconds': round(max_gap, 1),
        'silence_violations_count': silence_violations,
        'talk_over_count': talk_over_count,
        'questions_asked': questions_asked,
        'questions_answered': questions_answered,
        'questions_unanswered': questions_unanswered,
        'avg_agent_response_time': round(avg_response_time, 1),
        'hold_count': hold_count,
        'confidence_language_count': weak_phrase_count,
    }


def _compute_agent_silence(
    turns: List[ConversationTurn], total_duration: float
) -> tuple:
    """Compute total agent silence, average response time, max gap, and raw gaps.

    Silence is measured as the gap between a customer turn ending
    and the next agent turn starting, when the gap exceeds the threshold.

    Returns:
        (total_silence_seconds, avg_response_time_seconds, max_gap_seconds, gaps_list)
    """
    gaps: List[float] = []

    for i in range(len(turns) - 1):
        current = turns[i]
        next_turn = turns[i + 1]

        # Look for customer -> agent transitions
        if current.speaker == 'customer' and next_turn.speaker == 'agent':
            customer_end = current.audio_start_time + current.audio_duration
            agent_start = next_turn.audio_start_time
            gap = agent_start - customer_end

            if gap > 0:
                gaps.append(gap)

    silence_seconds = sum(g for g in gaps if g >= SILENCE_THRESHOLD_SECONDS)
    avg_response = (sum(gaps) / len(gaps)) if gaps else 0.0
    max_gap = max(gaps) if gaps else 0.0

    return silence_seconds, avg_response, max_gap, gaps


def _count_silence_violations(
    gaps: List[float], threshold: float = SILENCE_VIOLATION_THRESHOLD_SECONDS
) -> int:
    """Count silence gaps that exceed the violation threshold (default 20s)."""
    return sum(1 for g in gaps if g >= threshold)


def _compute_talk_overs(turns: List[ConversationTurn]) -> int:
    """Count the number of times speakers overlap (talk over each other).

    An overlap occurs when one turn hasn't finished (by audio timing)
    before the next turn starts, and the speakers are different.
    """
    count = 0

    for i in range(len(turns) - 1):
        current = turns[i]
        next_turn = turns[i + 1]

        # Only count overlaps between different speakers
        if current.speaker == next_turn.speaker:
            continue

        current_end = current.audio_start_time + current.audio_duration
        overlap = current_end - next_turn.audio_start_time
        time_into_turn = next_turn.audio_start_time - current.audio_start_time

        if overlap > TALK_OVER_MIN_OVERLAP_SECONDS and time_into_turn > TALK_OVER_MIN_INTO_TURN_SECONDS:
            count += 1

    return count


def _compute_questions(turns: List[ConversationTurn]) -> tuple:
    """Count customer questions and how many the agent answered.

    A question is any customer turn containing a '?' character.
    A question is considered answered if an agent turn follows it
    (possibly after other customer turns).

    Returns:
        (questions_asked, questions_answered, questions_unanswered)
    """
    questions_asked = 0
    questions_answered = 0

    for i, turn in enumerate(turns):
        if turn.speaker != 'customer':
            continue

        if '?' not in turn.text:
            continue

        questions_asked += 1

        # Check if any subsequent agent turn follows before the conversation ends
        # or before the customer asks another question
        for j in range(i + 1, len(turns)):
            if turns[j].speaker == 'agent' and turns[j].text.strip():
                questions_answered += 1
                break

    questions_unanswered = questions_asked - questions_answered
    return questions_asked, questions_answered, questions_unanswered


def _detect_holds(turns: List[ConversationTurn]) -> int:
    """Detect hold events from agent speech patterns.

    Counts the number of times the agent uses hold-related phrases,
    indicating the caller was placed on hold.
    """
    count = 0
    for turn in turns:
        if turn.speaker != 'agent':
            continue
        lower = turn.text.lower()
        if any(phrase in lower for phrase in HOLD_PHRASES):
            count += 1
    return count


def _count_weak_phrases(turns: List[ConversationTurn]) -> int:
    """Count hedging/uncertainty phrases in agent speech.

    Flags phrases like "I don't know", "I'm not sure", "it looks like"
    that indicate lack of confidence.
    """
    count = 0
    for turn in turns:
        if turn.speaker != 'agent':
            continue
        lower = turn.text.lower()
        count += sum(1 for phrase in WEAK_PHRASES if phrase in lower)
    return count


