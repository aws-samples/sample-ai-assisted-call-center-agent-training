"""
Admin Lambda function for:
- Listing trainees, sessions, scorecards, transcripts, audio/screen recording URLs
- Scenario CRUD (DynamoDB)
- Per-scenario evaluation criteria configuration (DynamoDB)

All session data lives under: users/{userId}/sessions/{sessionId}/

Invoked via API Gateway v2 (HTTP API) with JWT authorizer.
Routes are mapped to handler functions via method + path matching.
"""

import json
import logging
import os
import re
import boto3
from botocore.config import Config
from datetime import datetime
from decimal import Decimal

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

s3_client = boto3.client('s3', config=Config(signature_version='s3v4'))
bedrock_client = boto3.client('bedrock-runtime')
dynamodb = boto3.resource('dynamodb')
BUCKET = os.environ.get('RECORDINGS_BUCKET', '')
SCENARIOS_TABLE = os.environ.get('SCENARIOS_TABLE', '')
CRITERIA_CONFIG_TABLE = os.environ.get('CRITERIA_CONFIG_TABLE', '')
SESSIONS_TABLE = os.environ.get('SESSIONS_TABLE', '')
BEDROCK_MODEL_ID = os.environ.get('BEDROCK_MODEL_ID', 'us.anthropic.claude-sonnet-4-6')


