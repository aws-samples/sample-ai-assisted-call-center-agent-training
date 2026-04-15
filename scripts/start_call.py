#!/usr/bin/env python3
"""
Start an outbound training call via Amazon Connect.

Usage:
    python scripts/start_call.py --scenario athene_death_notification_01
    python scripts/start_call.py --scenario athene_loan_01 --voice tiffany
    python scripts/start_call.py --list

Configuration is read from deployment/config.json.
"""

import argparse
import json
import os
import sys
import uuid

import boto3

# ---------------------------------------------------------------------------
# Load configuration from deployment/config.json
# ---------------------------------------------------------------------------
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_config_path = os.path.join(PROJECT_ROOT, 'deployment', 'config.json')
with open(_config_path, 'r', encoding='utf-8') as _f:
    _config = json.load(_f)

_connect = _config['connect']
CONNECT_INSTANCE_ARN = _connect['instanceArn']
CONNECT_INSTANCE_ID = CONNECT_INSTANCE_ARN.split('instance/')[-1]
CONTACT_FLOW_ID = _connect['contactFlowId']
DEFAULT_PHONE = _connect['destinationPhoneNumber']
DEFAULT_VOICE = _connect.get('defaultVoiceId', 'matthew')
REGION = CONNECT_INSTANCE_ARN.split(':')[3]  # extract region from ARN
DEFAULT_PROFILE = None


def get_scenarios_dir():
    """Return the path to the scenarios/ directory relative to project root."""
    return os.path.join(PROJECT_ROOT, 'scenarios')


def list_scenarios():
    """List all available scenario IDs from local JSON files."""
    scenarios_dir = get_scenarios_dir()
    scenarios = []
    for f in sorted(os.listdir(scenarios_dir)):
        if f.endswith('.json'):
            filepath = os.path.join(scenarios_dir, f)
            with open(filepath, 'r', encoding='utf-8') as fh:
                data = json.load(fh)
            sid = data.get('id', os.path.splitext(f)[0])
            name = data.get('name', '')
            gender = data.get('caller_gender', '')
            scenarios.append((sid, name, gender))
    return scenarios


def load_scenario(scenario_id):
    """Load a scenario by ID from the local JSON files."""
    scenarios_dir = get_scenarios_dir()
    # Try exact filename match first
    filepath = os.path.join(scenarios_dir, f'{scenario_id}.json')
    if os.path.exists(filepath):
        with open(filepath, 'r', encoding='utf-8') as f:
            return json.load(f)
    # Fall back to scanning all files for matching id field
    for fname in os.listdir(scenarios_dir):
        if not fname.endswith('.json'):
            continue
        fp = os.path.join(scenarios_dir, fname)
        with open(fp, 'r', encoding='utf-8') as f:
            data = json.load(f)
        if data.get('id') == scenario_id:
            return data
    return None



def resolve_queue_id(client):
    """Get the first STANDARD queue ID."""
    paginator = client.get_paginator('list_queues')
    for page in paginator.paginate(InstanceId=CONNECT_INSTANCE_ID, QueueTypes=['STANDARD']):
        for q in page.get('QueueSummaryList', []):
            return q['Id']
    return None


def main():
    parser = argparse.ArgumentParser(description='Start an outbound training call via Amazon Connect')
    parser.add_argument('--scenario', help='Scenario ID (e.g. athene_death_notification_01)')
    parser.add_argument('--phone', default=DEFAULT_PHONE, help=f'Destination phone number (default: {DEFAULT_PHONE})')
    parser.add_argument('--voice', default=DEFAULT_VOICE, choices=['matthew', 'tiffany', 'amy'],
                        help=f'AI voice ID (default: {DEFAULT_VOICE})')
    parser.add_argument('--source-phone', help='Outbound caller ID phone number claimed in Connect (E.164 format)')
    parser.add_argument('--flow-id', default=CONTACT_FLOW_ID, help=f'Contact flow ID (default: {CONTACT_FLOW_ID})')
    parser.add_argument('--profile', default=DEFAULT_PROFILE, help='AWS profile (default: uses AWS credential chain)')
    parser.add_argument('--list', action='store_true', help='List available scenarios and exit')
    args = parser.parse_args()

    if args.list:
        scenarios = list_scenarios()
        print(f'Available scenarios ({len(scenarios)}):')
        print()
        for sid, name, gender in scenarios:
            voice_hint = f'  [{gender}]' if gender else ''
            print(f'  {sid:<50s} {name}{voice_hint}')
        return

    if not args.scenario:
        parser.error('--scenario is required (use --list to see available scenarios)')

    # Load scenario
    scenario = load_scenario(args.scenario)
    if not scenario:
        print(f'Error: scenario not found: {args.scenario}', file=sys.stderr)
        print('Use --list to see available scenarios', file=sys.stderr)
        sys.exit(1)

    print(f'Scenario:  {scenario.get("name", args.scenario)}')
    print(f'Phone:     {args.phone}')
    print(f'Voice:     {args.voice}')
    print(f'Profile:   {args.profile}')
    print()

    # Create boto3 session with profile
    session = boto3.Session(profile_name=args.profile, region_name=REGION)
    client = session.client('connect')

    contact_flow_id = args.flow_id
    print(f'Contact flow ID: {contact_flow_id}')

    # Resolve queue ID
    print('Resolving queue...')
    queue_id = resolve_queue_id(client)
    if not queue_id:
        print(f'Error: no STANDARD queue found in instance {CONNECT_INSTANCE_ID}', file=sys.stderr)
        sys.exit(1)
    print(f'  Queue ID: {queue_id}')

    # Start the call
    session_id = str(uuid.uuid4())
    attributes = {
        'scenario_id': args.scenario,
        'scenario_name': scenario.get('name', ''),
        'voice_id': args.voice,
        'training_session_id': session_id,
    }

    print()
    print('Starting outbound call...')
    call_params = {
        'DestinationPhoneNumber': args.phone,
        'ContactFlowId': contact_flow_id,
        'InstanceId': CONNECT_INSTANCE_ID,
        'QueueId': queue_id,
        'Attributes': attributes,
        # 'RelatedContactId': '1234',
        'References': { 'string' : {'Value': 'm@yahoo.com', 'Type': 'EMAIL'}},
    #     'AnswerMachineDetectionConfig': {
    #         'EnableAnswerMachineDetection': True,
    #         'AwaitAnswerMachinePrompt': True|False
    #   },
    }
    if args.source_phone:
        call_params['SourcePhoneNumber'] = args.source_phone
    print(call_params)
    resp = client.start_outbound_voice_contact(**call_params)

    contact_id = resp.get('ContactId')
    print()
    print(f'Call started successfully!')
    print(f'  Contact ID:  {contact_id}')
    print(f'  Session ID:  {session_id}')


if __name__ == '__main__':
    main()
