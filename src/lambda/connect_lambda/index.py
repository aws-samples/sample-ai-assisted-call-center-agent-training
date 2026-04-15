"""
Connect Training Admin API Lambda

HTTP API (via API Gateway) for the Connect admin UI:
- GET  /scenarios            — list training scenarios from DynamoDB
- GET  /agents               — list Connect agents
- GET  /calls                — list recent call sessions from DynamoDB
- GET  /calls/{sessionId}    — get session detail (scorecard + transcript)
- GET  /calls/{sessionId}/audio — get presigned URL for audio playback
- POST /start-call           — initiate outbound training call via Connect

Scenarios are loaded from DynamoDB at runtime.
"""

import base64
import json
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import boto3
from botocore.config import Config as BotoConfig

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

AWS_REGION = os.environ.get('AWS_REGION_NAME', os.environ.get('AWS_REGION', 'us-west-2'))
RECORDINGS_BUCKET = os.environ.get('RECORDINGS_BUCKET', '')
CONNECT_INSTANCE_ID = os.environ.get('CONNECT_INSTANCE_ID', '')
CONNECT_INSTANCE_ARN = os.environ.get('CONNECT_INSTANCE_ARN', '')
CONTACT_FLOW_ID = os.environ.get('CONTACT_FLOW_ID', '')
DESTINATION_PHONE = os.environ.get('DESTINATION_PHONE', '')
QUEUE_ARN = os.environ.get('QUEUE_ARN', '')
SESSIONS_TABLE = os.environ.get('SESSIONS_TABLE', '')

# ---------------------------------------------------------------------------
# Queue ID — discovered at runtime if QUEUE_ARN env var is not set
# ---------------------------------------------------------------------------
_queue_id_cache: Optional[str] = None


def _get_queue_id() -> str:
    """Get the queue ID for outbound calls. Uses QUEUE_ARN env var if set,
    otherwise discovers the first STANDARD queue at runtime. Result is cached."""
    global _queue_id_cache
    if _queue_id_cache:
        return _queue_id_cache
    if QUEUE_ARN:
        _queue_id_cache = QUEUE_ARN.split('/')[-1]
        return _queue_id_cache
    try:
        client = boto3.client('connect', region_name=AWS_REGION)
        paginator = client.get_paginator('list_queues')
        for page in paginator.paginate(InstanceId=CONNECT_INSTANCE_ID, QueueTypes=['STANDARD']):
            for q in page.get('QueueSummaryList', []):
                _queue_id_cache = q['Id']
                logger.info(f'Resolved queue "{q.get("Name")}" → {q["Id"]}')
                return q['Id']
    except Exception as e:
        logger.error(f'Failed to look up queue: {e}')
    return ''


# ---------------------------------------------------------------------------
# Scenario loader — reads from DynamoDB
# ---------------------------------------------------------------------------
SCENARIOS_TABLE = os.environ.get('SCENARIOS_TABLE', '')


def _load_scenarios() -> Dict[str, dict]:
    """Load scenarios from DynamoDB (fresh read each invocation)."""
    if not SCENARIOS_TABLE:
        logger.error('SCENARIOS_TABLE env var is not set — cannot load scenarios')
        return {}

    try:
        dynamodb = boto3.resource('dynamodb', region_name=AWS_REGION)
        table = dynamodb.Table(SCENARIOS_TABLE)
        response = table.scan()
        items = response.get('Items', [])
        while 'LastEvaluatedKey' in response:
            response = table.scan(ExclusiveStartKey=response['LastEvaluatedKey'])
            items.extend(response.get('Items', []))

        scenarios = {}
        for item in items:
            sid = item.get('scenarioId') or item.get('id', '')
            if sid:
                item['id'] = sid
                scenarios[sid] = json.loads(json.dumps(item, default=str))
        logger.info(f'Loaded {len(scenarios)} scenarios from DynamoDB table {SCENARIOS_TABLE}')
        return scenarios
    except Exception as e:
        logger.error(f'Failed to load scenarios from DynamoDB: {e}')
        return {}


