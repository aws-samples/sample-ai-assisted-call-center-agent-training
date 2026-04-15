"""Session recorder for capturing training conversations"""
import json
import logging
import time
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Optional, Any
from dataclasses import asdict

logger = logging.getLogger(__name__)

# Import data classes from session_types (no audio dependencies)
from .session_types import ConversationTurn, SessionRecording


class SessionRecorder:
    """Records training sessions including transcript.

    Audio recording is handled client-side (browser MediaRecorder → S3).
    This recorder captures the transcript and session metadata, saving
    them as JSON for later evaluation.
    """

    def __init__(self, recordings_dir: str = "recordings"):
        self.recordings_dir = Path(recordings_dir)
        self.recordings_dir.mkdir(exist_ok=True)

        self.session_id: Optional[str] = None
        self.start_time: Optional[datetime] = None
        self._start_time_mono: Optional[float] = None
        self.transcript: List[ConversationTurn] = []
        self.is_recording = False
        self.token_usage: Optional[Dict[str, Any]] = None

    def start_recording(self, scenario_id: str, scenario_name: str,
                       customer_mood: str, difficulty: str, session_id: str = None,
                       user_id: str = "", user_name: str = "") -> str:
        """Start recording a new session."""
        self.session_id = session_id or datetime.now().strftime("%Y%m%d_%H%M%S")
        self.start_time = datetime.now()
        self._start_time_mono = time.monotonic()
        self.transcript = []
        self.is_recording = True
        self.user_id = user_id
        self.user_name = user_name

        self.metadata = {
            "scenario_id": scenario_id,
            "scenario_name": scenario_name,
            "customer_mood": customer_mood,
            "difficulty": difficulty,
            "user_id": user_id,
            "user_name": user_name,
        }

        logger.info("Started recording session: %s", self.session_id)
        return self.session_id

    def add_transcript_turn(self, speaker: str, text: str,
                           audio_start_time: float,
                           audio_duration: float) -> None:
        """Add a conversation turn to the transcript."""
        if not self.is_recording:
            return

        turn = ConversationTurn(
            timestamp=datetime.now().isoformat(),
            speaker=speaker,
            text=text,
            audio_start_time=audio_start_time,
            audio_duration=audio_duration
        )
        self.transcript.append(turn)

    def stop_recording(self) -> SessionRecording:
        """Stop recording and save the session."""
        if not self.is_recording:
            raise RuntimeError("No recording in progress")

        end_time = datetime.now()
        duration = (end_time - self.start_time).total_seconds()

        # Create session recording
        recording = SessionRecording(
            session_id=self.session_id,
            scenario_id=self.metadata["scenario_id"],
            scenario_name=self.metadata["scenario_name"],
            start_time=self.start_time.isoformat(),
            end_time=end_time.isoformat(),
            duration_seconds=duration,
            customer_mood=self.metadata["customer_mood"],
            difficulty=self.metadata["difficulty"],
            transcript=self.transcript,
            metadata=self.metadata,
            user_id=self.user_id,
            user_name=self.user_name,
            token_usage=self.token_usage,
        )

        # Save transcript and metadata as JSON
        json_path = self.recordings_dir / f"{self.session_id}_server_transcript.json"
        self._save_json(recording, json_path)

        logger.info("Stopped recording. Saved to %s", self.recordings_dir)
        logger.info("Transcript: %s_server_transcript.json", self.session_id)
        logger.info("Duration: %.2f seconds", duration)
        logger.info("Turns: %d", len(self.transcript))

        self.is_recording = False
        return recording

    def _save_json(self, recording: SessionRecording, path: Path) -> None:
        """Save session recording as JSON"""
        data = asdict(recording)

        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

    def load_recording(self, session_id: str) -> Optional[SessionRecording]:
        """Load a previously recorded session."""
        json_path = self.recordings_dir / f"{session_id}_server_transcript.json"

        if not json_path.exists():
            return None

        with open(json_path, 'r', encoding='utf-8') as f:
            data = json.load(f)

        transcript = [
            ConversationTurn(**turn) for turn in data['transcript']
        ]
        data['transcript'] = transcript

        return SessionRecording(**data)

    def list_recordings(self) -> List[Dict[str, Any]]:
        """List all available recordings"""
        recordings = []

        for json_file in self.recordings_dir.glob("*_server_transcript.json"):
            with open(json_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
                recordings.append({
                    "session_id": data["session_id"],
                    "scenario_name": data["scenario_name"],
                    "start_time": data["start_time"],
                    "duration_seconds": data["duration_seconds"],
                    "customer_mood": data["customer_mood"],
                    "difficulty": data["difficulty"],
                    "turns": len(data["transcript"])
                })

        recordings.sort(key=lambda x: x["start_time"], reverse=True)
        return recordings

    async def upload_to_s3(self, bucket_name: str, session_id: str, kms_key_id: Optional[str] = None) -> Dict[str, str]:
        """Upload recording files to S3."""
        import boto3

        s3_client = boto3.client('s3')

        json_file = self.recordings_dir / f"{session_id}_server_transcript.json"

        s3_urls = {}
        upload_args = {}

        if kms_key_id:
            upload_args['ServerSideEncryption'] = 'aws:kms'
            upload_args['SSEKMSKeyId'] = kms_key_id

        if json_file.exists():
            s3_key = f"recordings/{session_id}_server_transcript.json"
            s3_client.upload_file(
                str(json_file), bucket_name, s3_key,
                ExtraArgs={**upload_args, 'ContentType': 'application/json'}
            )
            s3_urls['metadata'] = f"s3://{bucket_name}/{s3_key}"
            logger.info("Uploaded metadata to %s", s3_urls['metadata'])

        return s3_urls
