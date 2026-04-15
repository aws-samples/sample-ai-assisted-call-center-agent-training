#!/usr/bin/env python3
"""
AgentCore WebSocket Server for Call Center Training Agent
Uses Strands BidiAgent for bidirectional streaming with Nova Sonic
"""

import asyncio
import logging
import os
import sys
from datetime import datetime
from contextlib import asynccontextmanager
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

# Add parent directory to path for imports
sys.path.insert(0, '/app')

from strands.experimental.bidi.agent import BidiAgent
from strands.experimental.bidi.models.nova_sonic import BidiNovaSonicModel
from src.config.models import NOVA_SONIC_MODEL_ID
from src.scenarios.loader import ScenarioLoader
from src.recording.session_recorder import SessionRecorder
from src.customer_prompt import build_system_prompt
from src.voices import get_locale_voice_id
from src.agent.tools import verify_spelling
from src.agent.duo_session import run_duo_session
import boto3

# Configure logging
LOGLEVEL = os.environ.get("LOGLEVEL", "INFO").upper()
logging.basicConfig(
    level=LOGLEVEL,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger(__name__)

# Global scenario loader
scenario_loader = ScenarioLoader()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifecycle: startup and shutdown."""
    try:
        region = os.getenv('AWS_REGION') or os.getenv('AWS_DEFAULT_REGION') or 'us-west-2'
        logger.info("🚀 Call Center Training Agent starting...")
        logger.info(f"📍 AWS Region: {region}")

        # Load scenarios — DynamoDB if SCENARIOS_TABLE is set, else filesystem (local dev)
        try:
            scenarios_table = os.getenv('SCENARIOS_TABLE')
            if scenarios_table:
                logger.info(f"Loading scenarios from DynamoDB table: {scenarios_table}")
                scenario_loader.load_from_dynamodb(scenarios_table)
            else:
                logger.info("Loading scenarios from filesystem (SCENARIOS_TABLE not set)")
                scenario_loader.load_all_scenarios()
            scenarios = scenario_loader.list_scenarios()
            logger.info(f"✅ Loaded {len(scenarios)} training scenarios")
        except Exception as e:
            logger.warning(f"⚠️  Could not load scenarios: {e}")

        yield

    finally:
        logger.info("🛑 Application shutting down...")


# Create FastAPI app
app = FastAPI(
    title="Call Center Training Agent WebSocket Server",
    lifespan=lifespan
)


@app.get("/health")
@app.get("/")
async def health_check():
    """Health check endpoint"""
    return JSONResponse({"status": "healthy", "service": "call-center-training-agent"})


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """
    WebSocket endpoint for bidirectional streaming training sessions.
    Uses Strands BidiAgent for Nova Sonic integration.

    Protocol:
    1. Client sends config: {"type": "session_config", "scenario_id": "...", "voice_id": "...", "session_id": "..."}
    2. Client sends audio: {"type": "bidi_audio_input", "audio": "<base64>", ...}
    3. Server sends back: bidi_audio_stream, bidi_transcript_stream, bidi_interruption, etc.
    4. Client closes WebSocket to end session
    """
    logger.info(f"WebSocket connection from: {websocket.client}")

    await websocket.accept()
    logger.info("WebSocket connection accepted")

    aws_region = os.getenv("AWS_DEFAULT_REGION", os.getenv("AWS_REGION", "us-west-2"))
    session_recorder = None
    session_id = None

    try:
        # Step 1: Wait for session config message
        config_message = await websocket.receive_json()

        if config_message.get("type") != "session_config":
            logger.error(f"Expected session_config, got: {config_message.get('type')}")
            await websocket.send_json({"type": "error", "message": "First message must be session_config"})
            await websocket.close()
            return

        scenario_id = config_message.get("scenario_id")
        voice_id = config_message.get("voice_id", "matthew")
        customer_mood = config_message.get("customer_mood", "neutral")
        session_id = config_message.get("session_id")
        user_id = config_message.get("user_id", "")
        user_name = config_message.get("user_name", "")
        language_mode = config_message.get("language_mode", "english")

        logger.info(f"Session config: scenario={scenario_id}, voice={voice_id}, mood={customer_mood}, language_mode={language_mode}, session_id={session_id}, user_id={user_id}")

        # Load scenario and build system prompt
        system_prompt = "You are a helpful assistant."
        scenario = None
        if scenario_id:
            scenarios_table = os.getenv('SCENARIOS_TABLE')
            if scenarios_table:
                # Always fetch fresh from DynamoDB so admin edits take effect immediately
                scenario = scenario_loader.load_single_from_dynamodb(scenarios_table, scenario_id)
            else:
                scenario = scenario_loader.get_scenario(scenario_id)
            if scenario:
                system_prompt = build_system_prompt(
                    scenario, customer_mood,
                    language_mode=language_mode,
                    voice_id=voice_id,
                )
                logger.info(f"Loaded scenario: {scenario.name}")
            else:
                logger.warning(f"Scenario not found: {scenario_id}")

        # Start recording
        if scenario:
            session_recorder = SessionRecorder(recordings_dir="/tmp/recordings")  # nosec B108
            session_recorder.start_recording(
                scenario_id=scenario_id,
                scenario_name=scenario.name,
                customer_mood=customer_mood,
                difficulty="",
                session_id=session_id,
                user_id=user_id,
                user_name=user_name,
            )
            logger.info(f"Started recording with sessionId: {session_recorder.session_id}")

        # Send confirmation to client
        effective_session_id = session_id or (session_recorder.session_id if session_recorder else None)
        await websocket.send_json({"type": "session_started", "session_id": effective_session_id})

        # Token usage accumulator for Nova Sonic
        nova_sonic_usage = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}

        # Step 2: Run session (duo or single-agent)
        if scenario and scenario.is_duo:
            # --- Duo mode: multiple characters with handoff ---
            character_voices = config_message.get("character_voices", {})
            logger.info(f"Starting duo session with {len(scenario.characters)} characters")

            try:
                await run_duo_session(
                    scenario=scenario,
                    customer_mood=customer_mood,
                    language_mode=language_mode,
                    character_voices=character_voices,
                    aws_region=aws_region,
                    ws_receive=websocket.receive_json,
                    ws_send=websocket.send_json,
                    session_recorder=session_recorder,
                )
            except asyncio.CancelledError:
                logger.info("Duo session cancelled (graceful shutdown)")

        else:
            # --- Single-agent mode (original flow) ---
            locale_voice = get_locale_voice_id(voice_id, language_mode)
            logger.info(f"Using locale-prefixed voice: {locale_voice}")
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

            agent = BidiAgent(
                model=model,
                tools=[verify_spelling],
                system_prompt=system_prompt,
            )

            logger.info("BidiAgent created, starting session")

            # Recording-aware output wrapper
            async def recording_output(event: dict):
                """Intercept output events for recording, then forward to WebSocket"""
                try:
                    event_type = event.get("type", "")

                    # Record transcript (only final transcripts — no duplicates)
                    if event_type == "bidi_transcript_stream" and session_recorder and session_recorder.is_recording:
                        is_final = event.get("is_final", False)
                        if is_final:
                            role = event.get("role", "unknown")
                            text = event.get("text", "")
                            speaker = "customer" if role == "assistant" else "agent"

                            audio_start_time = (datetime.now() - session_recorder.start_time).total_seconds()
                            session_recorder.add_transcript_turn(
                                speaker=speaker,
                                text=text,
                                audio_start_time=audio_start_time,
                                audio_duration=0.0
                            )
                            logger.info(f"Recorded transcript: {speaker} - {text[:50]}...")

                    # Capture token usage from bidi_usage events
                    if event_type == "bidi_usage":
                        nova_sonic_usage["input_tokens"] += event.get("inputTokens", 0)
                        nova_sonic_usage["output_tokens"] += event.get("outputTokens", 0)
                        nova_sonic_usage["total_tokens"] += event.get("totalTokens", 0)

                    # Forward event to WebSocket client
                    await websocket.send_json(event)

                except Exception as e:
                    logger.error(f"Error in recording_output: {e}", exc_info=True)

            # Input wrapper
            async def recording_input():
                """Read from WebSocket."""
                return await websocket.receive_json()

            try:
                await agent.run(
                    inputs=[recording_input],
                    outputs=[recording_output]
                )
            except asyncio.CancelledError:
                logger.info("BidiAgent session cancelled (graceful shutdown)")

        logger.info("Session ended normally")

    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected: {websocket.client}")
    except Exception as e:
        logger.error(f"WebSocket handler error: {e}", exc_info=True)
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:  # nosec B110
            logger.debug("Could not send error to client", exc_info=True)
    finally:
        # Save recording and upload to S3
        if session_recorder and session_recorder.is_recording:
            try:
                # Attach Nova Sonic token usage to session metadata
                if nova_sonic_usage["total_tokens"] > 0:
                    session_recorder.token_usage = {
                        "nova_sonic": {
                            "model": NOVA_SONIC_MODEL_ID,
                            "input_tokens": nova_sonic_usage["input_tokens"],
                            "output_tokens": nova_sonic_usage["output_tokens"],
                            "total_tokens": nova_sonic_usage["total_tokens"],
                        }
                    }
                    logger.info("TOKEN_USAGE component=nova_sonic model=%s input_tokens=%d output_tokens=%d total_tokens=%d session_id=%s",
                                NOVA_SONIC_MODEL_ID, nova_sonic_usage["input_tokens"],
                                nova_sonic_usage["output_tokens"], nova_sonic_usage["total_tokens"],
                                session_id)

                logger.info("Stopping recording and uploading to S3")
                recording = session_recorder.stop_recording()

                s3_bucket = os.getenv("S3_RECORDINGS_BUCKET")
                if s3_bucket:
                    try:
                        from botocore.config import Config as BotoConfig
                        # Use a fresh S3 client with standard transfer (not CRT)
                        # to avoid InvalidStateError from cancelled futures after disconnect
                        s3_client = boto3.client(
                            's3',
                            config=BotoConfig(retries={'max_attempts': 3})
                        )
                        sid = recording.session_id
                        uid = recording.user_id

                        s3_prefix = f"users/{uid}/sessions/{sid}"

                        # Only upload session JSON (audio recording moved to client-side)
                        files_to_upload = [
                            (str(session_recorder.recordings_dir / f"{sid}_server_transcript.json"),
                             f"{s3_prefix}/{sid}_server_transcript.json")
                        ]

                        for file_path, s3_key in files_to_upload:
                            if os.path.exists(file_path):
                                logger.info(f"Uploading {os.path.basename(file_path)} to s3://{s3_bucket}/{s3_key}")
                                for attempt in range(3):
                                    try:
                                        s3_client.upload_file(
                                            file_path, s3_bucket, s3_key,
                                            ExtraArgs={'ContentType': 'application/json'}
                                        )
                                        break
                                    except Exception as upload_err:
                                        if attempt < 2:
                                            logger.warning(f"S3 upload attempt {attempt + 1} failed: {upload_err}, retrying...")
                                            await asyncio.sleep(1)
                                            # Create fresh client for retry
                                            s3_client = boto3.client(
                                                's3',
                                                config=BotoConfig(retries={'max_attempts': 3})
                                            )
                                        else:
                                            raise

                                try:
                                    os.remove(file_path)
                                    logger.debug(f"Cleaned up local file: {file_path}")
                                except Exception as e:
                                    logger.warning(f"Could not delete local file {file_path}: {e}")

                        logger.info(f"✅ Session {sid} uploaded to S3")
                    except Exception as e:
                        logger.error(f"Failed to upload recording to S3: {e}")
                else:
                    logger.warning("S3_RECORDINGS_BUCKET not set, skipping S3 upload")
            except Exception as e:
                logger.error(f"Error stopping recording: {e}")

        try:
            if hasattr(websocket, 'client_state') and websocket.client_state.name not in ['DISCONNECTED', 'CLOSED']:
                await websocket.close()
        except Exception as e:
            logger.debug(f"Error closing websocket: {e}")

        logger.info("Connection closed")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Call Center Training Agent WebSocket Server")
    parser.add_argument("--debug", action="store_true", help="Enable debug mode")
    args = parser.parse_args()

    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)

    host = os.getenv("HOST", "0.0.0.0")  # nosec B104 - Required for Docker container networking
    port = int(os.getenv("PORT", "8080"))

    logger.info(f"Starting WebSocket server on {host}:{port}")

    try:
        uvicorn.run(app, host=host, port=port)
    except KeyboardInterrupt:
        logger.info("Server stopped by user")
    except Exception as e:
        logger.error(f"Server error: {e}")
        if args.debug:
            import traceback
            traceback.print_exc()