# ===================================================================
# HTTP Mode — Admin API (API Gateway)
# ===================================================================

def build_response(status_code: int, body: Any) -> Dict:
    """Build HTTP response. CORS headers are handled by the Lambda function URL
    configuration — do NOT add them here or they will duplicate."""
    return {
        'statusCode': status_code,
        'headers': {
            'Content-Type': 'application/json',
        },
        'body': json.dumps(body, default=str),
    }


def handle_list_scenarios() -> Dict:
    scenarios = _load_scenarios()
    items = []
    for s in scenarios.values():
        item = {
            'id': s.get('id'),
            'name': s.get('name'),
            'context': s.get('context', '')[:200],
            'key_challenges': s.get('key_challenges', []),
            'caller_gender': s.get('caller_gender', ''),
        }
        if s.get('characters'):
            item['characters'] = s['characters']
        items.append(item)
    return build_response(200, {'scenarios': items, 'count': len(items)})


def handle_list_agents() -> Dict:
    try:
        client = boto3.client('connect', region_name=AWS_REGION)
        agents = []
        paginator = client.get_paginator('list_users')
        for page in paginator.paginate(InstanceId=CONNECT_INSTANCE_ID):
            for user in page.get('UserSummaryList', []):
                agents.append({
                    'id': user.get('Id'),
                    'username': user.get('Username'),
                    'arn': user.get('Arn'),
                })
        return build_response(200, {'agents': agents, 'count': len(agents)})
    except Exception as e:
        logger.error(f'Error listing agents: {e}', exc_info=True)
        return build_response(500, {'error': str(e)})


def handle_list_calls() -> Dict:
    """List recent Connect training sessions from DynamoDB."""
    if not SESSIONS_TABLE:
        return build_response(500, {'error': 'SESSIONS_TABLE not configured'})

    try:
        dynamodb = boto3.resource('dynamodb', region_name=AWS_REGION)
        table = dynamodb.Table(SESSIONS_TABLE)

        response = table.query(
            IndexName='TimestampIndex',
            KeyConditionExpression='gsiPk = :pk',
            ExpressionAttributeValues={':pk': 'SESSION'},
            ScanIndexForward=False,
            Limit=50,
        )

        calls = []
        for item in response.get('Items', []):
            calls.append({
                'session_id': item.get('sessionId'),
                'contact_id': item.get('contactId'),
                'scenario_id': item.get('scenarioId'),
                'scenario_name': item.get('scenarioName', ''),
                'start_time': item.get('startTime'),
                'end_time': item.get('endTime'),
                'status': item.get('status'),
                'score': float(item['score']) if 'score' in item else None,
                'grade': item.get('grade'),
                'passed': item.get('passed'),
                'source': item.get('source', 'amazon_connect'),
            })

        return build_response(200, {'calls': calls, 'count': len(calls)})
    except Exception as e:
        logger.error(f'Error listing calls: {e}', exc_info=True)
        return build_response(500, {'error': str(e)})


