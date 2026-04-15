"""
Lambda function to analyze screen captures during training sessions.
Receives batches of JPEG screenshots, calls Claude vision via Bedrock invoke_model
with structured output, and stores accumulated summaries in S3.

Invoked via API Gateway v2 (HTTP API) with JWT authorizer.
Route: POST /screen-analysis
"""

import json
import logging
import os
import base64
import boto3
from datetime import datetime

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

BEDROCK_MODEL_ID = os.environ.get('BEDROCK_MODEL_ID', 'us.anthropic.claude-sonnet-4-6')

s3_client = boto3.client('s3')
bedrock_client = boto3.client(
    'bedrock-runtime',
    region_name=os.environ.get('AWS_REGION', 'us-west-2')
)

# JSON schema for structured output — array wrapped in an object (top-level must be object)
SCREEN_ANALYSIS_SCHEMA = {
    "type": "object",
    "properties": {
        "screenshots": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "captureIndex": {"type": "integer", "description": "Index of the screenshot from the input"},
                    "actionDescription": {"type": "string", "description": "1-2 sentence description of trainee's on-screen activity"},
                    "visibleApplications": {"type": "array", "items": {"type": "string"}, "description": "Applications or windows visible on screen"},
                    "confidence": {"type": "string", "enum": ["high", "medium", "low"], "description": "Confidence in the analysis"}
                },
                "required": ["captureIndex", "actionDescription", "visibleApplications", "confidence"],
                "additionalProperties": False
            }
        }
    },
    "required": ["screenshots"],
    "additionalProperties": False
}


def _http_response(status_code, body):
    """Return an API Gateway v2 proxy response."""
    return {
        'statusCode': status_code,
        'headers': {'Content-Type': 'application/json'},
        'body': json.dumps(body),
    }


def analyze_screenshots_with_claude(captures: list, scenario_name: str) -> list:
    """
    Call Claude vision via Bedrock invoke_model with a batch of screenshots.

    Args:
        captures: List of dicts with imageData (base64 JPEG), timestamp, elapsedSeconds, captureIndex
        scenario_name: Name of the training scenario for context

    Returns:
        List of summary dicts
    """
    # Build content blocks in Anthropic Messages API format
    content = []
    content.append({
        'type': 'text',
        'text': (
            f"You are analyzing screen captures from a call center training session. "
            f"The trainee is working on scenario: '{scenario_name}'. "
            f"For each screenshot below, describe what the trainee appears to be doing on their screen. "
            f"Focus on: which application/window is in focus, what data they are looking at, "
            f"what actions they appear to be taking (typing, navigating, reading). "
            f"Be concise (1-2 sentences per screenshot)."
        )
    })

    for i, capture in enumerate(captures):
        content.append({
            'type': 'text',
            'text': f"Screenshot {i + 1} (elapsed: {capture['elapsedSeconds']}s, index: {capture['captureIndex']}):"
        })
        # Images stay as base64 strings — no decode needed with Anthropic Messages API
        content.append({
            'type': 'image',
            'source': {
                'type': 'base64',
                'media_type': 'image/jpeg',
                'data': capture['imageData']
            }
        })

    request_body = {
        'anthropic_version': 'bedrock-2023-05-31',
        'max_tokens': 2000,
        'temperature': 0,
        'messages': [{'role': 'user', 'content': content}],
        'output_config': {
            'format': {
                'type': 'json_schema',
                'schema': SCREEN_ANALYSIS_SCHEMA
            }
        }
    }

    response = bedrock_client.invoke_model(
        modelId=BEDROCK_MODEL_ID,
        body=json.dumps(request_body),
        contentType='application/json',
        accept='application/json'
    )

    response_body = json.loads(response['body'].read())

    usage = response_body.get('usage', {})
    logger.info('TOKEN_USAGE component=screen_analysis model=%s input_tokens=%d output_tokens=%d',
                BEDROCK_MODEL_ID, usage.get('input_tokens', 0), usage.get('output_tokens', 0))

    token_usage = {
        'model': BEDROCK_MODEL_ID,
        'input_tokens': usage.get('input_tokens', 0),
        'output_tokens': usage.get('output_tokens', 0),
    }

    result = json.loads(response_body['content'][0]['text'])
    summaries_raw = result['screenshots']

    # Merge with timestamp metadata from captures
    capture_lookup = {c['captureIndex']: c for c in captures}
    summaries = []
    for summary in summaries_raw:
        idx = summary.get('captureIndex', 0)
        capture = capture_lookup.get(idx, captures[0] if captures else {})
        summaries.append({
            "timestamp": capture.get('timestamp', 0),
            "elapsedSeconds": capture.get('elapsedSeconds', 0),
            "captureIndex": idx,
            "actionDescription": summary.get('actionDescription', ''),
            "visibleApplications": summary.get('visibleApplications', []),
            "confidence": summary.get('confidence', 'medium'),
        })

    return summaries, token_usage