# ============================================================================
# CRITERIA RUBRIC — loaded from rubric.json (bundled at deploy time from
# rubrics/default.json).  Single source of truth for both scoring and admin UI.
# ============================================================================
def _load_rubric_for_admin() -> dict:
    """Load rubric JSON and format for admin UI (camelCase keys)."""
    rubric_path = os.path.join(os.path.dirname(__file__), 'rubric.json')
    with open(rubric_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    sections = data.get('sections', data)
    # Convert to admin UI format: max_points → maxPoints
    formatted = {}
    for section_id, section in sections.items():
        formatted[section_id] = {
            'name': section['name'],
            'description': section['description'],
            'criteria': {
                cid: {
                    'description': c['description'],
                    'criticality': c['criticality'],
                    'maxPoints': c['max_points'],
                }
                for cid, c in section['criteria'].items()
            }
        }
    return formatted


CRITERIA_RUBRIC = _load_rubric_for_admin()


def _json_serial(obj):
    """JSON serializer for objects not serializable by default."""
    if isinstance(obj, (datetime, Decimal)):
        if isinstance(obj, Decimal):
            return float(obj) if obj % 1 else int(obj)
        return obj.isoformat()
    raise TypeError(f"Type {type(obj)} not serializable")


def _http_response(status_code, body):
    """Return an API Gateway v2 proxy response."""
    return {
        'statusCode': status_code,
        'headers': {'Content-Type': 'application/json'},
        'body': json.dumps(body, default=_json_serial),
    }


def list_trainees():
    """
    List all trainees with summary info from DynamoDB Sessions table.
    Queries the TimestampIndex GSI and aggregates by userId.
    """
    if not SESSIONS_TABLE:
        return []

    table = dynamodb.Table(SESSIONS_TABLE)
    items = []
    kwargs = {
        'IndexName': 'TimestampIndex',
        'KeyConditionExpression': 'gsiPk = :pk',
        'ExpressionAttributeValues': {':pk': 'ALL'},
        'ScanIndexForward': False,
    }
    response = table.query(**kwargs)
    items.extend(response.get('Items', []))
    while 'LastEvaluatedKey' in response:
        kwargs['ExclusiveStartKey'] = response['LastEvaluatedKey']
        response = table.query(**kwargs)
        items.extend(response.get('Items', []))

    # Aggregate by userId
    trainee_map = {}
    for item in items:
        uid = item['userId']
        if uid not in trainee_map:
            trainee_map[uid] = {
                'userId': uid,
                'userName': item.get('userName', ''),
                'sessionCount': 0,
                'latestScore': None,
                'latestDate': None,
                'totalInputTokens': 0,
                'totalOutputTokens': 0,
            }
        trainee_map[uid]['sessionCount'] += 1
        # First item per user is the latest (GSI sorted desc by timestamp)
        if trainee_map[uid]['latestDate'] is None:
            trainee_map[uid]['latestScore'] = item.get('score')
            trainee_map[uid]['latestDate'] = item.get('timestamp')
        # Aggregate token usage
        token_usage = item.get('tokenUsage')
        if token_usage and isinstance(token_usage, dict):
            for component in token_usage.values():
                if isinstance(component, dict):
                    trainee_map[uid]['totalInputTokens'] += int(component.get('input_tokens', 0))
                    trainee_map[uid]['totalOutputTokens'] += int(component.get('output_tokens', 0))

    trainees = list(trainee_map.values())
    trainees.sort(key=lambda t: t.get('latestDate', ''), reverse=True)
    return trainees


def _list_user_sessions(user_id: str) -> list:
    """List all sessions for a user from DynamoDB."""
    if not SESSIONS_TABLE:
        return []

    table = dynamodb.Table(SESSIONS_TABLE)
    items = []
    kwargs = {
        'KeyConditionExpression': 'userId = :uid',
        'ExpressionAttributeValues': {':uid': user_id},
    }
    response = table.query(**kwargs)
    items.extend(response.get('Items', []))
    while 'LastEvaluatedKey' in response:
        kwargs['ExclusiveStartKey'] = response['LastEvaluatedKey']
        response = table.query(**kwargs)
        items.extend(response.get('Items', []))

    # Sort by timestamp (newest first) since sessionId sort key is UUID, not time-sortable
    items.sort(key=lambda s: s.get('timestamp', ''), reverse=True)

    sessions = []
    for item in items:
        sessions.append({
            'sessionId': item['sessionId'],
            'userId': item['userId'],
            'userName': item.get('userName', ''),
            'scenarioName': item.get('scenarioName', ''),
            'score': item.get('score'),
            'grade': item.get('grade'),
            'passed': item.get('passed'),
            'timestamp': item.get('timestamp', ''),
            'tokenUsage': item.get('tokenUsage'),
        })
    return sessions


def get_session_scorecard(user_id: str, session_id: str):
    """Read full scorecard JSON for a session. Returns None if not yet scored."""
    key = f'users/{user_id}/sessions/{session_id}/{session_id}_scorecard.json'
    try:
        response = s3_client.get_object(Bucket=BUCKET, Key=key)
        return json.loads(response['Body'].read().decode('utf-8'))
    except s3_client.exceptions.NoSuchKey:
        return None


def get_session_transcript(user_id: str, session_id: str):
    """Read session JSON (contains transcript and metadata). Returns None if not available."""
    key = f'users/{user_id}/sessions/{session_id}/{session_id}_server_transcript.json'
    try:
        response = s3_client.get_object(Bucket=BUCKET, Key=key)
        data = json.loads(response['Body'].read().decode('utf-8'))
    except s3_client.exceptions.NoSuchKey:
        return None

    # Enrich with client-side timing (accurate audio_start_time and audio_duration).
    # The server transcript records audio_duration as 0.0; the client transcript
    # has real measured values needed for talk-over detection in the admin UI.
    client_key = f'users/{user_id}/sessions/{session_id}/{session_id}_client_transcript.json'
    try:
        client_response = s3_client.get_object(Bucket=BUCKET, Key=client_key)
        client_turns = json.loads(client_response['Body'].read().decode('utf-8'))
        server_turns = data.get('transcript', [])
        for i, client_turn in enumerate(client_turns):
            if i >= len(server_turns):
                break
            server_turns[i]['audio_start_time'] = client_turn.get('audio_start_time', server_turns[i].get('audio_start_time'))
            server_turns[i]['audio_duration'] = client_turn.get('audio_duration', server_turns[i].get('audio_duration'))
    except Exception:
        pass  # Fall back to server timing if client transcript unavailable

    return data


def get_audio_presigned_url(user_id: str, session_id: str) -> str:
    """Generate a presigned URL for the session audio file (WebM)."""
    key = f'users/{user_id}/sessions/{session_id}/{session_id}_audio.webm'
    url = s3_client.generate_presigned_url(
        'get_object',
        Params={'Bucket': BUCKET, 'Key': key},
        ExpiresIn=3600,
    )
    return url


def get_screen_recording_presigned_url(user_id: str, session_id: str) -> str:
    """Generate a presigned URL for the session screen recording (WebM video)."""
    key = f'users/{user_id}/sessions/{session_id}/{session_id}_screen_recording.webm'
    url = s3_client.generate_presigned_url(
        'get_object',
        Params={'Bucket': BUCKET, 'Key': key},
        ExpiresIn=3600,
    )
    return url


# ============================================================================
# ADMIN COMMENTS (DynamoDB)
# ============================================================================

def get_session_comment(user_id: str, session_id: str) -> dict:
    """Read admin comment from DynamoDB session record. Returns empty dict if no comment exists."""
    if not SESSIONS_TABLE:
        return {}
    table = dynamodb.Table(SESSIONS_TABLE)
    response = table.get_item(
        Key={'userId': user_id, 'sessionId': session_id},
        ProjectionExpression='adminComment',
    )
    item = response.get('Item', {})
    return item.get('adminComment', {})


def save_session_comment(user_id: str, session_id: str, text: str, author_id: str, author_email: str) -> dict:
    """Save admin comment to DynamoDB session record."""
    if not SESSIONS_TABLE:
        return {'error': 'Sessions table not configured'}

    now = datetime.now().isoformat()
    table = dynamodb.Table(SESSIONS_TABLE)

    # Preserve createdAt from existing comment
    existing = table.get_item(
        Key={'userId': user_id, 'sessionId': session_id},
        ProjectionExpression='adminComment',
    )
    existing_comment = existing.get('Item', {}).get('adminComment', {})
    created_at = existing_comment.get('createdAt', now)

    comment = {
        'text': text,
        'authorId': author_id,
        'authorEmail': author_email,
        'createdAt': created_at,
        'updatedAt': now,
    }
    table.update_item(
        Key={'userId': user_id, 'sessionId': session_id},
        UpdateExpression='SET adminComment = :comment',
        ExpressionAttributeValues={':comment': comment},
    )
    return comment


# ============================================================================
# SCENARIO CRUD (DynamoDB)
# ============================================================================

def _decimal_default(obj):
    """JSON serializer for Decimal objects from DynamoDB."""
    if isinstance(obj, Decimal):
        return float(obj) if obj % 1 else int(obj)
    raise TypeError(f"Type {type(obj)} not serializable")


def list_scenarios():
    """List all scenarios from DynamoDB."""
    if not SCENARIOS_TABLE:
        return []
    table = dynamodb.Table(SCENARIOS_TABLE)
    response = table.scan(
        ProjectionExpression='scenarioId, #n, difficulty, characters',
        ExpressionAttributeNames={'#n': 'name'},
    )
    items = response.get('Items', [])
    # Handle pagination
    while 'LastEvaluatedKey' in response:
        response = table.scan(
            ProjectionExpression='scenarioId, #n, difficulty, characters',
            ExpressionAttributeNames={'#n': 'name'},
            ExclusiveStartKey=response['LastEvaluatedKey'],
        )
        items.extend(response.get('Items', []))
    items.sort(key=lambda x: x.get('name', ''))
    return items


def get_scenario(scenario_id: str) -> dict:
    """Get a single scenario by ID."""
    if not SCENARIOS_TABLE:
        return {}
    table = dynamodb.Table(SCENARIOS_TABLE)
    response = table.get_item(Key={'scenarioId': scenario_id})
    return response.get('Item', {})


def save_scenario(scenario: dict) -> dict:
    """Create or update a scenario."""
    if not SCENARIOS_TABLE:
        return {'error': 'Scenarios table not configured'}
    table = dynamodb.Table(SCENARIOS_TABLE)
    scenario['updatedAt'] = datetime.now().isoformat()
    table.put_item(Item=scenario)
    return scenario


def delete_scenario(scenario_id: str):
    """Delete a scenario and its criteria config."""
    if not SCENARIOS_TABLE:
        return
    table = dynamodb.Table(SCENARIOS_TABLE)
    table.delete_item(Key={'scenarioId': scenario_id})
    # Also delete associated criteria config
    if CRITERIA_CONFIG_TABLE:
        config_table = dynamodb.Table(CRITERIA_CONFIG_TABLE)
        config_table.delete_item(Key={'scenarioId': scenario_id})


# ============================================================================
# CRITERIA CONFIG (DynamoDB)
# ============================================================================

def list_all_criteria():
    """Return the full criteria rubric for the admin UI."""
    return CRITERIA_RUBRIC


def get_criteria_config(scenario_id: str) -> dict:
    """
    Get criteria configuration for a scenario.
    Returns all criteria with enabled/disabled state.
    """
    disabled = set()
    if CRITERIA_CONFIG_TABLE:
        table = dynamodb.Table(CRITERIA_CONFIG_TABLE)
        response = table.get_item(Key={'scenarioId': scenario_id})
        item = response.get('Item')
        if item and 'disabledCriteria' in item:
            disabled = set(item['disabledCriteria'])

    return {
        'scenarioId': scenario_id,
        'disabledCriteria': list(disabled),
    }


def save_criteria_config(scenario_id: str, disabled_criteria: list):
    """Save criteria configuration for a scenario."""
    if not CRITERIA_CONFIG_TABLE:
        return {'error': 'Criteria config table not configured'}
    table = dynamodb.Table(CRITERIA_CONFIG_TABLE)
    item = {
        'scenarioId': scenario_id,
        'updatedAt': datetime.now().isoformat(),
    }
    if disabled_criteria:
        item['disabledCriteria'] = set(disabled_criteria)
    else:
        # No disabled criteria — delete the item (all enabled is default)
        table.delete_item(Key={'scenarioId': scenario_id})
        return {'scenarioId': scenario_id, 'disabledCriteria': []}
    table.put_item(Item=item)
    return {'scenarioId': scenario_id, 'disabledCriteria': disabled_criteria}


# ============================================================================
# SCENARIO GENERATION (Bedrock)
# ============================================================================

GENERATOR_SYSTEM_PROMPT = """You are an expert at analyzing insurance call center transcripts and converting them into structured training scenarios for an AI customer simulator.

Your job is to read a real call transcript and produce a JSON scenario that will instruct an AI voice model (Amazon Nova Sonic) to realistically simulate the CUSTOMER side of the call.

The scenario you produce must follow these rules:

1. **context field**: Write in second person ("You are [name]..."). This is the character profile and behavioral instructions the AI will adopt. Structure it as follows:

   a) **Opening line**: Start with a one-line introduction — who the caller is, their name, and their relationship to the policy (e.g., "You are Michael Knight, the owner of Antelope policy number 03N42.").

   b) **Personal details**: Include a section labeled "Personal details you know and can provide when asked:" as a bullet list with ALL personal information the customer mentions or provides in the transcript. Extract every detail: full name, date of birth, last four digits of SSN (note: "read one digit at a time"), phone number, mailing address, email, policy number, agent code, relationship to insured, etc. Use the exact values from the transcript.

   c) **Situation**: Include a section starting with "Your situation:" describing why the customer is calling and what they want. Keep this to 2-3 sentences focused on the objective.

   d) **Conditional conversation directives**: These are the most important part. Analyze the transcript for pivotal moments — where the customer reacts to specific information or questions from the agent — and encode them as behavioral instructions. Use formats like:
      - "When the agent tells you X, ask/say Y"
      - "If the agent asks about X, respond with Y"
      - "After hearing X, you decide to Y"
      Include exact quoted responses for important or specific customer reactions. Focus on: objections, escalations, emotional shifts, clarifying questions, refusals, and decision points. Capture 3-7 of the most important reactive moments. Do NOT script the entire conversation — only the key beats that make this scenario unique.

   e) Include ONLY information the CUSTOMER would know — never include internal company procedures, system notes, or agent-side information.
   f) Do NOT include raw transcript excerpts or full dialogue in the context.

2. **key_challenges**: Write 4-7 challenges from the AGENT'S perspective — what makes this call difficult to handle. These test the trainee.

3. **success_criteria**: Write 5-8 observable behaviors the agent should demonstrate to handle this call well.

4. **difficulty**: Assess the call difficulty. Choose one: beginner, intermediate, or advanced.

5. **id**: Generate a snake_case ID in the format: company_topic_number (e.g., "athene_death_notification_01").

6. **name**: A short descriptive name (e.g., "Athene Death Notification").

7. **initial_message**: The customer's first response when the agent greets them. Extract this from the transcript — it should be the first thing the customer says after the agent's greeting. Keep it concise: typically the customer's name, policy number, and brief reason for calling. Do NOT include preferences, concerns, or extra details — just the opening introduction.

8. **caller_gender**: Determine the gender of the CALLER (customer) from their name and context. Choose "male" or "female". Default to "male" if undetermined.

Return ONLY valid JSON matching this exact structure — no markdown fences, no explanation outside the JSON."""


def _parse_json_response(text: str) -> dict:
    """Extract and parse JSON from an LLM response."""
    # Try to find JSON in markdown fences first
    fenced = re.search(r"```(?:json)?\s*\n?(.*?)\n?```", text, re.DOTALL)
    if fenced:
        return json.loads(fenced.group(1).strip())
    # Try to find a JSON object directly
    brace_match = re.search(r"\{.*\}", text, re.DOTALL)
    if brace_match:
        return json.loads(brace_match.group(0))
    # Last resort: try parsing the whole thing
    return json.loads(text)


def generate_scenario_from_transcript(transcript: str) -> dict:
    """Generate a structured scenario from a call transcript using Bedrock."""
    user_prompt = f"""Analyze the following call transcript and generate a training scenario JSON.

<transcript>
{transcript}
</transcript>

Return ONLY the JSON object with these fields: id, name, context, key_challenges, success_criteria, difficulty, initial_message, caller_gender."""

    response = bedrock_client.invoke_model(
        modelId=BEDROCK_MODEL_ID,
        contentType='application/json',
        accept='application/json',
        body=json.dumps({
            'anthropic_version': 'bedrock-2023-05-31',
            'max_tokens': 4096,
            'system': GENERATOR_SYSTEM_PROMPT,
            'messages': [
                {'role': 'user', 'content': user_prompt},
            ],
        }),
    )

    response_body = json.loads(response['body'].read())
    response_text = response_body['content'][0]['text']

    scenario = _parse_json_response(response_text)

    # Attach original transcript
    scenario['original_call_logs'] = transcript

    return scenario


# ============================================================================
# API GATEWAY v2 ROUTE TABLE
# ============================================================================

# Each route: (HTTP method, regex pattern, handler function)
# Handler functions receive (path_params: dict, body: dict) and return a response dict.
ROUTES = [
    ('GET',    r'^/admin/trainees$',
     lambda p, b: {'trainees': list_trainees()}),

    ('GET',    r'^/admin/trainees/(?P<userId>[^/]+)/sessions$',
     lambda p, b: {'sessions': _list_user_sessions(p['userId'])}),

    ('GET',    r'^/admin/trainees/(?P<userId>[^/]+)/sessions/(?P<sessionId>[^/]+)/scorecard$',
     lambda p, b: {'scorecard': get_session_scorecard(p['userId'], p['sessionId'])}),

    ('GET',    r'^/admin/trainees/(?P<userId>[^/]+)/sessions/(?P<sessionId>[^/]+)/transcript$',
     lambda p, b: {'transcript': get_session_transcript(p['userId'], p['sessionId'])}),

    ('GET',    r'^/admin/trainees/(?P<userId>[^/]+)/sessions/(?P<sessionId>[^/]+)/audio-url$',
     lambda p, b: {'audioUrl': get_audio_presigned_url(p['userId'], p['sessionId'])}),

    ('GET',    r'^/admin/trainees/(?P<userId>[^/]+)/sessions/(?P<sessionId>[^/]+)/screen-recording-url$',
     lambda p, b: {'screenRecordingUrl': get_screen_recording_presigned_url(p['userId'], p['sessionId'])}),

    ('GET',    r'^/admin/trainees/(?P<userId>[^/]+)/sessions/(?P<sessionId>[^/]+)/comment$',
     lambda p, b: {'comment': get_session_comment(p['userId'], p['sessionId'])}),

    ('GET',    r'^/admin/scenarios$',
     lambda p, b: json.loads(json.dumps({'scenarios': list_scenarios()}, default=_decimal_default))),

    ('POST',   r'^/admin/scenarios/generate$',
     lambda p, b: _handle_generate_scenario(b)),

    ('POST',   r'^/admin/scenarios$',
     lambda p, b: _handle_save_scenario(b)),

    ('GET',    r'^/admin/scenarios/(?P<scenarioId>[^/]+)$',
     lambda p, b: json.loads(json.dumps({'scenario': get_scenario(p['scenarioId'])}, default=_decimal_default))),

    ('PUT',    r'^/admin/scenarios/(?P<scenarioId>[^/]+)$',
     lambda p, b: _handle_update_scenario(p, b)),

    ('DELETE', r'^/admin/scenarios/(?P<scenarioId>[^/]+)$',
     lambda p, b: _handle_delete_scenario(p)),

    ('GET',    r'^/admin/criteria$',
     lambda p, b: {'rubric': list_all_criteria()}),

    ('GET',    r'^/admin/criteria/config/(?P<scenarioId>[^/]+)$',
     lambda p, b: {'criteriaConfig': get_criteria_config(p['scenarioId'])}),

    ('PUT',    r'^/admin/criteria/config/(?P<scenarioId>[^/]+)$',
     lambda p, b: _handle_save_criteria_config(p, b)),
]


def _handle_generate_scenario(body):
    transcript = body.get('transcript', '').strip()
    if not transcript:
        return {'error': 'transcript is required'}
    scenario = generate_scenario_from_transcript(transcript)
    return {'scenario': scenario}


def _handle_save_scenario(body):
    scenario = body.get('scenario', {})
    if not scenario.get('scenarioId'):
        return {'error': 'scenario.scenarioId is required'}
    if not scenario.get('name'):
        return {'error': 'scenario.name is required'}
    saved = save_scenario(scenario)
    return json.loads(json.dumps({'scenario': saved}, default=_decimal_default))


def _handle_update_scenario(path_params, body):
    scenario = body.get('scenario', {})
    # Use scenarioId from path if not in body
    if not scenario.get('scenarioId'):
        scenario['scenarioId'] = path_params['scenarioId']
    if not scenario.get('name'):
        return {'error': 'scenario.name is required'}
    saved = save_scenario(scenario)
    return json.loads(json.dumps({'scenario': saved}, default=_decimal_default))


def _handle_delete_scenario(path_params):
    scenario_id = path_params['scenarioId']
    delete_scenario(scenario_id)
    return {'deleted': True, 'scenarioId': scenario_id}


def _handle_save_criteria_config(path_params, body):
    scenario_id = path_params['scenarioId']
    disabled = body.get('disabledCriteria', [])
    result = save_criteria_config(scenario_id, disabled)
    return {'criteriaConfig': result}


# ============================================================================
# LAMBDA HANDLER
# ============================================================================

def lambda_handler(event, context):
    """
    Admin Lambda handler. Supports API Gateway v2 proxy events.
    Routes based on HTTP method + path pattern.
    Admin group membership is verified via the JWT cognito:groups claim.
    """
    try:
        # API Gateway v2 proxy event
        method = event['requestContext']['http']['method']
        path = event['rawPath']

        # Verify admin group membership from JWT claims
        claims = event.get('requestContext', {}).get('authorizer', {}).get('jwt', {}).get('claims', {})
        groups = claims.get('cognito:groups', '')
        if 'admin' not in groups:
            return _http_response(403, {'error': 'Forbidden: admin group required'})

        # Parse request body for POST/PUT
        body = {}
        if event.get('body'):
            body = json.loads(event['body'])

        # Special route: save comment (needs JWT claims for author info)
        comment_match = re.match(
            r'^/admin/trainees/(?P<userId>[^/]+)/sessions/(?P<sessionId>[^/]+)/comment$',
            path,
        )
        if comment_match and method == 'PUT':
            text = body.get('text', '').strip()
            if not text:
                return _http_response(400, {'error': 'text is required'})
            author_id = claims.get('sub', 'unknown')
            author_email = claims.get('email', 'unknown')
            comment = save_session_comment(
                comment_match.group('userId'),
                comment_match.group('sessionId'),
                text, author_id, author_email,
            )
            return _http_response(200, {'comment': comment})

        # Match route
        for route_method, route_pattern, handler in ROUTES:
            if method != route_method:
                continue
            match = re.match(route_pattern, path)
            if match:
                path_params = match.groupdict()
                result = handler(path_params, body)
                if 'error' in result:
                    return _http_response(400, result)
                return _http_response(200, result)

        return _http_response(404, {'error': f'Not found: {method} {path}'})

    except s3_client.exceptions.NoSuchKey:
        return _http_response(404, {'error': 'Resource not found'})
    except Exception as e:
        logger.exception("Admin Lambda error: %s", e)
        return _http_response(500, {'error': 'Admin operation failed', 'details': str(e)})
