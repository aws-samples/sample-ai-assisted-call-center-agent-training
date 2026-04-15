#!/usr/bin/env python3
"""
Test two Nova Sonic BidiAgents locally — one for each caller (husband & wife).

Based on the athene_tax_call_01 scenario: Jay Forrester (policy owner) and his
wife Merry Forrester call together.  Jay handles the opening and identity
verification; once he grants permission, Merry takes over for financial questions.

Each character gets its own BidiAgent with a distinct voice.  The human user
plays the call-center agent (trainee).

Uses the same prompt builder (build_character_prompt) and scenario loader as the
production agentcore server, so local test results are directly comparable.

Usage:
    python scripts/test_local_duo.py
    python scripts/test_local_duo.py --text-only
    python scripts/test_local_duo.py --mood frustrated --voice customer_1=matthew --voice customer_2=tiffany
"""

import argparse
import asyncio
import os
import sys

import boto3

# Add project root to path
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PROJECT_ROOT)

from strands.experimental.bidi.agent import BidiAgent
from strands.experimental.bidi.io import BidiAudioIO, BidiTextIO
from strands.experimental.bidi.models.nova_sonic import BidiNovaSonicModel
from strands.tools.decorator import tool
from strands.types.tools import ToolContext

from src.config.models import NOVA_SONIC_MODEL_ID
from src.customer_prompt import build_character_prompt
from src.scenarios.loader import ScenarioLoader
from src.agent.tools import verify_spelling

DEFAULT_PROFILE = None
DEFAULT_REGION = "us-west-2"
DEFAULT_SCENARIO = "athene_tax_call_01"


# ---------------------------------------------------------------------------
# Single handoff tool — takes a target parameter
# ---------------------------------------------------------------------------
# Populated at runtime from scenario characters
_CHAR_LOOKUP: dict = {}   # id -> Character


@tool(context="tool_context")
def hand_off(target: str, tool_context: ToolContext) -> str:
    """Hand the conversation to another character on the call."""
    duo_state = tool_context.invocation_state["duo_state"]
    key = target.strip().lower()

    # Resolve by ID first, then by name
    target_id = key if key in _CHAR_LOOKUP else None
    if not target_id:
        for cid, char in _CHAR_LOOKUP.items():
            if char.name.lower() == key:
                target_id = cid
                break
    if not target_id:
        valid = ", ".join(f"{c.id} ({c.name})" for c in _CHAR_LOOKUP.values())
        return f"Unknown target '{target}'. Valid targets: {valid}"
    if duo_state["active"] == target_id:
        return f"Already handed off to {_CHAR_LOOKUP[target_id].name}."

    previous = duo_state["active"]
    duo_state["active"] = target_id
    duo_state["pending_handoff"] = target_id
    prev_name = _CHAR_LOOKUP[previous].name if previous in _CHAR_LOOKUP else previous
    print(f"\n*** HANDOFF: {prev_name} -> {_CHAR_LOOKUP[target_id].name} ***\n")
    return f"Handed off to {_CHAR_LOOKUP[target_id].name}. They are now the active speaker."


# Update docstring after _CHAR_LOOKUP is populated
def _update_hand_off_doc():
    valid = ", ".join(f"{c.id} ({c.name})" for c in _CHAR_LOOKUP.values())
    hand_off.__doc__ = (
        f"Hand the conversation to another character on the call.\n\n"
        f"Valid targets: {valid}\n\n"
        f"Args:\n    target: The character ID or name to hand off to."
    )


# ---------------------------------------------------------------------------
# Message labeling for handoff
# ---------------------------------------------------------------------------
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
            # Check for hand_off toolUse to track speaker changes
            for block in content:
                if "toolUse" in block and block["toolUse"].get("name") == "hand_off":
                    target = block["toolUse"].get("input", {}).get("target", "")
                    resolved = _resolve_target(target, char_map)
                    if resolved:
                        current_speaker = resolved

            # If this message is from a different character, re-role it
            if current_speaker != target_id:
                speaker_name = char_map[current_speaker].name if current_speaker in char_map else current_speaker
                for block in content:
                    if "text" in block:
                        block["text"] = f"({speaker_name} said: {block['text']})"
                msg["role"] = "user"

    return labeled


