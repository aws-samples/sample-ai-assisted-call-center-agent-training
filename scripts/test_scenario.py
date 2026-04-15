#!/usr/bin/env python3
"""
Test scenarios against Nova Sonic.

Automated mode: an LLM (Nova 2 Lite) plays the agent/CSR, Nova Sonic plays the customer.
Interactive mode: you type agent lines, hear Nova Sonic's customer responses via audio.

Usage:
    python scripts/test_scenario.py --scenario jnl_bene_change_01
    python scripts/test_scenario.py --scenario jnl_bene_change_01 --voice tiffany --mood frustrated
    python scripts/test_scenario.py --scenario jnl_bene_change_01 --max-turns 20
    python scripts/test_scenario.py --scenario jnl_bene_change_01 --interactive
    python scripts/test_scenario.py --all
    python scripts/test_scenario.py --list
    python scripts/test_scenario.py --scenario jnl_bene_change_01 --show-script
"""

import argparse
import asyncio
import base64
from datetime import datetime
import re
import sys
import os

import boto3

# Add project root to path
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PROJECT_ROOT)

from src.config.models import NOVA_SONIC_MODEL_ID, NOVA_LITE_MODEL_ID
from strands import Agent
from strands.experimental.bidi.agent import BidiAgent
from strands.experimental.bidi.io import BidiAudioIO, BidiTextIO
from strands.experimental.bidi.models.nova_sonic import BidiNovaSonicModel
from strands.experimental.bidi.tools import stop_conversation
from strands.experimental.bidi.types.events import (
    BidiAudioInputEvent,
    BidiTextInputEvent,
)

from src.scenarios.loader import ScenarioLoader
from src.customer_prompt import (
    build_system_prompt,
    _SPEAKER_LINE,
    _METADATA_LABELS,
    _identify_csr_speakers,
)

DEFAULT_PROFILE = None
DEFAULT_REGION = "us-west-2"
LOG_DIR = os.path.join(PROJECT_ROOT, "test_logs")


def extract_agent_lines(original_call_logs: str) -> list[str]:
    """Extract the CSR/agent lines from original_call_logs."""
    if not original_call_logs or not original_call_logs.strip():
        return []

    raw_lines = original_call_logs.split("\n")
    raw_dialogue: list[tuple[str, str]] = []

    label_only = re.compile(r"^([A-Za-z\s.']+?)\s*:\s*$")
    pending_speaker: str | None = None

    for raw_line in raw_lines:
        line = raw_line.strip()
        if not line:
            continue
        if _METADATA_LABELS.match(line):
            continue

        m = _SPEAKER_LINE.match(line)
        if m:
            speaker = m.group(1).strip()
            text = m.group(2).strip()
            if text:
                raw_dialogue.append((speaker, text))
                pending_speaker = None
                continue

        lm = label_only.match(line)
        if lm:
            pending_speaker = lm.group(1).strip()
            continue

        if pending_speaker and line:
            raw_dialogue.append((pending_speaker, line))
            pending_speaker = None

    if not raw_dialogue:
        return []

    csr_speakers = _identify_csr_speakers(raw_dialogue)
    return [text for speaker, text in raw_dialogue if speaker in csr_speakers]


def build_csr_prompt(scenario) -> str:
    """Build a system prompt for the LLM-based CSR agent."""
    challenges = "\n".join(f"- {c}" for c in scenario.key_challenges)
    criteria = "\n".join(f"- {c}" for c in scenario.success_criteria)
    return f"""You are a medical insurance call center agent (CSR) in a training exercise. You must handle this call professionally.

## Scenario
{scenario.context}

## Key Challenges You Must Handle
{challenges}

## Success Criteria
{criteria}

## Reference Script
The following is a reference transcript of how this call was handled. Follow its general flow but respond naturally to what the customer actually says:

{scenario.original_call_logs}

## Instructions
- Respond with ONLY your next line as the agent — no quotes, no labels, no explanation
- Be concise and professional, like a real call center agent
- Follow the general structure of the reference script
- Adapt your response based on what the customer actually says
- Start with a greeting if this is the first message"""


