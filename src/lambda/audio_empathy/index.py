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

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

s3_client = boto3.client('s3')


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

    prefix = f"users/{user_id}/sessions/{session_id}"

    with tempfile.TemporaryDirectory() as temp_dir:
        # Download stereo webm and extract agent (right channel) as mono WAV
        stereo_webm_key = f"{prefix}/{session_id}_audio.webm"
        webm_path = os.path.join(temp_dir, f"{session_id}_audio.webm")
        wav_path = os.path.join(temp_dir, f"{session_id}_audio.wav")

        try:
            logger.info("Downloading stereo webm: %s", stereo_webm_key)
            s3_client.download_file(bucket, stereo_webm_key, webm_path)
        except s3_client.exceptions.ClientError:
            return {'score': 0.0, 'reason': 'Audio file not found in S3', 'features': {}}

        # Extract right channel (agent) as mono 24kHz WAV
        try:
            result = subprocess.run(  # nosec B603 B607
                ['/usr/local/bin/ffmpeg', '-i', webm_path,
                 '-af', 'pan=mono|c0=c1', '-ar', '24000', '-ac', '1', '-y', wav_path],
                capture_output=True, text=True, timeout=60,
            )
            if result.returncode != 0:
                logger.error("ffmpeg error: %s", result.stderr)
                return {'score': 0.0, 'reason': f'Audio conversion failed: {result.stderr[:200]}', 'features': {}}
        except subprocess.TimeoutExpired:
            return {'score': 0.0, 'reason': 'Audio conversion timed out', 'features': {}}

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
