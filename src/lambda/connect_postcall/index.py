"""
Connect Post-Call Processing Lambda

Triggered by EventBridge when a Contact Lens analysis JSON file appears in
the Connect S3 bucket (S3 Object Created event).

1. Extracts S3 bucket/key from the EventBridge event
2. Parses contactId from the analysis filename
3. Looks up sessionId from DynamoDB (ContactIdIndex GSI)
4. Downloads Contact Lens analysis JSON (transcript + analytics)
5. Downloads Connect call recording (stereo WAV)
6. Extracts agent channel using ffmpeg
7. Converts Contact Lens transcript → SessionRecording format
8. Uploads session.json + agent audio to recordings S3 bucket
9. Invokes Scoring Lambda asynchronously
"""

import json
import logging
import os
import subprocess  # nosec B404
import tempfile
import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional
from urllib.parse import urlparse

import boto3
from botocore.config import Config as BotoConfig

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

# Environment
RECORDINGS_BUCKET = os.environ.get('RECORDINGS_BUCKET', '')
SESSIONS_TABLE = os.environ.get('SESSIONS_TABLE', '')
SCORING_FUNCTION_NAME = os.environ.get('SCORING_FUNCTION_NAME', '')
CONNECT_INSTANCE_ID = os.environ.get('CONNECT_INSTANCE_ID', '')
KMS_KEY_ID = os.environ.get('KMS_KEY_ID', '')
AWS_REGION = os.environ.get('AWS_REGION', 'us-west-2')

# Clients
s3_client = boto3.client('s3', config=BotoConfig(retries={'max_attempts': 3}))
dynamodb_resource = boto3.resource('dynamodb', region_name=AWS_REGION)
lambda_client = boto3.client('lambda', region_name=AWS_REGION)
connect_client = boto3.client('connect', region_name=AWS_REGION)


def lookup_session_by_contact_id(contact_id: str) -> Optional[Dict]:
    """Look up session record from DynamoDB using ContactIdIndex GSI."""
    table = dynamodb_resource.Table(SESSIONS_TABLE)
    response = table.query(
        IndexName='ContactIdIndex',
        KeyConditionExpression='contactId = :cid',
        ExpressionAttributeValues={':cid': contact_id},
        Limit=1,
    )
    items = response.get('Items', [])
    if not items:
        return None
    return items[0]


def download_contact_lens_analysis(bucket: str, key: str, temp_dir: str) -> Dict:
    """Download and parse Contact Lens analysis JSON from S3."""
    local_path = os.path.join(temp_dir, 'contact_lens_analysis.json')
    logger.info(f'Downloading Contact Lens analysis: s3://{bucket}/{key}')
    s3_client.download_file(bucket, key, local_path)

    with open(local_path, 'r', encoding='utf-8') as f:
        return json.load(f)


def find_and_download_recording(contact_id: str, temp_dir: str) -> Optional[str]:
    """Find and download the call recording from Connect's S3 storage.

    Connect stores recordings at a path like:
    connect/{instance-alias}/CallRecordings/{year}/{month}/{day}/{contact_id}_{timestamp}.wav

    We search for the contact_id in the recording path.
    """
    # Use Connect API to describe the contact and get recording info
    try:
        response = connect_client.describe_contact(
            InstanceId=CONNECT_INSTANCE_ID,
            ContactId=contact_id,
        )
        recording = response.get('Contact', {}).get('Recording', {})
        if recording.get('Location'):
            # Recording location is an S3 URI
            parsed = urlparse(recording['Location'])
            bucket = parsed.netloc
            key = parsed.path.lstrip('/')
            local_path = os.path.join(temp_dir, f'{contact_id}_recording.wav')
            logger.info(f'Downloading recording: s3://{bucket}/{key}')
            s3_client.download_file(bucket, key, local_path)
            return local_path
    except Exception as e:
        logger.warning(f'Failed to get recording via DescribeContact: {e}')

    # Fallback: scan the Connect recordings bucket for the contact_id
    connect_recordings_bucket = os.environ.get('CONNECT_RECORDINGS_BUCKET', '')
    if not connect_recordings_bucket:
        logger.error('CONNECT_RECORDINGS_BUCKET not configured')
        return None

    try:
        paginator = s3_client.get_paginator('list_objects_v2')
        for page in paginator.paginate(
            Bucket=connect_recordings_bucket,
            Prefix='connect/',
            MaxKeys=1000,
        ):
            for obj in page.get('Contents', []):
                if contact_id in obj['Key'] and obj['Key'].endswith('.wav'):
                    local_path = os.path.join(temp_dir, f'{contact_id}_recording.wav')
                    logger.info(f'Found recording: s3://{connect_recordings_bucket}/{obj["Key"]}')
                    s3_client.download_file(connect_recordings_bucket, obj['Key'], local_path)
                    return local_path
    except Exception as e:
        logger.error(f'Failed to find recording in S3: {e}')

    return None


