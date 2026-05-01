"""
Custom Resource handler for Connect agent user creation.

Creates a Connect-native agent user for CCP softphone login on stack create,
deletes it on stack delete. Looks up the default Admin security profile and
Basic Routing Profile so no extra parameters are needed.

ResourceProperties:
  InstanceId       — Connect instance UUID
  Username         — user name to create
  PasswordSecretArn — Secrets Manager secret ARN holding the password
  Email            — email for IdentityInfo
  FirstName, LastName — identity fields (optional)
"""

import json
import logging
import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def find_profile_id(connect_client, instance_id, kind, name):
    """kind = 'routing' or 'security'"""
    if kind == 'routing':
        paginator = connect_client.get_paginator('list_routing_profiles')
        key = 'RoutingProfileSummaryList'
    else:
        paginator = connect_client.get_paginator('list_security_profiles')
        key = 'SecurityProfileSummaryList'
    target = name.lower()
    for page in paginator.paginate(InstanceId=instance_id):
        for profile in page.get(key, []):
            if profile['Name'].lower() == target:
                return profile['Id']
    return None


def find_user_id(connect_client, instance_id, username):
    paginator = connect_client.get_paginator('list_users')
    for page in paginator.paginate(InstanceId=instance_id):
        for user in page.get('UserSummaryList', []):
            if user['Username'] == username:
                return user['Id']
    return None


def handle_create_or_update(props):
    connect_client = boto3.client('connect')
    secrets_client = boto3.client('secretsmanager')

    instance_id = props['InstanceId']
    username = props['Username']
    secret_arn = props['PasswordSecretArn']
    email = props.get('Email', f'agent-{instance_id}@example.com')
    first_name = props.get('FirstName', 'Training')
    last_name = props.get('LastName', 'Agent')

    existing = find_user_id(connect_client, instance_id, username)
    if existing:
        logger.info(f'User {username} already exists ({existing}); reusing')
        return {
            'UserId': existing,
            'Username': username,
            'PasswordSecretArn': secret_arn,
        }

    password = secrets_client.get_secret_value(SecretId=secret_arn)['SecretString']

    routing_profile_id = find_profile_id(connect_client, instance_id, 'routing', 'basic routing profile')
    security_profile_id = find_profile_id(connect_client, instance_id, 'security', 'admin')
    if not routing_profile_id or not security_profile_id:
        raise RuntimeError(
            f'Default profiles not found (routing={routing_profile_id}, security={security_profile_id})',
        )

    resp = connect_client.create_user(
        Username=username,
        Password=password,
        IdentityInfo={'FirstName': first_name, 'LastName': last_name, 'Email': email},
        PhoneConfig={'PhoneType': 'SOFT_PHONE', 'AutoAccept': False, 'AfterContactWorkTimeLimit': 60},
        SecurityProfileIds=[security_profile_id],
        RoutingProfileId=routing_profile_id,
        InstanceId=instance_id,
    )
    logger.info(f'Created user {username} ({resp["UserId"]})')
    return {
        'UserId': resp['UserId'],
        'UserArn': resp['UserArn'],
        'Username': username,
        'PasswordSecretArn': secret_arn,
    }


def handle_delete(props):
    connect_client = boto3.client('connect')
    instance_id = props['InstanceId']
    username = props['Username']
    existing = find_user_id(connect_client, instance_id, username)
    if existing:
        try:
            connect_client.delete_user(InstanceId=instance_id, UserId=existing)
            logger.info(f'Deleted user {username}')
        except Exception as e:
            logger.warning(f'Delete user {username} failed: {e}')
    return {}


def handler(event, context):
    """Provider framework handler — return a dict with PhysicalResourceId and Data."""
    logger.info(f'Event: {json.dumps(event, default=str)}')
    request_type = event.get('RequestType', '')
    phys_id = event.get('PhysicalResourceId') or f'connect-agent-user-{context.aws_request_id}'

    props = event.get('ResourceProperties', {})
    if request_type in ('Create', 'Update'):
        data = handle_create_or_update(props)
    elif request_type == 'Delete':
        data = handle_delete(props)
    else:
        raise ValueError(f'Unknown RequestType: {request_type}')

    return {
        'PhysicalResourceId': phys_id,
        'Data': data,
    }
