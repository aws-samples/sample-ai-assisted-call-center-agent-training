"""
Lambda function for audio-based empathy analysis.

Receives a sessionId/userId, downloads the audio file from S3,
converts webm to wav, and runs AudioEmpathyEvaluator.

Invoked synchronously by the scoring Lambda. Returns empathy results directly.
"""

import json
import logging
import os
import subprocess  # nosec B404
import tempfile
import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

s3_client = boto3.client('s3')


def find_audio_file(s3_client, bucket, prefix, session_id):
    """Try multiple audio file formats, return first found key.

    Args:
        s3_client: Boto3 S3 client
        bucket: S3 bucket name
        prefix: S3 key prefix (e.g., "users/connect/sessions/123")
        session_id: Session identifier

    Returns:
        tuple: (key, format) where format is 'webm' or 'wav', or (None, None) if not found
    """
    candidates = [
        (f"{prefix}/{session_id}_audio.webm", 'webm'),  # Web UI
        (f"{prefix}/{session_id}_audio.wav", 'wav'),    # Connect stereo
        (f"{prefix}/{session_id}_agent_audio.wav", 'wav')  # Connect agent-only
    ]

    for key, file_format in candidates:
        try:
            response = s3_client.head_object(Bucket=bucket, Key=key)
            logger.info("Found audio file: %s (size: %d bytes, format: %s)",
                       key, response['ContentLength'], file_format)
            return key, file_format
        except ClientError as e:
            error_code = e.response['Error']['Code']
            if error_code == '404' or error_code == 'NoSuchKey':
                logger.debug("Audio key not found: %s", key)
                continue
            else:
                # Permission error or other S3 issue
                logger.error("S3 error checking key %s: %s", key, str(e))
                raise

    logger.warning("No audio file found. Checked: %s", [c[0] for c in candidates])
    return None, None


def lambda_handler(event, context):
    """Analyze audio empathy for a training session.

    Args:
        event: {sessionId, userId, bucket}

    Returns:
        {score, reason, features} or {score: 0, reason: "..."}
    """
    session_id = event.get('sessionId', '')
    user_id = event.get('userId', '')
    bucket = event.get('bucket', '')

    if not session_id or not bucket:
        return {'score': 0.0, 'reason': 'Missing sessionId or bucket', 'features': {}}

    # Handle both path patterns: web training and Amazon Connect
    if user_id == "connect" or not user_id:
        prefix = f"users/connect/sessions/{session_id}"
    else:
        prefix = f"users/{user_id}/sessions/{session_id}"

    logger.info("Processing audio empathy for session %s (prefix: %s)", session_id, prefix)

    with tempfile.TemporaryDirectory() as temp_dir:
        # Find audio file (try multiple formats)
        audio_key, audio_format = find_audio_file(s3_client, bucket, prefix, session_id)

        if not audio_key:
            return {
                'score': 0.0,
                'reason': 'No audio recording available for this session (checked .webm, .wav, agent-only)',
                'features': {}
            }

        # Download audio file
        source_audio_path = os.path.join(temp_dir, f"{session_id}_source.{audio_format}")
        wav_path = os.path.join(temp_dir, f"{session_id}_audio.wav")

        try:
            logger.info("Downloading audio: %s", audio_key)
            s3_client.download_file(bucket, audio_key, source_audio_path)
        except ClientError as e:
            error_msg = str(e)
            logger.error("Failed to download audio file %s: %s", audio_key, error_msg)
            return {
                'score': 0.0,
                'reason': f'Audio file download failed: {error_msg[:200]}',
                'features': {}
            }

        # Extract agent audio as mono 24kHz WAV
        # Strategy: Try to extract right channel (agent) from stereo, fall back to full mix if mono
        # ffmpeg -af "pan=mono|c0=c1" will use right channel if stereo, or fail gracefully
        try:
            # First attempt: Extract right channel (agent) - works for stereo files
            result = subprocess.run(  # nosec B603 B607
                ['/usr/local/bin/ffmpeg', '-i', source_audio_path,
                 '-af', 'pan=mono|c0=c1', '-ar', '24000', '-ac', '1', '-y', wav_path],
                capture_output=True, text=True, timeout=60,
            )

            if result.returncode != 0:
                # If right channel extraction failed (likely mono file), just convert to mono 24kHz
                logger.info("Right channel extraction failed, converting to mono: %s", result.stderr[:100])
                result = subprocess.run(  # nosec B603 B607
                    ['/usr/local/bin/ffmpeg', '-i', source_audio_path,
                     '-ar', '24000', '-ac', '1', '-y', wav_path],
                    capture_output=True, text=True, timeout=60,
                )

                if result.returncode != 0:
                    logger.error("ffmpeg error: %s", result.stderr)
                    return {
                        'score': 0.0,
                        'reason': f'Audio conversion failed: {result.stderr[:200]}',
                        'features': {}
                    }

        except subprocess.TimeoutExpired:
            return {'score': 0.0, 'reason': 'Audio conversion timed out', 'features': {}}
        except Exception as e:
            logger.error("Audio processing error: %s", str(e))
            return {
                'score': 0.0,
                'reason': f'Audio processing error: {str(e)[:200]}',
                'features': {}
            }

        # Download session JSON for transcript data
        json_key = f"{prefix}/{session_id}_server_transcript.json"
        json_path = os.path.join(temp_dir, f"{session_id}_server_transcript.json")

        try:
            logger.info("Downloading session: %s", json_key)
            s3_client.download_file(bucket, json_key, json_path)
        except Exception as e:
            return {'score': 0.0, 'reason': f'Session JSON not found: {e}', 'features': {}}

        # Load session recording
        from src.recording.session_types import SessionRecording, ConversationTurn

        with open(json_path, 'r', encoding='utf-8') as f:
            data = json.load(f)

        transcript = [ConversationTurn(**turn) for turn in data['transcript']]
        data['transcript'] = transcript
        session_recording = SessionRecording(**data)
        session_recording.audio_file = wav_path


        # Run empathy analysis
        from src.evaluators.audio_empathy_evaluator import AudioEmpathyEvaluator

        evaluator = AudioEmpathyEvaluator(sample_rate=24000)
        result = evaluator.evaluate(session_recording)

        logger.info("Empathy score: %s", result.get('score', 0))
        return result
