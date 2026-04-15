"""Duo (multi-character) session handler for BidiAgent.

Manages multiple BidiAgents with handoff logic for scenarios where
more than one customer character is on the call.
"""

import asyncio
import logging
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional

from strands.experimental.bidi.agent import BidiAgent
from strands.experimental.bidi.models.nova_sonic import BidiNovaSonicModel
from strands.tools.decorator import tool
from strands.types.tools import ToolContext

from src.config.models import NOVA_SONIC_MODEL_ID
from src.customer_prompt import build_character_prompt
from src.scenarios.loader import Character, Scenario
from src.voices import get_locale_voice_id
from src.agent.tools import verify_spelling

logger = logging.getLogger(__name__)


def _resolve_target(target: str, char_map: dict) -> str | None:
    """Resolve a hand_off target string to a character ID."""
    key = target.strip().lower()
    if key in char_map:
        return key
    for cid, char in char_map.items():
        if char.name.lower() == key:
            return cid
    return None


def relabel_messages(messages: list, char_map: dict, primary_id: str, target_id: str) -> list:
    """Deep-copy messages, re-role other characters' assistant messages to user.

    Walks through the message list tracking who is speaking. Starts with
    primary_id and switches whenever a hand_off toolUse is encountered.
    Messages from the target character stay as role=assistant.
    Messages from other characters are converted to role=user with attribution.
    """
    import copy
    labeled = copy.deepcopy(messages)
    current_speaker = primary_id

    for msg in labeled:
        content = msg.get("content", [])

        if msg.get("role") == "assistant":
            for block in content:
                if "toolUse" in block and block["toolUse"].get("name") == "hand_off":
                    target = block["toolUse"].get("input", {}).get("target", "")
                    resolved = _resolve_target(target, char_map)
                    if resolved:
                        current_speaker = resolved

            if current_speaker != target_id:
                speaker_name = char_map[current_speaker].name if current_speaker in char_map else current_speaker
                for block in content:
                    if "text" in block:
                        block["text"] = f"({speaker_name} said: {block['text']})"
                msg["role"] = "user"

    return labeled


def make_hand_off_tool(characters: list):
    """Create a single hand_off tool that accepts a target parameter.

    Returns a Strands @tool function that resolves the target by ID or name
    and sets duo_state to trigger handoff.
    """
    # Build lookup maps
    id_to_name = {c.id: c.name for c in characters}
    name_to_id = {c.name.lower(): c.id for c in characters}
    target_list = ", ".join(f"{c.id} ({c.name})" for c in characters)

    @tool(context="tool_context")
    def hand_off(target: str, tool_context: ToolContext) -> str:
        """Hand the conversation to another character on the call."""
        duo_state = tool_context.invocation_state["duo_state"]
        key = target.strip().lower()

        # Resolve by ID first, then by name
        target_id = key if key in id_to_name else name_to_id.get(key)
        if not target_id:
            return f"Unknown target '{target}'. Valid targets: {target_list}"
        if duo_state["active"] == target_id:
            return f"Already handed off to {id_to_name[target_id]}."

        duo_state["active"] = target_id
        duo_state["pending_handoff"] = target_id
        logger.info(f"HANDOFF -> {id_to_name[target_id]} ({target_id})")
        return f"Handed off to {id_to_name[target_id]}. They are now the active speaker."

    # Update docstring with valid targets
    hand_off.__doc__ = (
        f"Hand the conversation to another character on the call.\n\n"
        f"Valid targets: {target_list}\n\n"
        f"Args:\n    target: The character ID or name to hand off to."
    )

    return hand_off


