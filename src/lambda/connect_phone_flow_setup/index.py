"""
Custom Resource handler that associates a Connect phone number with the built-in
"Sample inbound flow (first contact experience)" contact flow.

Combines the list + associate calls into a single Lambda so we don't run into
CFN's 4KB custom-resource response limit (ListContactFlows on a fresh instance
returns 20+ sample flows, which exceeds the limit when using AwsCustomResource).

ResourceProperties:
  InstanceId      — Connect instance UUID
  PhoneNumberId   — Connect phone number UUID
  FlowName        — name of the contact flow to look up (default: sample inbound)
"""

import json
import logging
import os
import boto3
from botocore.config import Config

logger = logging.getLogger()
logger.setLevel(logging.INFO)

DEFAULT_FLOW_NAME = 'Sample queue customer'

# Marker appended to the User-Agent header so AWS can attribute service API usage
# to this solution. Set by CDK from the `Solution` CloudFormation mapping.
SOLUTION_USER_AGENT = os.environ.get('USER_AGENT_STRING', '')


def boto_config(**kwargs) -> Config:
    """Return a botocore Config carrying the solution User-Agent marker."""
    if SOLUTION_USER_AGENT:
        kwargs['user_agent_extra'] = SOLUTION_USER_AGENT
    return Config(**kwargs)


def find_flow_id_by_name(connect_client, instance_id, flow_name):
    paginator = connect_client.get_paginator('list_contact_flows')
    for page in paginator.paginate(InstanceId=instance_id, ContactFlowTypes=['CONTACT_FLOW']):
        for flow in page.get('ContactFlowSummaryList', []):
            if flow.get('Name') == flow_name:
                return flow.get('Id')
    return None


def handle_create_or_update(props):
    connect_client = boto3.client('connect', config=boto_config())
    instance_id = props['InstanceId']
    phone_number_id = props['PhoneNumberId']
    flow_name = props.get('FlowName', DEFAULT_FLOW_NAME)

    flow_id = find_flow_id_by_name(connect_client, instance_id, flow_name)
    if not flow_id:
        raise RuntimeError(f'Contact flow not found by name: {flow_name}')

    connect_client.associate_phone_number_contact_flow(
        PhoneNumberId=phone_number_id,
        InstanceId=instance_id,
        ContactFlowId=flow_id,
    )
    return {
        'FlowId': flow_id,
        'FlowName': flow_name,
        'PhoneNumberId': phone_number_id,
    }


def handle_delete(props):
    # Disassociation is best-effort; phone number may already be released.
    connect_client = boto3.client('connect', config=boto_config())
    instance_id = props['InstanceId']
    phone_number_id = props['PhoneNumberId']
    try:
        connect_client.disassociate_phone_number_contact_flow(
            PhoneNumberId=phone_number_id,
            InstanceId=instance_id,
        )
    except Exception as e:
        logger.warning(f'Disassociate phone flow failed (non-fatal): {e}')
    return {}


def handler(event, context):
    logger.info(f'Event: {json.dumps(event, default=str)}')
    request_type = event.get('RequestType', '')
    phys_id = event.get('PhysicalResourceId') or f'phone-flow-{context.aws_request_id}'
    props = event.get('ResourceProperties', {})
    if request_type in ('Create', 'Update'):
        data = handle_create_or_update(props)
    elif request_type == 'Delete':
        data = handle_delete(props)
    else:
        raise ValueError(f'Unknown RequestType: {request_type}')
    return {'PhysicalResourceId': phys_id, 'Data': data}