def extract_agent_channel(stereo_wav_path: str, temp_dir: str) -> str:
    """Extract the agent (right) channel from a stereo Connect recording.

    Connect stereo layout for agent interactions:
      - Left channel (0)  = customer
      - Right channel (1) = agent (trainee)
    Output: mono WAV at 24000Hz matching audio empathy Lambda expectations.
    """
    agent_wav_path = os.path.join(temp_dir, 'agent_audio.wav')
    result = subprocess.run(  # nosec B603 B607
        [
            '/usr/local/bin/ffmpeg', '-i', stereo_wav_path,
            '-af', 'pan=mono|c0=c1',  # Right channel (agent) as mono
            '-ar', '24000',            # Match empathy Lambda sample rate
            '-y', agent_wav_path,
        ],
        capture_output=True, text=True, timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError(f'ffmpeg channel extraction failed: {result.stderr[:500]}')

    logger.info(f'Extracted agent channel: {agent_wav_path}')
    return agent_wav_path


def convert_to_session_recording(
    cl_data: Dict,
    session: Dict,
    start_time: str,
    end_time: str,
) -> Dict:
    """Convert Contact Lens analysis to SessionRecording dict format."""
    transcript_entries = cl_data.get('Transcript', [])
    contact_id = cl_data.get('CustomerMetadata', {}).get('ContactId', '')

    turns = []
    for entry in transcript_entries:
        participant = entry.get('ParticipantId', '')
        # Connect IVR: CUSTOMER = trainee (outbound caller), SYSTEM = Lex bot (AI customer)
        speaker = 'customer' if participant == 'SYSTEM' else 'agent'

        begin_ms = entry.get('BeginOffsetMillis', 0)
        end_ms = entry.get('EndOffsetMillis', 0)

        turns.append({
            'timestamp': start_time,
            'speaker': speaker,
            'text': entry.get('Content', ''),
            'audio_start_time': begin_ms / 1000.0,
            'audio_duration': (end_ms - begin_ms) / 1000.0,
        })

    conv_chars = cl_data.get('ConversationCharacteristics', {})
    total_duration_ms = conv_chars.get('TotalConversationDurationMillis', 0)

    return {
        'session_id': session.get('sessionId', ''),
        'scenario_id': session.get('scenarioId', ''),
        'scenario_name': session.get('scenarioName', ''),
        'start_time': start_time,
        'end_time': end_time or datetime.now(timezone.utc).isoformat(),
        'duration_seconds': total_duration_ms / 1000.0,
        'customer_mood': session.get('customerMood', 'neutral'),
        'difficulty': session.get('difficulty', 'intermediate'),
        'transcript': turns,
        'metadata': {
            'source': 'amazon_connect_contact_lens',
            'contact_id': contact_id,
            'contact_lens_sentiment': conv_chars.get('Sentiment', {}),
            'contact_lens_interruptions': conv_chars.get('Interruptions', {}),
            'contact_lens_non_talk_time': conv_chars.get('NonTalkTime', {}),
            'contact_lens_talk_speed': conv_chars.get('TalkSpeed', {}),
        },
    }


def upload_session_json(session_id: str, user_id: str, session_data: Dict):
    """Upload session JSON to the recordings S3 bucket."""
    prefix = f'users/{user_id}/sessions/{session_id}'
    key = f'{prefix}/{session_id}_server_transcript.json'

    put_kwargs = {
        'Bucket': RECORDINGS_BUCKET,
        'Key': key,
        'Body': json.dumps(session_data, indent=2, ensure_ascii=False),
        'ContentType': 'application/json',
    }
    if KMS_KEY_ID:
        put_kwargs['ServerSideEncryption'] = 'aws:kms'
        put_kwargs['SSEKMSKeyId'] = KMS_KEY_ID

    s3_client.put_object(**put_kwargs)
    logger.info(f'Uploaded session JSON: s3://{RECORDINGS_BUCKET}/{key}')


def upload_agent_audio(session_id: str, user_id: str, audio_path: str):
    """Upload agent-only audio WAV to the recordings S3 bucket."""
    prefix = f'users/{user_id}/sessions/{session_id}'
    key = f'{prefix}/{session_id}_agent_audio.wav'

    extra_args = {}
    if KMS_KEY_ID:
        extra_args['ServerSideEncryption'] = 'aws:kms'
        extra_args['SSEKMSKeyId'] = KMS_KEY_ID

    s3_client.upload_file(audio_path, RECORDINGS_BUCKET, key, ExtraArgs=extra_args or None)
    logger.info(f'Uploaded agent audio: s3://{RECORDINGS_BUCKET}/{key}')


def upload_stereo_audio(session_id: str, user_id: str, audio_path: str):
    """Upload original stereo recording as fallback audio."""
    prefix = f'users/{user_id}/sessions/{session_id}'
    key = f'{prefix}/{session_id}_audio.wav'

    extra_args = {}
    if KMS_KEY_ID:
        extra_args['ServerSideEncryption'] = 'aws:kms'
        extra_args['SSEKMSKeyId'] = KMS_KEY_ID

    s3_client.upload_file(audio_path, RECORDINGS_BUCKET, key, ExtraArgs=extra_args or None)
    logger.info(f'Uploaded stereo audio: s3://{RECORDINGS_BUCKET}/{key}')


def invoke_scoring(session_id: str, user_id: str):
    """Invoke the scoring Lambda asynchronously."""
    if not SCORING_FUNCTION_NAME:
        logger.warning('SCORING_FUNCTION_NAME not set, skipping scoring')
        return

    lambda_client.invoke(
        FunctionName=SCORING_FUNCTION_NAME,
        InvocationType='Event',
        Payload=json.dumps({
            'asyncScoring': True,
            'sessionId': session_id,
            'userId': user_id,
        }),
    )
    logger.info(f'Invoked scoring Lambda for session {session_id}')


def update_session_status(user_id: str, session_id: str, status: str):
    """Update session status in DynamoDB."""
    table = dynamodb_resource.Table(SESSIONS_TABLE)
    table.update_item(
        Key={'userId': user_id, 'sessionId': session_id},
        UpdateExpression='SET #st = :st',
        ExpressionAttributeNames={'#st': 'status'},
        ExpressionAttributeValues={':st': status},
    )


def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """EventBridge handler for S3 Object Created (Contact Lens analysis JSON)."""
    logger.info(f'Event: {json.dumps(event, default=str)[:1000]}')

    detail = event.get('detail', {})
    bucket = detail.get('bucket', {}).get('name', '')
    key = detail.get('object', {}).get('key', '')

    if not bucket or not key:
        logger.error(f'Missing bucket or key in event: bucket={bucket}, key={key}')
        return {'status': 'error', 'message': 'Missing bucket/key'}

    # Skip non-JSON files (EventBridge prefix filter may match other file types)
    if not key.endswith('.json'):
        logger.info(f'Skipping non-JSON file: {key}')
        return {'status': 'skipped', 'message': 'Not a JSON file'}

    # Extract contactId from filename: {contactId}_analysis_{timestamp}.json
    filename = key.split('/')[-1]
    contact_id = filename.split('_analysis_')[0] if '_analysis_' in filename else ''

    if not contact_id:
        logger.error(f'Could not extract contactId from key: {key}')
        return {'status': 'error', 'message': 'No contactId in filename'}

    logger.info(f'Processing Contact Lens analysis for contact {contact_id}')

    # 1. Look up session from DynamoDB (retry for GSI eventual consistency)
    session = None
    for attempt in range(3):
        session = lookup_session_by_contact_id(contact_id)
        if session:
            break
        logger.info(f'No session found for contactId {contact_id}, retry {attempt + 1}/3')
        time.sleep(20)

    if not session:
        logger.warning(f'No session found for contactId {contact_id} after retries, skipping')
        return {'status': 'skipped', 'message': 'No session found'}

    session_id = session['sessionId']
    user_id = session.get('userId', 'connect')
    logger.info(f'Processing post-call for session {session_id} (contact {contact_id})')

    with tempfile.TemporaryDirectory() as temp_dir:
        # 2. Download Contact Lens analysis
        cl_data = download_contact_lens_analysis(bucket, key, temp_dir)
        logger.info(f'Contact Lens transcript: {len(cl_data.get("Transcript", []))} entries')

        # 3. Download Connect call recording
        recording_path = find_and_download_recording(contact_id, temp_dir)

        # 4. Extract agent channel from stereo recording
        agent_audio_path = None
        if recording_path:
            try:
                agent_audio_path = extract_agent_channel(recording_path, temp_dir)
            except Exception as e:
                logger.warning(f'Failed to extract agent channel (non-fatal): {e}')

        # 5. Convert Contact Lens → SessionRecording format
        start_time = session.get('startTime', datetime.now(timezone.utc).isoformat())
        end_time = session.get('endTime', '')
        session_data = convert_to_session_recording(cl_data, session, start_time, end_time)

        # 6. Upload to recordings bucket
        upload_session_json(session_id, user_id, session_data)

        if agent_audio_path:
            upload_agent_audio(session_id, user_id, agent_audio_path)

        # Always upload original recording (archive + fallback for
        # playback/empathy when agent channel extraction fails)
        if recording_path:
            upload_stereo_audio(session_id, user_id, recording_path)

        # 7. Invoke scoring Lambda
        update_session_status(user_id, session_id, 'scoring')
        invoke_scoring(session_id, user_id)

    return {
        'status': 'success',
        'sessionId': session_id,
        'contactId': contact_id,
        'hasRecording': recording_path is not None,
        'hasAgentAudio': agent_audio_path is not None,
    }
