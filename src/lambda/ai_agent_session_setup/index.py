"""
AI Agent Session Setup Lambda

Injects scenario data into Q Connect AI Agent sessions via UpdateSessionData API.

Flow:
1. Receives contactId and scenario_id from Connect contact flow
2. Queries Connect DescribeContact to get WisdomInfo.SessionArn (with retry logic)
3. Extracts session ID from SessionArn
4. Loads scenario from DynamoDB Scenarios table
5. Calls QConnect UpdateSessionData to inject scenario fields as custom session data
6. AI Agent prompt can reference {{$.Custom.scenarioId}}, {{$.Custom.name}}, etc.
"""

import json
import logging
import time
import os
import boto3
from decimal import Decimal

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

# Initialize clients
qconnect = boto3.client('qconnect')
connect_client = boto3.client('connect')


def _decimal_to_native(obj):
    """Recursively convert DynamoDB Decimal types to int/float."""
    if isinstance(obj, Decimal):
        return int(obj) if obj == int(obj) else float(obj)
    if isinstance(obj, dict):
        return {k: _decimal_to_native(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_decimal_to_native(i) for i in obj]
    return obj


def load_scenario(scenario_id: str) -> dict:
    """Load scenario from DynamoDB Scenarios table."""
    scenarios_table_name = os.environ.get('SCENARIOS_TABLE')
    if not scenarios_table_name:
        raise ValueError("SCENARIOS_TABLE environment variable not set")

    dynamodb = boto3.resource('dynamodb')
    table = dynamodb.Table(scenarios_table_name)

    response = table.get_item(Key={'scenarioId': scenario_id})
    item = response.get('Item')

    if not item:
        raise ValueError(f"Scenario '{scenario_id}' not found in DynamoDB")

    # Convert Decimal types to native Python types
    return _decimal_to_native(item)


def get_session_id_from_contact(contact_id: str, max_retries: int = 5) -> str:
    """
    Get Q Connect session ID from Connect contact.

    Implements exponential backoff retry logic to handle eventual consistency
    of WisdomInfo.SessionArn field in DescribeContact response.

    Args:
        contact_id: Connect contact ID
        max_retries: Maximum number of retry attempts (default: 5)

    Returns:
        Q Connect session ID extracted from WisdomInfo.SessionArn

    Raises:
        ValueError: If session ARN not found after max retries
    """
    connect_instance_id = os.environ.get('CONNECT_INSTANCE_ID')
    if not connect_instance_id:
        raise ValueError("CONNECT_INSTANCE_ID environment variable not set")

    for attempt in range(max_retries):
        try:
            response = connect_client.describe_contact(
                InstanceId=connect_instance_id,
                ContactId=contact_id
            )

            contact = response.get('Contact', {})
            wisdom_info = contact.get('WisdomInfo', {})
            session_arn = wisdom_info.get('SessionArn', '')

            if session_arn:
                # Extract session ID (last part of ARN)
                # ARN format: arn:aws:wisdom:region:account:assistant/assistant-id/session/session-id
                session_id = session_arn.split('/')[-1]
                logger.info(f"Found session ID: {session_id} (attempt {attempt + 1})")
                return session_id

            # Session ARN not available yet - retry with exponential backoff
            if attempt < max_retries - 1:
                wait_time = 0.5 * (2 ** attempt)  # 0.5s, 1s, 2s, 4s, 8s
                logger.warning(
                    f"Session ARN not found (attempt {attempt + 1}/{max_retries}), "
                    f"retrying in {wait_time}s..."
                )
                time.sleep(wait_time)

        except Exception as e:
            logger.error(f"Error on attempt {attempt + 1}/{max_retries}: {e}")
            if attempt < max_retries - 1:
                wait_time = 0.5 * (2 ** attempt)
                time.sleep(wait_time)
            else:
                raise

    raise ValueError(
        f"Session ARN not found after {max_retries} attempts. "
        f"Contact may not be associated with Q Connect session."
    )


def update_session_data(assistant_id: str, session_id: str, scenario: dict) -> dict:
    """
    Update Q Connect session with scenario data.

    Injects scenario fields as custom session data that can be referenced
    in AI Agent prompts as {{$.Custom.fieldName}}.

    Args:
        assistant_id: Q Connect Assistant ID
        session_id: Q Connect session ID
        scenario: Scenario dictionary from DynamoDB

    Returns:
        QConnect UpdateSessionData response
    """
    # Build session data - only include non-empty values
    # UpdateSessionData API rejects empty strings
    session_data = []

    # Core scenario fields
    if scenario.get('scenarioId'):
        session_data.append({
            "key": "scenarioId",
            "value": {"stringValue": scenario['scenarioId']}
        })

    if scenario.get('name'):
        session_data.append({
            "key": "name",
            "value": {"stringValue": scenario['name']}
        })

    if scenario.get('context'):
        session_data.append({
            "key": "context",
            "value": {"stringValue": scenario['context']}
        })

    if scenario.get('initial_message'):
        session_data.append({
            "key": "initial_message",
            "value": {"stringValue": scenario['initial_message']}
        })

    if scenario.get('caller_gender'):
        session_data.append({
            "key": "caller_gender",
            "value": {"stringValue": scenario['caller_gender']}
        })

    # JSON-encoded fields (arrays)
    if scenario.get('key_challenges'):
        session_data.append({
            "key": "key_challenges",
            "value": {"stringValue": json.dumps(scenario['key_challenges'])}
        })

    if scenario.get('success_criteria'):
        session_data.append({
            "key": "success_criteria",
            "value": {"stringValue": json.dumps(scenario['success_criteria'])}
        })

    if scenario.get('characters'):
        session_data.append({
            "key": "characters",
            "value": {"stringValue": json.dumps(scenario['characters'])}
        })

    logger.info(f"Updating session {session_id} with {len(session_data)} data fields")

    # Retry logic for eventual consistency - session ARN may be available
    # in Connect before Q Connect backend has fully initialized the session
    max_retries = 5
    for attempt in range(max_retries):
        try:
            response = qconnect.update_session_data(
                assistantId=assistant_id,
                sessionId=session_id,
                data=session_data
            )
            logger.info(f"Successfully updated session {session_id}")
            return response

        except qconnect.exceptions.ResourceNotFoundException as e:
            if attempt < max_retries - 1:
                wait_time = 0.5 * (2 ** attempt)  # 0.5s, 1s, 2s, 4s, 8s
                logger.warning(
                    f"Session not ready yet (attempt {attempt + 1}/{max_retries}), "
                    f"retrying in {wait_time}s... Error: {e}"
                )
                time.sleep(wait_time)
            else:
                logger.error(f"Session {session_id} not found after {max_retries} attempts")
                raise


def handler(event, context):
    """
    Lambda handler invoked by Connect contact flow.

    Expected event structure from Connect:
    {
        "Details": {
            "ContactData": {
                "ContactId": "...",
                "Attributes": {
                    "scenario_id": "..."
                }
            }
        }
    }

    Returns:
        {
            "status": "success",
            "sessionId": "...",
            "scenarioId": "..."
        }
    """
    try:
        logger.info(f"Received event: {json.dumps(event)}")

        # Extract parameters from Connect event
        contact_data = event.get('Details', {}).get('ContactData', {})
        contact_id = contact_data.get('ContactId')
        attributes = contact_data.get('Attributes', {})
        scenario_id = attributes.get('scenario_id')

        if not contact_id:
            raise ValueError("ContactId not found in event")

        if not scenario_id:
            raise ValueError("scenario_id not found in contact attributes")

        logger.info(f"Processing contact {contact_id} with scenario {scenario_id}")

        # Get environment variables
        assistant_id = os.environ.get('ASSISTANT_ID')
        if not assistant_id:
            raise ValueError("ASSISTANT_ID environment variable not set")

        # Step 1: Get session ID from Connect contact (with retry logic)
        session_id = get_session_id_from_contact(contact_id, max_retries=5)

        # Step 2: Load scenario from DynamoDB
        scenario = load_scenario(scenario_id)
        logger.info(f"Loaded scenario: {scenario.get('name')}")

        # Step 3: Update Q Connect session with scenario data
        update_response = update_session_data(assistant_id, session_id, scenario)
        logger.info(f"UpdateSessionData response: {json.dumps(update_response, default=str)}")

        return {
            "status": "success",
            "sessionId": session_id,
            "scenarioId": scenario_id,
            "scenarioName": scenario.get('name')
        }

    except Exception as e:
        logger.error(f"Error in session setup: {e}", exc_info=True)
        return {
            "status": "error",
            "error": str(e)
        }
