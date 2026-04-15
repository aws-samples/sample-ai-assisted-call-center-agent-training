"""Data types for session recording - no audio dependencies"""
from dataclasses import dataclass, asdict, field
from typing import List, Dict, Any, Optional


@dataclass
class ConversationTurn:
    """Represents a single turn in the conversation"""
    timestamp: str
    speaker: str  # "customer" or "agent"
    text: str
    audio_start_time: float
    audio_duration: float


@dataclass
class SessionRecording:
    """Complete recording of a training session"""
    session_id: str
    scenario_id: str
    scenario_name: str
    start_time: str
    end_time: str
    duration_seconds: float
    customer_mood: str
    difficulty: str
    transcript: List[ConversationTurn]
    metadata: Dict[str, Any]
    user_id: str = ""
    user_name: str = ""
    audio_file: str = ""
    token_usage: Optional[Dict[str, Any]] = None