def handle_get_session_detail(session_id: str) -> Dict:
    """Get full session detail including scorecard and transcript."""
    if not SESSIONS_TABLE:
        return build_response(500, {'error': 'SESSIONS_TABLE not configured'})

    try:
        dynamodb = boto3.resource('dynamodb', region_name=AWS_REGION)
        table = dynamodb.Table(SESSIONS_TABLE)
        response = table.get_item(Key={'userId': 'connect', 'sessionId': session_id})
        session = response.get('Item')
        if not session:
            return build_response(404, {'error': 'Session not found'})

        result = {
            'session': json.loads(json.dumps(session, default=str)),
            'scorecard': None,
            'transcript': None,
        }

        # Try to load scorecard from S3
        s3 = boto3.client('s3', config=BotoConfig(retries={'max_attempts': 3}))
        prefix = f'users/connect/sessions/{session_id}'
        scorecard_key = f'{prefix}/{session_id}_scorecard.json'
        try:
            body = s3.get_object(Bucket=RECORDINGS_BUCKET, Key=scorecard_key)['Body'].read()
            result['scorecard'] = json.loads(body)
        except Exception:  # nosec B110
            logger.debug('No scorecard found for session %s', session_id)

        # Try to load transcript from session JSON (Contact Lens quality)
        session_json_key = f'{prefix}/{session_id}_server_transcript.json'
        try:
            body = s3.get_object(Bucket=RECORDINGS_BUCKET, Key=session_json_key)['Body'].read()
            session_data = json.loads(body)
            result['transcript'] = session_data.get('transcript', [])
        except Exception:
            # Fall back to DynamoDB transcript (from Lex fulfillment)
            result['transcript'] = json.loads(json.dumps(session.get('transcript', []), default=str))

        # Enrich with client-side timing (accurate audio_duration for talk-over detection)
        client_key = f'{prefix}/{session_id}_client_transcript.json'
        try:
            client_body = s3.get_object(Bucket=RECORDINGS_BUCKET, Key=client_key)['Body'].read()
            client_turns = json.loads(client_body)
            server_turns = result['transcript'] or []
            for i, client_turn in enumerate(client_turns):
                if i >= len(server_turns):
                    break
                server_turns[i]['audio_start_time'] = client_turn.get('audio_start_time', server_turns[i].get('audio_start_time'))
                server_turns[i]['audio_duration'] = client_turn.get('audio_duration', server_turns[i].get('audio_duration'))
        except Exception:
            pass  # Fall back to server timing if client transcript unavailable

        return build_response(200, result)
    except Exception as e:
        logger.error(f'Error getting session detail: {e}', exc_info=True)
        return build_response(500, {'error': str(e)})


def handle_get_audio_url(session_id: str) -> Dict:
    """Get presigned URL for session audio playback."""
    prefix = f'users/connect/sessions/{session_id}'
    audio_keys = [
        f'{prefix}/{session_id}_audio.wav',
    ]

    s3 = boto3.client('s3', config=BotoConfig(
        retries={'max_attempts': 3},
        signature_version='s3v4',
    ))
    for key in audio_keys:
        try:
            s3.head_object(Bucket=RECORDINGS_BUCKET, Key=key)
            url = s3.generate_presigned_url(
                'get_object',
                Params={'Bucket': RECORDINGS_BUCKET, 'Key': key},
                ExpiresIn=3600,
            )
            return build_response(200, {'url': url, 'key': key})
        except Exception:  # nosec B112
            logger.debug('Audio key not found: %s', key)
            continue

    return build_response(404, {'error': 'Audio not found'})


