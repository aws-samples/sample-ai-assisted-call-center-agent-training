"""
Lambda function to score call center training session recordings.
Retrieves session data from S3, runs scoring evaluation, and saves results.

Invoked via API Gateway v2 (HTTP API) with JWT authorizer.
Uses async self-invocation pattern because scoring takes 1-3 minutes
but API Gateway has a 30-second integration timeout.

Routes:
- POST /scoring         → Kick off scoring (returns 202 immediately)
- GET  /scoring/{id}    → Poll for scoring result
"""

import json
import logging
import os
import asyncio
import boto3
import concurrent.futures
from datetime import datetime
import tempfile

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

s3_client = boto3.client('s3')
lambda_client = boto3.client('lambda')
dynamodb_client = boto3.client('dynamodb')
dynamodb_resource = boto3.resource('dynamodb')
CRITERIA_CONFIG_TABLE = os.environ.get('CRITERIA_CONFIG_TABLE', '')
SESSIONS_TABLE = os.environ.get('SESSIONS_TABLE', '')


def _http_response(status_code, body):
    """Return an API Gateway v2 proxy response."""
    return {
        'statusCode': status_code,
        'headers': {'Content-Type': 'application/json'},
        'body': json.dumps(body),
    }


def download_session_from_s3(bucket_name: str, session_id: str, temp_dir: str, user_id: str = ""):
    """
    Download session JSON from S3.

    Args:
        bucket_name: S3 bucket name
        session_id: Session identifier
        temp_dir: Temporary directory to download files
        user_id: Optional user identifier for user-scoped paths

    Returns:
        Path to downloaded session JSON file
    """
    prefix = f"users/{user_id}/sessions/{session_id}"
    json_key = f"{prefix}/{session_id}_server_transcript.json"
    json_path = os.path.join(temp_dir, f"{session_id}_server_transcript.json")

    logger.info("Downloading %s from S3 bucket %s", json_key, bucket_name)
    s3_client.download_file(bucket_name, json_key, json_path)

    return json_path


