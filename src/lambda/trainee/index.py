"""
Trainee Lambda function — scenario access and session creation.

Provides trainees with:
- GET /scenarios: List all scenarios (summary fields only)
- GET /scenarios/{scenarioId}: Get full scenario by ID
- POST /sessions: Create a session record in DynamoDB when starting a training call

Admin operations (CRUD, generate, criteria config) remain in the admin Lambda.

Invoked via API Gateway v2 (HTTP API) with JWT authorizer.
"""

import json
import logging
import os
import boto3
from datetime import datetime, timezone
from decimal import Decimal

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

dynamodb = boto3.resource('dynamodb')
SCENARIOS_TABLE = os.environ.get('SCENARIOS_TABLE', '')
SESSIONS_TABLE = os.environ.get('SESSIONS_TABLE', '')


class DecimalEncoder(json.JSONEncoder):
    """Handle DynamoDB Decimal types in JSON serialization."""
    def default(self, o):
        if isinstance(o, Decimal):
            return int(o) if o == int(o) else float(o)
        return super().default(o)


def _http_response(status_code, body):
    """Return an API Gateway v2 proxy response."""
    return {
        'statusCode': status_code,
        'headers': {'Content-Type': 'application/json'},
        'body': json.dumps(body, cls=DecimalEncoder),
    }


def list_scenarios():
    """List all scenarios (summary fields only)."""
    if not SCENARIOS_TABLE:
        return []
    table = dynamodb.Table(SCENARIOS_TABLE)
    response = table.scan(
        ProjectionExpression='scenarioId, #n, difficulty, caller_gender, characters',
        ExpressionAttributeNames={'#n': 'name'},
    )
    items = response.get('Items', [])
    while 'LastEvaluatedKey' in response:
        response = table.scan(
            ProjectionExpression='scenarioId, #n, difficulty, caller_gender, characters',
            ExpressionAttributeNames={'#n': 'name'},
            ExclusiveStartKey=response['LastEvaluatedKey'],
        )
        items.extend(response.get('Items', []))
    items.sort(key=lambda x: x.get('name', ''))
    return items


def get_scenario(scenario_id: str) -> dict:
    """Get a single scenario by ID (all fields)."""
    if not SCENARIOS_TABLE:
        return {}
    table = dynamodb.Table(SCENARIOS_TABLE)
    response = table.get_item(Key={'scenarioId': scenario_id})
    return response.get('Item', {})


def create_session(body: dict, claims: dict) -> dict:
    """Create a new session record in DynamoDB when a trainee starts a call."""
    if not SESSIONS_TABLE:
        return {'error': 'Sessions table not configured'}

    session_id = body.get('sessionId', '')
    scenario_id = body.get('scenarioId', '')
    scenario_name = body.get('scenarioName', '')
    customer_mood = body.get('customerMood', '')
    difficulty = body.get('difficulty', '')

    if not session_id or not scenario_id:
        return {'error': 'sessionId and scenarioId are required'}

    # Extract user info from JWT claims
    user_id = claims.get('sub', '')
    user_name = claims.get('name', claims.get('email', ''))

    table = dynamodb.Table(SESSIONS_TABLE)
    item = {
        'userId': user_id,
        'sessionId': session_id,
        'userName': user_name,
        'scenarioId': scenario_id,
        'scenarioName': scenario_name,
        'customerMood': customer_mood,
        'difficulty': difficulty,
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'gsiPk': 'ALL',
    }
    table.put_item(Item=item)
    return {'session': item}


def lambda_handler(event, context):
    """
    Trainee Lambda handler. Supports API Gateway v2 proxy events.
    Routes based on HTTP method + path pattern.
    All authenticated users can access these routes (no admin check).
    """
    try:
        method = event['requestContext']['http']['method']
        path = event['rawPath']
        path_params = event.get('pathParameters') or {}
        claims = event.get('requestContext', {}).get('authorizer', {}).get('jwt', {}).get('claims', {})

        if method == 'GET' and path == '/scenarios':
            scenarios = list_scenarios()
            return _http_response(200, {'scenarios': scenarios})

        elif method == 'GET' and path.startswith('/scenarios/'):
            scenario_id = path_params.get('scenarioId', '')
            if not scenario_id:
                return _http_response(400, {'error': 'scenarioId is required'})
            scenario = get_scenario(scenario_id)
            return _http_response(200, {'scenario': scenario})

        elif method == 'POST' and path == '/sessions':
            body = json.loads(event.get('body') or '{}')
            result = create_session(body, claims)
            if 'error' in result:
                return _http_response(400, result)
            return _http_response(201, result)

        else:
            return _http_response(404, {'error': f'Not found: {method} {path}'})

    except Exception as e:
        logger.exception("Trainee Lambda error: %s", e)
        return _http_response(500, {'error': str(e)})