# ---------------------------------------------------------------------------
# Main run loop
# ---------------------------------------------------------------------------
async def run(
    mood: str,
    voice_overrides: dict,
    profile: str,
    region: str,
    text_only: bool,
    scenario_id: str,
) -> None:
    # Load scenario
    loader = ScenarioLoader(scenarios_dir=os.path.join(PROJECT_ROOT, "scenarios"))
    loader.load_all_scenarios()
    scenario = loader.get_scenario(scenario_id)
    if not scenario:
        print(f"Error: Scenario '{scenario_id}' not found.")
        return
    if not scenario.is_duo:
        print(f"Error: Scenario '{scenario_id}' is not a multi-character scenario.")
        return

    characters = scenario.characters
    primary = next((c for c in characters if c.is_primary), characters[0])
    secondary_ids = [c.id for c in characters if c.id != primary.id]

    # Populate global lookup for handoff tool
    _CHAR_LOOKUP.clear()
    for c in characters:
        _CHAR_LOOKUP[c.id] = c
    _update_hand_off_doc()

    print(f"Scenario:    {scenario.name} (duo mode)")
    for c in characters:
        voice = voice_overrides.get(c.id, c.voice)
        tag = " [primary]" if c.is_primary else ""
        print(f"  {c.id} ({c.name}): voice={voice}{tag}")
    print(f"Mood:        {mood}")
    print(f"Mode:        {'text-only' if text_only else 'voice (mic + speaker)'}")
    print("-" * 60)

    session = boto3.Session(profile_name=profile, region_name=region)

    # -- Create agents for each character --
    agents = {}
    for char in characters:
        voice = voice_overrides.get(char.id, char.voice)
        model = BidiNovaSonicModel(
            model_id=NOVA_SONIC_MODEL_ID,
            provider_config={"audio": {"voice": voice}},
            client_config={"boto_session": session},
        )
        prompt = build_character_prompt(char, customer_mood=mood)
        agents[char.id] = BidiAgent(
            model=model,
            tools=[verify_spelling, hand_off],
            system_prompt=prompt,
        )

    # -- I/O objects --
    audio_io = BidiAudioIO()
    text_io = BidiTextIO(input_prompt="Agent> ")

    if text_only:
        input_obj = text_io.input()
        output_obj = text_io.output()
    else:
        input_obj = audio_io.input()
        output_obj = audio_io.output()
        text_output_obj = text_io.output()

    # Mutable state shared across tasks (single-threaded asyncio — no lock needed)
    state = {"active": primary.id, "pending_handoff": None}
    invocation_state = {"duo_state": state}

    # Event that signals secondary agent is started and ready to receive
    secondary_ready = asyncio.Event()

    # -- Helpers --
    async def _do_handoff(target_id: str):
        """Stop all agents, copy messages, start target agent."""
        source_id = state["active"] if state["active"] != target_id else None
        # Find actual source (the one with messages)
        for cid in list(agents.keys()):
            if cid != target_id and state.get(f"{cid}_output_handle"):
                source_id = cid
                break

        # Cancel and stop all running agents
        for cid in list(agents.keys()):
            handle = state.get(f"{cid}_output_handle")
            if handle:
                handle.cancel()
                try:
                    await handle
                except asyncio.CancelledError:
                    pass
                state[f"{cid}_output_handle"] = None
            if cid == primary.id or secondary_ready.is_set():
                try:
                    await agents[cid].stop()
                except Exception:
                    pass

        if target_id != primary.id:
            secondary_ready.clear()

        # Copy messages from source to target, re-roling other character's lines
        if source_id and source_id in agents:
            agents[target_id].messages = relabel_messages(
                agents[source_id].messages, _CHAR_LOOKUP, primary.id, target_id
            )
            print(f"relabeled messages: {agents[target_id].messages}")

        # Start target agent
        await agents[target_id].start(invocation_state=invocation_state)
        if target_id != primary.id:
            secondary_ready.set()

        # Recreate output task
        state[f"{target_id}_output_handle"] = asyncio.create_task(
            output_task(target_id)
        )

        # Nudge the new character with strong identity reminder
        char = _CHAR_LOOKUP[target_id]
        # Build list of other character names for context
        other_names = [_CHAR_LOOKUP[cid].name for cid in _CHAR_LOOKUP if cid != target_id]
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

        print(f"*** {char.name}'s agent (re)started with full conversation context ***\n")
        state["pending_handoff"] = None

    # -- Async tasks --
    async def input_task():
        """Read from mic/keyboard and forward to the active agent only."""
        while True:
            event = await input_obj()
            if state.get("pending_handoff"):
                await _do_handoff(state["pending_handoff"])
            active_id = state["active"]
            await agents[active_id].send(event)

    async def text_input_task():
        """In voice mode, also accept typed input and forward to the active agent."""
        text_in = text_io.input()
        await text_in.start(agents[primary.id])
        try:
            while True:
                event = await text_in()
                if state.get("pending_handoff"):
                    await _do_handoff(state["pending_handoff"])
                active_id = state["active"]
                await agents[active_id].send(event)
        finally:
            await text_in.stop()

    async def output_task(char_id: str):
        """Process a character's output. Always drain to avoid blocking."""
        async for event in agents[char_id].receive():
            if state["active"] == char_id:
                if text_only:
                    await output_obj(event)
                else:
                    await output_obj(event)
                    await text_output_obj(event)

    async def _await_output(char_id: str):
        """Wrapper that survives output task being cancelled on restart."""
        if char_id != primary.id:
            await secondary_ready.wait()
        while state.get(f"{char_id}_output_handle"):
            try:
                await state[f"{char_id}_output_handle"]
                break
            except asyncio.CancelledError:
                await asyncio.sleep(0.05)

    # -- Start primary character's agent and I/O --
    await agents[primary.id].start(invocation_state=invocation_state)
    await input_obj.start(agents[primary.id])
    await output_obj.start(agents[primary.id])
    if not text_only:
        await text_output_obj.start(agents[primary.id])

    state[f"{primary.id}_output_handle"] = asyncio.create_task(output_task(primary.id))

    try:
        primary_name = primary.name
        secondary_names = ", ".join(_CHAR_LOOKUP[sid].name for sid in secondary_ids)
        if text_only:
            print(f"Type your agent lines. {primary_name} speaks first; {secondary_names} after handoff.")
            print("Press Ctrl+C to exit.\n")
            await asyncio.gather(
                input_task(),
                _await_output(primary.id),
                *[_await_output(sid) for sid in secondary_ids],
            )
        else:
            print(f"Speak into your microphone. {primary_name} speaks first; {secondary_names} after handoff.")
            print("You can also type messages. Press Ctrl+C to exit.\n")
            await asyncio.gather(
                input_task(),
                text_input_task(),
                _await_output(primary.id),
                *[_await_output(sid) for sid in secondary_ids],
            )
    finally:
        await input_obj.stop()
        await output_obj.stop()
        if not text_only:
            await text_output_obj.stop()
        for cid in agents:
            try:
                handle = state.get(f"{cid}_output_handle")
                if handle:
                    handle.cancel()
                    try:
                        await handle
                    except asyncio.CancelledError:
                        pass
                await agents[cid].stop()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description="Test multi-character BidiAgents locally"
    )
    parser.add_argument(
        "--scenario", default=DEFAULT_SCENARIO,
        help=f"Scenario ID to load (default: {DEFAULT_SCENARIO})",
    )
    parser.add_argument(
        "--mood", default="neutral",
        help="Customer mood for all callers (default: neutral)",
    )
    parser.add_argument(
        "--voice", action="append", default=[],
        metavar="ID=VOICE",
        help="Voice override per character, e.g. --voice customer_1=matthew --voice customer_2=tiffany",
    )
    parser.add_argument(
        "--text-only", action="store_true",
        help="Text-only mode: type agent lines instead of using microphone",
    )
    parser.add_argument(
        "--profile", default=DEFAULT_PROFILE,
        help="AWS profile (default: uses AWS credential chain)",
    )
    parser.add_argument(
        "--region", default=DEFAULT_REGION,
        help=f"AWS region (default: {DEFAULT_REGION})",
    )
    args = parser.parse_args()

    # Parse voice overrides
    voice_overrides = {}
    for v in args.voice:
        if "=" in v:
            cid, voice = v.split("=", 1)
            voice_overrides[cid] = voice

    try:
        asyncio.run(run(
            args.mood, voice_overrides,
            args.profile, args.region, args.text_only,
            args.scenario,
        ))
    except KeyboardInterrupt:
        print("\nSession ended.")


if __name__ == "__main__":
    main()
