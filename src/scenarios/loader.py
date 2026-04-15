"""Scenario loader for training sessions"""
import json
import logging
from typing import Any, Dict, List, Optional
from pathlib import Path
from dataclasses import dataclass
from decimal import Decimal

logger = logging.getLogger(__name__)


@dataclass
class Character:
    """Represents a character in a multi-character scenario"""
    id: str
    name: str
    voice: str
    gender: str
    is_primary: bool
    context: str
    initial_message: str = ""
    handoff_trigger: str = ""
    handoff_to: str = ""


@dataclass
class Scenario:
    """Represents a training scenario"""
    scenario_id: str
    name: str
    context: str
    key_challenges: List[str]
    success_criteria: List[str]
    difficulty: str = "intermediate"
    original_call_logs: str = ""
    initial_message: str = ""
    caller_gender: str = ""
    characters: Optional[List[Character]] = None

    @property
    def is_duo(self) -> bool:
        return self.characters is not None and len(self.characters) > 1


def _decimal_to_native(obj):
    """Recursively convert DynamoDB Decimal types to int/float."""
    if isinstance(obj, Decimal):
        return int(obj) if obj == int(obj) else float(obj)
    if isinstance(obj, dict):
        return {k: _decimal_to_native(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_decimal_to_native(i) for i in obj]
    return obj


class ScenarioLoader:
    """Loads and manages training scenarios from JSON files or DynamoDB"""

    def __init__(self, scenarios_dir: str = "scenarios"):
        self.scenarios_dir = Path(scenarios_dir)
        self.scenarios: Dict[str, Scenario] = {}

    def load_all_scenarios(self) -> Dict[str, Scenario]:
        """Load all scenarios from the scenarios directory (local development)."""
        if not self.scenarios_dir.exists():
            raise FileNotFoundError(f"Scenarios directory not found: {self.scenarios_dir}")

        for file_path in self.scenarios_dir.glob("*.json"):
            scenario = self._parse_json_file(file_path)
            self.scenarios[scenario.scenario_id] = scenario

        return self.scenarios

    def load_from_dynamodb(self, table_name: str, region: str = '') -> Dict[str, Scenario]:
        """Load all scenarios from a DynamoDB table.

        Args:
            table_name: Name of the DynamoDB scenarios table.
            region: AWS region. Falls back to AWS_REGION or AWS_DEFAULT_REGION env vars.

        Returns:
            Dict mapping scenario_id to Scenario objects.
        """
        import os
        import boto3

        region = region or os.getenv('AWS_REGION') or os.getenv('AWS_DEFAULT_REGION') or 'us-west-2'
        dynamodb = boto3.resource('dynamodb', region_name=region)
        table = dynamodb.Table(table_name)

        items = []
        response = table.scan()
        items.extend(response.get('Items', []))

        while 'LastEvaluatedKey' in response:
            response = table.scan(ExclusiveStartKey=response['LastEvaluatedKey'])
            items.extend(response.get('Items', []))

        for item in items:
            item = _decimal_to_native(item)
            scenario = self._parse_dynamo_item(item)
            self.scenarios[scenario.scenario_id] = scenario

        logger.info(f"Loaded {len(items)} scenarios from DynamoDB table '{table_name}'")
        return self.scenarios

    def load_single_from_dynamodb(self, table_name: str, scenario_id: str, region: str = '') -> Optional[Scenario]:
        """Fetch a single scenario from DynamoDB by ID and update the cache."""
        import os
        import boto3

        region = region or os.getenv('AWS_REGION') or os.getenv('AWS_DEFAULT_REGION') or 'us-west-2'
        dynamodb = boto3.resource('dynamodb', region_name=region)
        table = dynamodb.Table(table_name)

        response = table.get_item(Key={'scenarioId': scenario_id})
        item = response.get('Item')
        if not item:
            return None

        item = _decimal_to_native(item)
        scenario = self._parse_dynamo_item(item)
        self.scenarios[scenario.scenario_id] = scenario
        return scenario

    def get_scenario(self, scenario_id: str) -> Optional[Scenario]:
        """Get a specific scenario by ID"""
        return self.scenarios.get(scenario_id)

    def list_scenarios(self) -> List[Dict]:
        """List all available scenarios with basic info"""
        result = []
        for s in self.scenarios.values():
            entry: Dict = {
                "id": s.scenario_id,
                "name": s.name,
                "context": s.context,
            }
            if s.characters:
                entry["characters"] = [
                    {
                        "id": c.id,
                        "name": c.name,
                        "voice": c.voice,
                        "gender": c.gender,
                        "is_primary": c.is_primary,
                    }
                    for c in s.characters
                ]
            result.append(entry)
        return result

    @staticmethod
    def _parse_characters(raw: Any) -> Optional[List[Character]]:
        """Parse characters list from JSON or DynamoDB data."""
        if not raw or not isinstance(raw, list):
            return None
        characters = []
        for c in raw:
            characters.append(Character(
                id=c.get('id', ''),
                name=c.get('name', ''),
                voice=c.get('voice', 'matthew'),
                gender=c.get('gender', ''),
                is_primary=c.get('is_primary', False),
                context=c.get('context', ''),
                initial_message=c.get('initial_message', ''),
                handoff_trigger=c.get('handoff_trigger', ''),
                handoff_to=c.get('handoff_to', ''),
            ))
        return characters if characters else None

    def _parse_dynamo_item(self, item: dict) -> Scenario:
        """Parse a DynamoDB item into a Scenario."""
        return Scenario(
            scenario_id=item.get('scenarioId', ''),
            name=item.get('name', ''),
            context=item.get('context', ''),
            key_challenges=item.get('key_challenges', []),
            success_criteria=item.get('success_criteria', []),
            difficulty=item.get('difficulty', 'intermediate'),
            original_call_logs=item.get('original_call_logs', ''),
            initial_message=item.get('initial_message', ''),
            caller_gender=item.get('caller_gender', ''),
            characters=self._parse_characters(item.get('characters')),
        )

    def _parse_json_file(self, file_path: Path) -> Scenario:
        """Parse a JSON scenario file"""
        with open(file_path, 'r', encoding='utf-8') as f:
            data = json.load(f)

        return Scenario(
            scenario_id=data.get('id', file_path.stem),
            name=data.get('name', file_path.stem.replace('_', ' ').title()),
            context=data.get('context', ''),
            key_challenges=data.get('key_challenges', []),
            success_criteria=data.get('success_criteria', []),
            difficulty=data.get('difficulty', 'intermediate'),
            original_call_logs=data.get('original_call_logs', ''),
            initial_message=data.get('initial_message', ''),
            caller_gender=data.get('caller_gender', ''),
            characters=self._parse_characters(data.get('characters')),
        )
