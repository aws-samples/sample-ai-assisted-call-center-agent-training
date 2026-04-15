#!/usr/bin/env python3
"""
Test the voice agent locally without deploying to AgentCore.

Runs a BidiAgent with the same configuration as production (system prompt,
verify_spelling tool, Nova Sonic model) and connects it to your local
microphone and speakers.

Usage:
    python scripts/test_local.py --scenario jnl_bene_change_01
    python scripts/test_local.py --scenario jnl_bene_change_01 --voice tiffany --mood frustrated
    python scripts/test_local.py --scenario jnl_bene_change_01 --text-only
    python scripts/test_local.py --list
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
from strands.experimental.bidi.tools import stop_conversation

from src.config.models import NOVA_SONIC_MODEL_ID
from src.scenarios.loader import ScenarioLoader
from src.customer_prompt import build_system_prompt
from src.agent.tools import verify_spelling

DEFAULT_PROFILE = None
DEFAULT_REGION = "us-west-2"


def list_scenarios(loader: ScenarioLoader) -> None:
    """Print all available scenarios."""
    scenarios = loader.list_scenarios()
    print(f"Available scenarios ({len(scenarios)}):\n")
    for s in sorted(scenarios, key=lambda x: x["id"]):
        print(f"  {s['id']:<50s} {s['name']}")


async def run(scenario_id: str, voice: str, mood: str, profile: str,
              region: str, text_only: bool, language_mode: str) -> None:
    """Run a local voice agent session."""
    loader = ScenarioLoader(scenarios_dir=os.path.join(PROJECT_ROOT, "scenarios"))
    loader.load_all_scenarios()

    scenario = loader.get_scenario(scenario_id)
    if not scenario:
        print(f"Error: scenario not found: {scenario_id}", file=sys.stderr)
        print("Use --list to see available scenarios", file=sys.stderr)
        sys.exit(1)

    system_prompt = build_system_prompt(
        scenario, mood, voice_id=voice, language_mode=language_mode,
    )

    print(f"Scenario:  {scenario.name} ({scenario.scenario_id})")
    print(f"Voice:     {voice}")
    print(f"Mood:      {mood}")
    print(f"Language:  {language_mode}")
    print(f"Mode:      {'text-only' if text_only else 'voice (mic + speaker)'}")
    print("-" * 60)

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
        tools=[verify_spelling],
        system_prompt=system_prompt,
    )

    if text_only:
        text_io = BidiTextIO(input_prompt="Agent> ")
        print("Type your agent lines. The customer (Nova Sonic) will respond.")
        print("Press Ctrl+C to exit.\n")
        await agent.run(
            inputs=[text_io.input()],
            outputs=[text_io.output()],
        )
    else:
        audio_io = BidiAudioIO()
        text_io = BidiTextIO(input_prompt="Agent> ")
        print("Speak into your microphone. The customer will respond via speaker.")
        print("You can also type messages. Press Ctrl+C to exit.\n")
        await agent.run(
            inputs=[audio_io.input(), text_io.input()],
            outputs=[audio_io.output(), text_io.output()],
        )


def main():
    parser = argparse.ArgumentParser(
        description="Test the voice agent locally without deploying to AgentCore"
    )
    parser.add_argument("--scenario", help="Scenario ID (e.g. jnl_bene_change_01)")
    parser.add_argument("--voice", default="matthew", help="Nova Sonic voice ID (default: matthew)")
    parser.add_argument("--mood", default="neutral", help="Customer mood (default: neutral)")
    parser.add_argument("--language-mode", default="english",
                        choices=["english", "native"],
                        help="Language mode (default: english)")
    parser.add_argument("--text-only", action="store_true",
                        help="Text-only mode: type agent lines instead of using microphone")
    parser.add_argument("--profile", default=DEFAULT_PROFILE,
                        help="AWS profile (default: uses AWS credential chain)")
    parser.add_argument("--region", default=DEFAULT_REGION,
                        help=f"AWS region (default: {DEFAULT_REGION})")
    parser.add_argument("--list", action="store_true",
                        help="List available scenarios and exit")
    args = parser.parse_args()

    if args.list:
        loader = ScenarioLoader(scenarios_dir=os.path.join(PROJECT_ROOT, "scenarios"))
        loader.load_all_scenarios()
        list_scenarios(loader)
        return

    if not args.scenario:
        parser.error("--scenario is required (use --list to see available scenarios)")

    try:
        asyncio.run(run(
            args.scenario, args.voice, args.mood, args.profile,
            args.region, args.text_only, args.language_mode,
        ))
    except KeyboardInterrupt:
        print("\nSession ended.")


if __name__ == "__main__":
    main()