def save_transcript(scenario_id: str, scenario_name: str, voice: str, mood: str,
                    transcript: list[tuple[str, str]]) -> str:
    """Save conversation transcript to a log file. Returns the file path."""
    os.makedirs(LOG_DIR, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"{scenario_id}_{timestamp}.txt"
    filepath = os.path.join(LOG_DIR, filename)

    with open(filepath, "w", encoding="utf-8") as f:
        f.write(f"Scenario: {scenario_name} ({scenario_id})\n")
        f.write(f"Voice: {voice} | Mood: {mood}\n")
        f.write(f"Timestamp: {datetime.now().isoformat()}\n")
        f.write(f"Turns: {len(transcript) // 2}\n")
        f.write("-" * 60 + "\n\n")
        for role, text in transcript:
            f.write(f"{role}: {text}\n\n")

    return filepath


def list_scenarios(loader: ScenarioLoader) -> None:
    """Print all available scenarios."""
    scenarios = loader.list_scenarios()
    print(f"Available scenarios ({len(scenarios)}):\n")
    for s in sorted(scenarios, key=lambda x: x["id"]):
        print(f"  {s['id']:<50s} {s['name']}")


async def run_scenario(scenario_id: str, voice: str, mood: str, profile: str, region: str,
                       interactive: bool = False, delay: float = 2.0,
                       max_turns: int = 15, loader: ScenarioLoader | None = None) -> None:
    """Run a scenario against Nova Sonic."""
    if loader is None:
        loader = ScenarioLoader(scenarios_dir=os.path.join(PROJECT_ROOT, "scenarios"))
        loader.load_all_scenarios()

    scenario = loader.get_scenario(scenario_id)
    if not scenario:
        print(f"Error: scenario not found: {scenario_id}", file=sys.stderr)
        print("Use --list to see available scenarios", file=sys.stderr)
        sys.exit(1)

    system_prompt = build_system_prompt(scenario, mood, voice_id=voice)

    print(f"Scenario: {scenario.name} ({scenario.scenario_id})")
    print(f"Voice: {voice} | Mood: {mood}")

    session = boto3.Session(profile_name=profile, region_name=region)
    model = BidiNovaSonicModel(
        model_id=NOVA_SONIC_MODEL_ID,
        provider_config={
            "audio": {
                "voice": voice,
            },
        },
        client_config={"boto_session": session},
    )

    agent = BidiAgent(
        model=model,
        tools=[stop_conversation],
        system_prompt=system_prompt,
    )

    if interactive:
        # Interactive mode: type lines manually, hear audio responses
        agent_lines = extract_agent_lines(scenario.original_call_logs)
        print("-" * 60)
        if agent_lines:
            print("Agent script (type these lines):")
            for i, line in enumerate(agent_lines, 1):
                print(f"  {i}. {line}")
            print("-" * 60)
        print("Type your agent lines. Nova Sonic will respond as the customer.")
        print("Press Ctrl+C to exit.")
        print("-" * 60)

        audio_io = BidiAudioIO()
        text_io = BidiTextIO(input_prompt="Agent> ")
        await agent.run(
            inputs=[audio_io.input(), text_io.input()],
            outputs=[audio_io.output(), text_io.output()],
        )
    else:
        # Automated mode: LLM generates agent lines, Nova Sonic responds as customer
        print(f"Max turns: {max_turns}")
        print("-" * 60)

        csr_agent = Agent(
            model=NOVA_LITE_MODEL_ID,
            system_prompt=build_csr_prompt(scenario),
            callback_handler=None,
        )

        transcript: list[tuple[str, str]] = []

        async with agent:
            # Background task: feed silent audio to keep Nova Sonic alive
            async def feed_silence():
                rate = agent.model.config["audio"]["input_rate"]
                channels = agent.model.config["audio"]["channels"]
                fmt = agent.model.config["audio"]["format"]
                chunk_size = int(rate * 0.02) * 2 * channels
                while True:
                    await asyncio.sleep(0.02)
                    silent = b"\x00" * chunk_size
                    await agent.send(BidiAudioInputEvent(
                        audio=base64.b64encode(silent).decode("utf-8"),
                        format=fmt,
                        sample_rate=rate,
                        channels=channels,
                    ))

            audio_task = asyncio.create_task(feed_silence())

            try:
                # Get first agent line (greeting)
                csr_response = str(csr_agent("Begin the call with your greeting."))

                for turn in range(max_turns):
                    print(f"\nAgent [{turn+1}]: {csr_response}")
                    transcript.append(("Agent", csr_response))
                    await agent.send(BidiTextInputEvent(text=csr_response, role="user"))

                    # Get customer response from Nova Sonic
                    customer_text = None
                    async for event in agent.receive():
                        event_type = event.get("type")
                        if event_type == "bidi_transcript_stream":
                            if event["is_final"] and event["role"] == "assistant":
                                customer_text = event["text"]
                                break
                        elif event_type == "bidi_connection_close":
                            break

                    if not customer_text:
                        print("\n(Customer ended the conversation)")
                        break

                    print(f"Customer (Nova Sonic): {customer_text}")
                    transcript.append(("Customer", customer_text))

                    await asyncio.sleep(delay)

                    # Get next agent line from LLM
                    csr_response = str(csr_agent(f"The customer said: {customer_text}"))
            finally:
                audio_task.cancel()

        # Save transcript
        log_path = save_transcript(scenario_id, scenario.name, voice, mood, transcript)
        turns = len(transcript) // 2
        print("\n" + "-" * 60)
        print(f"Done. {turns} turns completed.")
        print(f"Transcript saved to: {log_path}")


async def run_all_scenarios(voice: str, mood: str, profile: str, region: str,
                           delay: float = 2.0, max_turns: int = 15) -> None:
    """Run all scenarios sequentially."""
    loader = ScenarioLoader(scenarios_dir=os.path.join(PROJECT_ROOT, "scenarios"))
    loader.load_all_scenarios()

    scenario_ids = sorted(loader.scenarios.keys())
    total = len(scenario_ids)
    print(f"Running all {total} scenarios")
    print("=" * 60)

    passed = 0
    failed = []

    for i, sid in enumerate(scenario_ids, 1):
        print(f"\n{'=' * 60}")
        print(f"[{i}/{total}] {sid}")
        print("=" * 60)
        try:
            await run_scenario(
                sid, voice, mood, profile, region,
                delay=delay, max_turns=max_turns, loader=loader,
            )
            passed += 1
        except Exception as e:
            print(f"\nERROR in {sid}: {e}", file=sys.stderr)
            failed.append((sid, str(e)))

    print(f"\n{'=' * 60}")
    print(f"Results: {passed}/{total} passed")
    if failed:
        print(f"Failed ({len(failed)}):")
        for sid, err in failed:
            print(f"  {sid}: {err}")
    print(f"Transcripts saved to: {LOG_DIR}/")


def main():
    parser = argparse.ArgumentParser(description="Test scenarios against Nova Sonic")
    parser.add_argument("--scenario", help="Scenario ID (e.g. jnl_bene_change_01)")
    parser.add_argument("--all", action="store_true", help="Run all scenarios sequentially")
    parser.add_argument("--voice", default="matthew", help="Nova Sonic voice ID (default: matthew)")
    parser.add_argument("--mood", default="neutral", help="Customer mood (default: neutral)")
    parser.add_argument("--profile", default=DEFAULT_PROFILE, help="AWS profile (default: uses AWS credential chain)")
    parser.add_argument("--region", default=DEFAULT_REGION, help=f"AWS region (default: {DEFAULT_REGION})")
    parser.add_argument("--delay", type=float, default=2.0, help="Seconds between turns in auto mode (default: 2.0)")
    parser.add_argument("--interactive", action="store_true", help="Interactive mode: type lines manually with audio")
    parser.add_argument("--list", action="store_true", help="List available scenarios and exit")
    parser.add_argument("--max-turns", type=int, default=15, help="Max conversation turns in auto mode (default: 15)")
    parser.add_argument("--show-script", action="store_true", help="Show the agent script lines to type")
    args = parser.parse_args()

    loader = ScenarioLoader(scenarios_dir=os.path.join(PROJECT_ROOT, "scenarios"))
    loader.load_all_scenarios()

    if args.list:
        list_scenarios(loader)
        return

    if args.all:
        asyncio.run(run_all_scenarios(
            args.voice, args.mood, args.profile, args.region,
            delay=args.delay, max_turns=args.max_turns,
        ))
        return

    if not args.scenario:
        parser.error("--scenario or --all is required (use --list to see available scenarios)")

    if args.show_script:
        scenario = loader.get_scenario(args.scenario)
        if not scenario:
            print(f"Error: scenario not found: {args.scenario}", file=sys.stderr)
            sys.exit(1)
        agent_lines = extract_agent_lines(scenario.original_call_logs)
        print(f"Agent script for: {scenario.name}\n")
        for i, line in enumerate(agent_lines, 1):
            print(f"  {i}. {line}")
        return

    asyncio.run(run_scenario(
        args.scenario, args.voice, args.mood, args.profile, args.region,
        interactive=args.interactive, delay=args.delay,
        max_turns=args.max_turns,
    ))


if __name__ == "__main__":
    main()