def load_existing_summaries(bucket: str, session_id: str, user_id: str = "") -> tuple:
    """Load existing screen action summaries and cumulative token usage from S3."""
    prefix = f"users/{user_id}/sessions/{session_id}"
    key = f"{prefix}/{session_id}_screen_actions.json"
    empty_usage = {'model': BEDROCK_MODEL_ID, 'input_tokens': 0, 'output_tokens': 0}
    try:
        response = s3_client.get_object(Bucket=bucket, Key=key)
        data = json.loads(response['Body'].read().decode('utf-8'))
        return data.get('summaries', []), data.get('token_usage', empty_usage)
    except s3_client.exceptions.NoSuchKey:
        return [], empty_usage
    except Exception:
        return [], empty_usage


def save_summaries_to_s3(bucket: str, session_id: str, summaries: list, user_id: str = "", token_usage: dict = None) -> str:
    """Save accumulated summaries and cumulative token usage to S3."""
    prefix = f"users/{user_id}/sessions/{session_id}"
    key = f"{prefix}/{session_id}_screen_actions.json"
    data = {
        "sessionId": session_id,
        "summaries": summaries,
        "lastUpdated": datetime.now().isoformat(),
        "totalCaptures": len(summaries),
    }
    if token_usage:
        data["token_usage"] = token_usage
    s3_client.put_object(
        Bucket=bucket,
        Key=key,
        Body=json.dumps(data, indent=2, ensure_ascii=False),
        ContentType='application/json'
    )
    return f"s3://{bucket}/{key}"


def save_screenshots_to_s3(bucket: str, session_id: str, captures: list, user_id: str = "") -> int:
    """Save screenshot JPEG images to S3 for the session.

    Returns the number of screenshots successfully saved.
    """
    saved = 0
    prefix = f"users/{user_id}/sessions/{session_id}/screenshots"
    for capture in captures:
        image_data = capture.get('imageData')
        capture_index = capture.get('captureIndex', 0)
        if not image_data:
            continue
        key = f"{prefix}/{session_id}_screenshot_{capture_index}.jpg"
        try:
            s3_client.put_object(
                Bucket=bucket,
                Key=key,
                Body=base64.b64decode(image_data),
                ContentType='image/jpeg',
            )
            saved += 1
        except Exception as e:
            logger.error("Failed to save screenshot %s: %s", capture_index, e)
    return saved


def lambda_handler(event, context):
    """
    Screen analysis Lambda handler. Supports API Gateway v2 proxy events.
    Route: POST /screen-analysis
    """
    try:
        # Parse body from API Gateway v2 proxy event
        body = json.loads(event.get('body') or '{}')

        session_id = body.get('sessionId')
        scenario_name = body.get('scenarioName', 'Unknown')
        captures = body.get('captures', [])
        user_id = body.get('userId', '')

        if not session_id:
            return _http_response(400, {'error': 'sessionId is required'})
        if not captures:
            return _http_response(400, {'error': 'captures array is required and must not be empty'})

        bucket = os.environ.get('RECORDINGS_BUCKET')
        if not bucket:
            return _http_response(500, {'error': 'Service configuration error'})

        logger.info("Analyzing %d screen captures for session %s, user: %s", len(captures), session_id, user_id)

        # Persist screenshot images to S3 before analysis (so they're saved even if analysis fails)
        saved_count = save_screenshots_to_s3(bucket, session_id, captures, user_id=user_id)
        logger.info("Saved %d/%d screenshots to S3", saved_count, len(captures))

        # Analyze with Claude vision
        new_summaries, new_usage = analyze_screenshots_with_claude(captures, scenario_name)

        # Load existing summaries and cumulative token usage
        existing_summaries, existing_usage = load_existing_summaries(bucket, session_id, user_id=user_id)
        all_summaries = existing_summaries + new_summaries
        all_summaries.sort(key=lambda s: s.get('captureIndex', 0))

        # Accumulate token usage
        cumulative_usage = {
            'model': new_usage.get('model', BEDROCK_MODEL_ID),
            'input_tokens': existing_usage.get('input_tokens', 0) + new_usage.get('input_tokens', 0),
            'output_tokens': existing_usage.get('output_tokens', 0) + new_usage.get('output_tokens', 0),
        }

        # Save back to S3
        s3_url = save_summaries_to_s3(bucket, session_id, all_summaries, user_id=user_id, token_usage=cumulative_usage)

        logger.info("Saved %d total summaries to %s", len(all_summaries), s3_url)

        return _http_response(200, {
            'sessionId': session_id,
            'summaries': new_summaries,
            's3Url': s3_url,
            'timestamp': datetime.now().isoformat(),
            'token_usage': cumulative_usage,
        })

    except Exception as e:
        logger.exception("Error during screen analysis: %s", e)
        return _http_response(500, {'error': 'Screen analysis failed', 'details': str(e)})