async def run_duo_session(
    scenario: Scenario,
    customer_mood: str,
    language_mode: str,
    character_voices: Dict[str, str],
    aws_region: str,
    ws_receive: Callable,
    ws_send: Callable,
    session_recorder: Any = None,
) -> None:
    """Run a multi-character duo session.

    Args:
        scenario: Scenario with characters array.
        customer_mood: Mood for all characters.
        language_mode: "english" or "native".
        character_voices: Map of character_id -> voice_id (overrides from frontend).
        aws_region: AWS region for Bedrock.
        ws_receive: Async callable that returns the next WebSocket message (dict).
        ws_send: Async callable that sends a dict to the WebSocket.
        session_recorder: Optional SessionRecorder for transcript capture.
    """
    characters = scenario.characters
    if not characters or len(characters) < 2:
        raise ValueError("Duo session requires at least 2 characters")

    # Build character lookup
    char_map: Dict[str, Character] = {c.id: c for c in characters}
    primary = next((c for c in characters if c.is_primary), characters[0])

    # Create single handoff tool shared by all characters
    hand_off_tool = make_hand_off_tool(characters)
    shared_tools = [verify_spelling, hand_off_tool]

    # Create BidiAgents for each character
    agents: Dict[str, BidiAgent] = {}
    for char in characters:
        voice = character_voices.get(char.id, char.voice)
        locale_voice = get_locale_voice_id(voice, language_mode)
        logger.info(f"Character {char.id}: using locale-prefixed voice {locale_voice}")
        model = BidiNovaSonicModel(
            region=aws_region,
            model_id=NOVA_SONIC_MODEL_ID,
            provider_config={
                "audio": {
                    "input_rate": 16000,
                    "output_rate": 24000,
                    "voice": locale_voice,
                }
            },
        )
        prompt = build_character_prompt(
            char,
            customer_mood=customer_mood,
            language_mode=language_mode,
        )
        agents[char.id] = BidiAgent(
            model=model,
            tools=shared_tools,
            system_prompt=prompt,
        )

    # Shared state
    state = {
        "active": primary.id,
        "pending_handoff": None,
        "output_handles": {},
        "ready": set(),
    }
    invocation_state = {"duo_state": state}

    # -- Output task for a character --
    async def character_output_task(char_id: str):
        """Receive events from a character's agent and forward to WebSocket."""
        agent = agents[char_id]
        async for event in agent.receive():
            # Only forward output from the active character
            if state["active"] == char_id:
                event_type = event.get("type", "")

                # Enrich transcript events with character name
                if event_type == "bidi_transcript_stream":
                    event["character_id"] = char_id
                    event["character_name"] = char_map[char_id].name

                    # Record transcript
                    if event.get("is_final") and session_recorder and session_recorder.is_recording:
                        role = event.get("role", "unknown")
                        text = event.get("text", "")
                        speaker = f"customer ({char_map[char_id].name})" if role == "assistant" else "agent"
                        audio_start_time = (datetime.now() - session_recorder.start_time).total_seconds()
                        session_recorder.add_transcript_turn(
                            speaker=speaker,
                            text=text,
                            audio_start_time=audio_start_time,
                            audio_duration=0.0,
                        )

                try:
                    await ws_send(event)
                except Exception:
                    return

    async def _await_output(char_id: str):
        """Wrapper that survives output task cancellation on restart."""
        while state["output_handles"].get(char_id):
            try:
                await state["output_handles"][char_id]
                break
            except asyncio.CancelledError:
                await asyncio.sleep(0.05)

    # -- Handoff logic --
    async def _do_handoff(target_id: str):
        """Stop all agents, copy messages, start target agent."""
        source_id = None
        # Find which agent has the most recent messages
        for cid in state["ready"]:
            if cid != target_id:
                source_id = cid
                break

        # Cancel and stop all running agents
        for cid in list(state["ready"]):
            handle = state["output_handles"].get(cid)
            if handle:
                handle.cancel()
                try:
                    await handle
                except asyncio.CancelledError:
                    pass
                state["output_handles"][cid] = None
            await agents[cid].stop()
        state["ready"].clear()

        # Copy messages from source to target, re-roling other character's lines
        if source_id:
            agents[target_id].messages = relabel_messages(
                agents[source_id].messages, char_map, primary.id, target_id
            )

        # Start target agent
        await agents[target_id].start(invocation_state=invocation_state)
        state["ready"].add(target_id)
        state["output_handles"][target_id] = asyncio.create_task(
            character_output_task(target_id)
        )

        # Nudge the new character with strong identity reminder
        char = char_map[target_id]
        other_names = [char_map[cid].name for cid in char_map if cid != target_id]
        others_str = ", ".join(other_names)

        if char.is_primary and source_id:
            await agents[target_id].send(
                f"IMPORTANT: You are {char.name}. Lines from {others_str} appear as user messages "
                f"with '(Name said: ...)'. Your own previous lines are the assistant messages. "
                f"You have already introduced yourself. Do NOT repeat your introduction. "
                f"The agent is now asking YOU a question. Answer it directly based on your character details."
            )
        elif not char.is_primary:
            await agents[target_id].send(
                f"IMPORTANT: You are {char.name}. Lines from {others_str} appear as user messages "
                f"with '(Name said: ...)'. Your own previous lines are the assistant messages. "
                f"The call center agent is now addressing you. Introduce yourself and explain your issue."
            )

        logger.info(f"Character {char.name} ({target_id}) (re)started with full conversation context")
        state["pending_handoff"] = None

    # -- Input task --
    async def input_task():
        """Read from WebSocket and forward to active agent."""
        while True:
            event = await ws_receive()

            # Check for pending handoff
            if state.get("pending_handoff"):
                await _do_handoff(state["pending_handoff"])

            active_id = state["active"]
            if active_id in state["ready"]:
                await agents[active_id].send(event)

    # -- Start primary character --
    await agents[primary.id].start(invocation_state=invocation_state)
    state["ready"].add(primary.id)
    state["output_handles"][primary.id] = asyncio.create_task(
        character_output_task(primary.id)
    )

    try:
        # Run input + all output await wrappers
        tasks = [input_task()]
        for char in characters:
            tasks.append(_await_output(char.id))
        await asyncio.gather(*tasks)
    finally:
        # Clean up all agents
        for cid in list(state["ready"]):
            try:
                handle = state["output_handles"].get(cid)
                if handle:
                    handle.cancel()
                    try:
                        await handle
                    except asyncio.CancelledError:
                        pass
                await agents[cid].stop()
            except Exception as e:
                logger.debug(f"Error stopping agent {cid}: {e}")