def handle_start_call(body: Dict) -> Dict:
    scenario_id = body.get('scenario_id')
    voice_id = body.get('voice_id', 'matthew')
    # Capitalize voice ID for Connect Polly TTS (expects "Matthew", "Tiffany", etc.)
    voice_id = voice_id.capitalize()
    language_code = body.get('language_code', 'en-US')
    language_mode = body.get('language_mode', 'english')
    destination_phone = body.get('destination_phone', DESTINATION_PHONE)

    if not scenario_id:
        return build_response(400, {'error': 'scenario_id is required'})

    scenarios = _load_scenarios()
    scenario = scenarios.get(scenario_id)
    if not scenario:
        return build_response(404, {'error': f'Scenario not found: {scenario_id}'})

    if not CONTACT_FLOW_ID:
        logger.error('CONTACT_FLOW_ID not configured')
        return build_response(500, {'error': 'Contact flow ID not configured'})

    queue_id = _get_queue_id()
    if not queue_id:
        logger.error(f'No STANDARD queue found in instance {CONNECT_INSTANCE_ID}')
        return build_response(500, {'error': 'No queue found in Connect instance'})

    session_id = str(uuid.uuid4())
    attributes = {
        'scenario_id': scenario_id,
        'scenario_name': scenario.get('name', ''),
        'voice_id': voice_id,
        'language_code': language_code,
        'language_mode': language_mode,
        'training_session_id': session_id,
        'voice_engine': "Generative",
        "voice_style": "None"
    }

    try:
        client = boto3.client('connect', region_name=AWS_REGION)
        resp = client.start_outbound_voice_contact(
            DestinationPhoneNumber=destination_phone,
            ContactFlowId=CONTACT_FLOW_ID,
            InstanceId=CONNECT_INSTANCE_ID,
            QueueId=queue_id,
            Attributes=attributes,
        )
        contact_id = resp.get('ContactId')
        logger.info(f'Started training call: contact={contact_id}, session={session_id}, dest={destination_phone}')

        # Create preliminary session record with contactId mapping.
        # This ensures the post-call Lambda can look up sessionId from contactId
        # even if the call disconnects before Lex fulfillment runs.
        if SESSIONS_TABLE:
            try:
                dynamodb = boto3.resource('dynamodb', region_name=AWS_REGION)
                sessions_table = dynamodb.Table(SESSIONS_TABLE)
                now = datetime.now(timezone.utc).isoformat()
                sessions_table.put_item(Item={
                    'userId': 'connect',
                    'sessionId': session_id,
                    'contactId': contact_id,
                    'gsiPk': 'SESSION',
                    'timestamp': now,
                    'scenarioId': scenario_id,
                    'scenarioName': scenario.get('name', ''),
                    'source': 'amazon_connect',
                    'status': 'initiated',
                    'startTime': now,
                })
                logger.info(f'Created session record: {session_id} (contactId={contact_id})')
            except Exception as e:
                logger.warning(f'Failed to create session record (non-fatal): {e}')

        return build_response(200, {
            'contact_id': contact_id,
            'session_id': session_id,
            'scenario': {'id': scenario_id, 'name': scenario.get('name', '')},
        })
    except Exception as e:
        logger.error(f'Error starting call: {e}', exc_info=True)
        return build_response(500, {'error': str(e)})


def handle_http(event: Dict) -> Dict:
    method = event.get('requestContext', {}).get('http', {}).get('method', 'GET')
    path = event.get('rawPath', '/')

    if method == 'OPTIONS':
        return build_response(200, {})

    if method == 'POST':
        body = {}
        if event.get('body'):
            body_str = event['body']
            if event.get('isBase64Encoded'):
                body_str = base64.b64decode(body_str).decode('utf-8')
            body = json.loads(body_str)
        if '/start-call' in path:
            return handle_start_call(body)
        return handle_start_call(body)

    if method == 'GET':
        if '/scenarios' in path:
            return handle_list_scenarios()
        if '/agents' in path:
            return handle_list_agents()

        # Session detail routes: /calls/{sessionId} and /calls/{sessionId}/audio
        path_params = event.get('pathParameters') or {}
        session_id = path_params.get('sessionId', '')
        if session_id:
            if path.endswith('/audio'):
                return handle_get_audio_url(session_id)
            return handle_get_session_detail(session_id)

        if '/calls' in path:
            return handle_list_calls()

        return build_response(200, {
            'service': 'connect-training',
            'endpoints': [
                'POST /start-call',
                'GET /scenarios',
                'GET /agents',
                'GET /calls',
                'GET /calls/{sessionId}',
                'GET /calls/{sessionId}/audio',
            ],
        })

    return build_response(405, {'error': f'Method not allowed: {method}'})


# ===================================================================
# Main handler
# ===================================================================

def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    logger.info(f'Lambda invoked: {json.dumps(event, default=str)[:500]}')

    # HTTP mode — API Gateway
    if 'requestContext' in event and 'http' in event.get('requestContext', {}):
        return handle_http(event)

    # Unknown invocation
    logger.warning(f'Unknown invocation type: {list(event.keys())}')
    return {'statusCode': 400, 'body': 'Unknown invocation type'}
