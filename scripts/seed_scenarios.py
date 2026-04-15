#!/usr/bin/env python3
"""
Seed DynamoDB Scenarios table from existing JSON scenario files.

Usage:
    python scripts/seed_scenarios.py [--table TABLE_NAME] [--region REGION]

Defaults:
    --table  CallCenterTraining-Scenarios
    --region us-west-2
"""

import argparse
import glob
import json
import os
import sys
from decimal import Decimal

import boto3


def json_to_dynamodb(obj):
    """Convert JSON types to DynamoDB-compatible types (Decimal for numbers)."""
    if isinstance(obj, float):
        return Decimal(str(obj))
    if isinstance(obj, dict):
        return {k: json_to_dynamodb(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [json_to_dynamodb(i) for i in obj]
    return obj


def seed_scenarios(table_name: str, region: str, scenarios_dir: str):
    """Load all JSON scenario files and write them to DynamoDB."""
    dynamodb = boto3.resource('dynamodb', region_name=region)
    table = dynamodb.Table(table_name)

    files = sorted(glob.glob(os.path.join(scenarios_dir, '*.json')))
    if not files:
        print(f"No JSON files found in {scenarios_dir}")
        sys.exit(1)

    print(f"Found {len(files)} scenario files in {scenarios_dir}")
    print(f"Target table: {table_name} ({region})")

    success = 0
    for filepath in files:
        filename = os.path.basename(filepath)
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                data = json.load(f)

            scenario_id = data.get('id', os.path.splitext(filename)[0])

            # Build DynamoDB item
            item = {
                'scenarioId': scenario_id,
                'name': data.get('name', ''),
                'context': data.get('context', ''),
                'key_challenges': data.get('key_challenges', []),
                'success_criteria': data.get('success_criteria', []),
                'difficulty': data.get('difficulty', 'intermediate'),
                'initial_message': data.get('initial_message', ''),
                'original_call_logs': data.get('original_call_logs', ''),
                'caller_gender': data.get('caller_gender', ''),
            }

            # Convert any numeric values to Decimal
            item = json_to_dynamodb(item)

            table.put_item(Item=item)
            print(f"  [OK] {scenario_id} ({filename})")
            success += 1

        except Exception as e:
            print(f"  [FAIL] {filename}: {e}")

    print(f"\nDone: {success}/{len(files)} scenarios written to {table_name}")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Seed DynamoDB Scenarios table from JSON files')
    parser.add_argument('--table', default='CallCenterTraining-Scenarios',
                        help='DynamoDB table name (default: CallCenterTraining-Scenarios)')
    parser.add_argument('--region', default='us-west-2',
                        help='AWS region (default: us-west-2)')
    parser.add_argument('--scenarios-dir', default=None,
                        help='Path to scenarios directory (default: scenarios/ relative to project root)')
    args = parser.parse_args()

    # Resolve scenarios directory
    if args.scenarios_dir:
        scenarios_dir = args.scenarios_dir
    else:
        project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        scenarios_dir = os.path.join(project_root, 'scenarios')

    seed_scenarios(args.table, args.region, scenarios_dir)