def load_session_recording(json_path: str):
    """
    Load SessionRecording from downloaded JSON file.

    Args:
        json_path: Path to session JSON file

    Returns:
        SessionRecording object
    """
    from src.recording.session_types import SessionRecording, ConversationTurn

    with open(json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    # Reconstruct transcript turns
    transcript = [
        ConversationTurn(**turn) for turn in data['transcript']
    ]
    data['transcript'] = transcript

    # Handle token_usage field (may not exist in older recordings)
    data.setdefault('token_usage', None)

    return SessionRecording(**data)


def save_scorecard_to_s3(bucket_name: str, session_id: str, scorecard_data: dict, user_id: str = ""):
    """
    Save scorecard results to S3 in the same prefix as session recordings

    Args:
        bucket_name: S3 bucket name
        session_id: Session identifier
        scorecard_data: Scorecard result dictionary
        user_id: Optional user identifier for user-scoped paths
    """
    prefix = f"users/{user_id}/sessions/{session_id}"
    scorecard_key = f"{prefix}/{session_id}_scorecard.json"

    logger.info("Uploading scorecard to %s", scorecard_key)
    s3_client.put_object(
        Bucket=bucket_name,
        Key=scorecard_key,
        Body=json.dumps(scorecard_data, indent=2, ensure_ascii=False),
        ContentType='application/json'
    )

    return f"s3://{bucket_name}/{scorecard_key}"


def _update_session_score(user_id: str, session_id: str, scorecard_summary: dict, session_recording=None):
    """Update the DynamoDB session record with scoring results.

    Uses if_not_exists for gsiPk and timestamp to preserve the values set by
    the Lambda that originally created the session record.
    """
    if not SESSIONS_TABLE:
        logger.warning("SESSIONS_TABLE not configured, skipping DynamoDB update")
        return

    pct = scorecard_summary.get('percentage_score')
    passed = scorecard_summary.get('passed')

    grade = None
    if pct is not None:
        if pct >= 90:
            grade = 'A'
        elif pct >= 80:
            grade = 'B'
        elif pct >= 70:
            grade = 'C'
        elif pct >= 60:
            grade = 'D'
        else:
            grade = 'F'

    from decimal import Decimal
    try:
        table = dynamodb_resource.Table(SESSIONS_TABLE)

        ts = session_recording.start_time or datetime.utcnow().isoformat() + 'Z'
        scenario_name = session_recording.scenario_name or scorecard_summary.get('scenario_name', '')
        scenario_id = session_recording.scenario_id or ''
        user_name = session_recording.user_name or ''
        customer_mood = session_recording.customer_mood or ''
        difficulty = session_recording.difficulty or ''

        expr_values = {
            ':status': 'scored',
            ':grade': grade,
            ':passed': passed,
            ':gsiPk': 'ALL',
            ':ts': ts,
        }
        # gsiPk and timestamp use if_not_exists to preserve the value set by
        # the Lambda that created the session (Connect sets 'SESSION', web UI
        # sets 'ALL') — overwriting would break per-source GSI queries.
        update_parts = [
            '#st = :status',
            'grade = :grade',
            'passed = :passed',
            'gsiPk = if_not_exists(gsiPk, :gsiPk)',
            '#ts = if_not_exists(#ts, :ts)',
        ]
        expr_names = {'#ts': 'timestamp', '#st': 'status'}

        if pct is not None:
            expr_values[':score'] = Decimal(str(round(pct, 1)))
            update_parts.append('score = :score')

        if scenario_name:
            expr_values[':scenarioName'] = scenario_name
            update_parts.append('scenarioName = :scenarioName')

        if scenario_id:
            expr_values[':scenarioId'] = scenario_id
            update_parts.append('scenarioId = :scenarioId')

        if user_name:
            expr_values[':userName'] = user_name
            update_parts.append('userName = :userName')

        if customer_mood:
            expr_values[':customerMood'] = customer_mood
            update_parts.append('customerMood = :customerMood')

        if difficulty:
            expr_values[':difficulty'] = difficulty
            update_parts.append('difficulty = :difficulty')

        # Write token usage if available
        token_usage = scorecard_summary.get('token_usage')
        if token_usage:
            expr_values[':tokenUsage'] = token_usage
            update_parts.append('tokenUsage = :tokenUsage')

        update_expr = 'SET ' + ', '.join(update_parts)

        table.update_item(
            Key={'userId': user_id, 'sessionId': session_id},
            UpdateExpression=update_expr,
            ExpressionAttributeValues=expr_values,
            ExpressionAttributeNames=expr_names,
        )
        logger.info("Updated DynamoDB session %s: score=%s, grade=%s, passed=%s", session_id, pct, grade, passed)
    except Exception as e:
        # Non-fatal: scorecard is still saved in S3
        logger.error("Failed to update DynamoDB session %s: %s", session_id, e)


def download_screen_actions(bucket_name: str, session_id: str, user_id: str = "") -> tuple:
    """
    Download screen action summaries and token usage from S3 if they exist.

    Args:
        bucket_name: S3 bucket name
        session_id: Session identifier
        user_id: Optional user identifier for user-scoped paths

    Returns:
        Tuple of (summaries list, token_usage dict or None)
    """
    prefix = f"users/{user_id}/sessions/{session_id}"
    key = f"{prefix}/{session_id}_screen_actions.json"
    try:
        response = s3_client.get_object(Bucket=bucket_name, Key=key)
        data = json.loads(response['Body'].read().decode('utf-8'))
        return data.get('summaries', []), data.get('token_usage')
    except s3_client.exceptions.NoSuchKey:
        return [], None
    except Exception:
        return [], None


def get_enabled_criteria(scenario_id: str):
    """
    Fetch enabled criteria IDs from DynamoDB for a scenario.
    Returns None if no config exists (meaning all criteria enabled).
    """
    if not CRITERIA_CONFIG_TABLE:
        return None

    try:
        response = dynamodb_client.get_item(
            TableName=CRITERIA_CONFIG_TABLE,
            Key={'scenarioId': {'S': scenario_id}},
        )
        item = response.get('Item')
        if not item:
            return None  # No config exists, all criteria enabled

        # Get disabled criteria set
        disabled = set()
        if 'disabledCriteria' in item and 'SS' in item['disabledCriteria']:
            disabled = set(item['disabledCriteria']['SS'])

        if not disabled:
            return None  # Nothing disabled, all criteria enabled

        # Compute enabled = all criteria minus disabled
        from src.models.rubric_loader import load_rubric, get_all_criterion_ids
        scoring_config = load_rubric()
        all_criteria = get_all_criterion_ids(scoring_config)

        enabled = all_criteria - disabled
        logger.info("Criteria config for %s: %d enabled, %d disabled", scenario_id, len(enabled), len(disabled))
        return enabled

    except Exception as e:
        logger.error("Error fetching criteria config: %s", e)
        return None  # Fallback to all criteria


async def run_scoring(session_recording, screen_actions=None, enabled_criteria=None, analytics_data=None):
    """
    Run scoring engine on session recording

    Args:
        session_recording: SessionRecording object
        screen_actions: Optional list of screen action summaries
        enabled_criteria: Optional set of enabled criterion IDs
        analytics_data: Optional pre-computed transcript analytics

    Returns:
        Scored scorecard dict
    """
    from src.evaluators.scoring_engine import ScoringEngine

    logger.info("Starting scoring for session %s", session_recording.session_id)
    # Use /tmp directory which is writable in Lambda
    engine = ScoringEngine(evaluations_dir="/tmp/evaluations")  # nosec B108

    scorecard = await engine.evaluate_session(session_recording, screen_actions, enabled_criteria, analytics_data)
    logger.info("Scoring completed: %s/%s pts", scorecard['final_score'], scorecard['total_possible_score'])
    logger.info("Pass: %s, Critical failures: %d", scorecard['passed'], len(scorecard['critical_failures']))

    return scorecard


def _apply_enriched_transcript(session_recording, bucket, session_id, user_id):
    """Try to load client-side enriched transcript and merge timing into session recording.

    The enriched transcript has accurate audio_start_time and audio_duration
    measured on the web client (vs server-side estimates in the session JSON).
    """
    prefix = f"users/{user_id}/sessions/{session_id}"
    key = f"{prefix}/{session_id}_client_transcript.json"

    try:
        response = s3_client.get_object(Bucket=bucket, Key=key)
        enriched_turns = json.loads(response['Body'].read().decode('utf-8'))
        logger.info("Loaded enriched transcript: %d turns", len(enriched_turns))

        # Merge timing data into session recording transcript.
        # Match turns by index (both are ordered chronologically).
        original_turns = session_recording.transcript
        matched = 0
        for i, enriched in enumerate(enriched_turns):
            if i >= len(original_turns):
                break
            original_turns[i].audio_start_time = enriched.get('audio_start_time', original_turns[i].audio_start_time)
            original_turns[i].audio_duration = enriched.get('audio_duration', original_turns[i].audio_duration)
            matched += 1

        logger.info("Merged enriched timing for %d/%d turns", matched, len(original_turns))
        return True
    except s3_client.exceptions.NoSuchKey:
        logger.info("No enriched transcript found, using original timing")
        return False
    except Exception as e:
        logger.warning("Failed to load enriched transcript (non-fatal): %s", e)
        return False


def _invoke_empathy_lambda(function_name, session_id, user_id, bucket):
    """Invoke audio empathy Lambda synchronously. Designed to run in a thread pool."""
    try:
        logger.info("Starting audio empathy analysis (concurrent)")
        response = lambda_client.invoke(
            FunctionName=function_name,
            InvocationType='RequestResponse',
            Payload=json.dumps({
                'sessionId': session_id,
                'userId': user_id,
                'bucket': bucket,
            }),
        )
        payload = json.loads(response['Payload'].read())
        if payload.get('score') is not None:
            logger.info("Audio empathy score: %s", payload['score'])
            return payload
        elif payload.get('errorMessage'):
            logger.error("Audio empathy Lambda error: %s", payload['errorMessage'])
    except Exception as e:
        logger.warning("Audio empathy analysis failed (non-fatal): %s", e)
    return None


def _run_scoring_sync(session_id: str, user_id: str):
    """Run the full scoring pipeline synchronously. Used by async self-invocation."""
    recordings_bucket = os.environ.get('RECORDINGS_BUCKET')
    evaluations_bucket = os.environ.get('EVALUATIONS_BUCKET', recordings_bucket)

    if not recordings_bucket:
        logger.error("RECORDINGS_BUCKET not configured")
        return

    logger.info("Processing scoring for session: %s, user: %s", session_id, user_id)

    with tempfile.TemporaryDirectory() as temp_dir:
        json_path = download_session_from_s3(
            recordings_bucket, session_id, temp_dir, user_id=user_id
        )
        session_recording = load_session_recording(json_path)

        # Merge client-side enriched transcript timing (if available)
        _apply_enriched_transcript(session_recording, recordings_bucket, session_id, user_id)

        screen_actions, screen_analysis_tokens = download_screen_actions(recordings_bucket, session_id, user_id=user_id)
        if screen_actions:
            logger.info("Found %d screen action summaries", len(screen_actions))

        enabled_criteria = get_enabled_criteria(session_recording.scenario_id)

        # Compute transcript-based call analytics BEFORE scoring so Claude
        # can reference quantitative metrics (silence gaps, jargon, etc.)
        from src.evaluators.transcript_analytics import compute_transcript_analytics
        analytics = compute_transcript_analytics(session_recording)

        # Kick off audio empathy analysis concurrently (runs in background thread
        # while Claude evaluation proceeds on the main thread)
        empathy_future = None
        executor = None
        audio_empathy_fn = os.environ.get('AUDIO_EMPATHY_FUNCTION_NAME')
        if audio_empathy_fn:
            executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
            empathy_future = executor.submit(
                _invoke_empathy_lambda, audio_empathy_fn, session_id, user_id, recordings_bucket
            )

        # Claude evaluation (main thread — this is the long-running operation)
        # Pass analytics data so Claude can reference quantitative metrics in its evaluation
        scorecard = asyncio.run(
            run_scoring(session_recording, screen_actions or None, enabled_criteria, analytics_data=analytics)
        )

        # Extract scoring token usage before formatting
        scoring_token_usage = scorecard.pop('_scoring_token_usage', None)

        from src.evaluators.scoring_engine import ScoringEngine
        engine = ScoringEngine()
        scorecard_summary = engine.format_scorecard_summary(scorecard)
        scorecard_summary['session_id'] = session_id
        scorecard_summary['scenario_name'] = session_recording.scenario_name
        scorecard_summary['user_id'] = user_id

        # Aggregate token usage from all components
        token_usage = {}
        if scoring_token_usage:
            token_usage['scoring'] = scoring_token_usage
        # Nova Sonic usage comes from the session transcript JSON
        if session_recording.token_usage:
            token_usage.update(session_recording.token_usage)
        # Screen analysis usage comes from the screen_actions JSON
        if screen_analysis_tokens:
            token_usage['screen_analysis'] = screen_analysis_tokens
        if token_usage:
            scorecard_summary['token_usage'] = token_usage
            logger.info("TOKEN_USAGE_SUMMARY session_id=%s components=%s", session_id, list(token_usage.keys()))

        # Collect audio empathy result (should already be done or nearly done)
        if empathy_future:
            try:
                empathy_result = empathy_future.result(timeout=180)
                if empathy_result:
                    analytics['empathy'] = empathy_result
            except concurrent.futures.TimeoutError:
                logger.warning("Audio empathy analysis timed out (non-fatal)")
            except Exception as e:
                logger.warning("Audio empathy analysis failed (non-fatal): %s", e)
            finally:
                executor.shutdown(wait=False)

        scorecard_summary['analytics'] = analytics

        s3_url = save_scorecard_to_s3(
            evaluations_bucket, session_id, scorecard_summary, user_id=user_id
        )
        logger.info("Scoring completed: %s", s3_url)

        # Update DynamoDB session record with score + metadata fallback
        _update_session_score(user_id, session_id, scorecard_summary, session_recording)


def _get_scorecard_from_s3(session_id: str, user_id: str) -> dict:
    """Check S3 for a completed scorecard."""
    bucket = os.environ.get('RECORDINGS_BUCKET', '')
    prefix = f"users/{user_id}/sessions/{session_id}"
    key = f"{prefix}/{session_id}_scorecard.json"
    response = s3_client.get_object(Bucket=bucket, Key=key)
    return json.loads(response['Body'].read().decode('utf-8'))


def lambda_handler(event, context):
    """
    Scoring Lambda handler.

    Handles three event types:
    1. API Gateway v2 POST /scoring → Kick off async scoring, return 202
    2. API Gateway v2 GET /scoring/{sessionId} → Poll for result
    3. Async self-invocation (asyncScoring=true) → Run scoring pipeline
    """
    try:
        # Handle async self-invocation (from POST /scoring)
        if event.get('asyncScoring'):
            _run_scoring_sync(event['sessionId'], event.get('userId', ''))
            return {'status': 'completed'}

        # API Gateway v2 proxy event
        method = event['requestContext']['http']['method']
        path = event['rawPath']
        path_params = event.get('pathParameters') or {}

        if method == 'POST' and path == '/scoring':
            # Parse request body
            body = json.loads(event.get('body') or '{}')
            session_id = body.get('sessionId')
            user_id = body.get('userId', '')

            if not session_id:
                return _http_response(400, {'error': 'sessionId is required'})

            # Check if scorecard already exists
            try:
                existing = _get_scorecard_from_s3(session_id, user_id)
                return _http_response(200, {
                    'sessionId': session_id,
                    'scorecard': existing,
                    'status': 'completed',
                })
            except Exception:  # nosec B110
                logger.debug('No existing scorecard for %s, proceeding with scoring', session_id)

            # Invoke self asynchronously for long-running scoring
            lambda_client.invoke(
                FunctionName=os.environ['AWS_LAMBDA_FUNCTION_NAME'],
                InvocationType='Event',
                Payload=json.dumps({
                    'asyncScoring': True,
                    'sessionId': session_id,
                    'userId': user_id,
                }),
            )

            return _http_response(202, {
                'sessionId': session_id,
                'status': 'scoring',
            })

        elif method == 'GET' and path.startswith('/scoring/'):
            session_id = path_params.get('sessionId', '')
            query_params = event.get('queryStringParameters') or {}
            user_id = query_params.get('userId', '')

            if not session_id:
                return _http_response(400, {'error': 'sessionId is required'})

            # Check S3 for completed scorecard
            try:
                scorecard = _get_scorecard_from_s3(session_id, user_id)
                return _http_response(200, {
                    'sessionId': session_id,
                    'scorecard': scorecard,
                    'status': 'completed',
                })
            except s3_client.exceptions.NoSuchKey:
                return _http_response(200, {
                    'sessionId': session_id,
                    'status': 'scoring',
                })

        else:
            return _http_response(404, {'error': f'Not found: {method} {path}'})

    except Exception as e:
        logger.exception("Error during scoring: %s", e)
        return _http_response(500, {'error': 'Scoring failed', 'details': str(e)})
