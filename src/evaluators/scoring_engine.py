"""
Scoring engine for evaluating call center training sessions using structured scorecard.
Uses AI to evaluate criteria, then applies scoring rubric.
"""

import json
import logging
import boto3
import os
from pathlib import Path
from typing import Dict, Any, List, Optional
from datetime import datetime

logger = logging.getLogger(__name__)

from src.config.models import EVALUATION_MODEL_ID
from src.recording.session_types import SessionRecording
from src.models.call_scorecard import (
    EVALUATION_SCHEMA,
    build_scorecard,
    format_scorecard_response,
)
from src.models.rubric_loader import load_rubric


class ScoringEngine:
    """Main scoring engine for call center training sessions"""

    def __init__(self, evaluations_dir: str = "/tmp/evaluations", rubric_path: str = None):  # nosec B108
        self.evaluations_dir = Path(evaluations_dir)
        self.evaluations_dir.mkdir(exist_ok=True)
        self._scoring_config = load_rubric(rubric_path)

        # Initialize Bedrock Runtime client for Claude
        self.client = boto3.client(
            'bedrock-runtime',
            region_name=os.environ.get('AWS_REGION', 'us-west-2')
        )

    def _filter_scoring_config(self, enabled_criteria: Optional[set] = None) -> dict:
        """
        Return scoring config filtered to only enabled criteria.
        If enabled_criteria is None, returns full config (all enabled).
        Drops sections that have no enabled criteria.
        """
        if enabled_criteria is None:
            return self._scoring_config

        filtered = {}
        for section_id, section in self._scoring_config.items():
            filtered_criteria = {
                cid: cdef for cid, cdef in section['criteria'].items()
                if cid in enabled_criteria
            }
            if filtered_criteria:
                filtered[section_id] = {
                    **section,
                    'criteria': filtered_criteria,
                }
        return filtered

    async def evaluate_session(
        self,
        session_recording: SessionRecording,
        screen_actions: Optional[List[Dict]] = None,
        enabled_criteria: Optional[set] = None,
        analytics_data: Optional[Dict[str, Any]] = None
    ) -> dict:
        """
        Evaluate a completed training session using call center scorecard.

        Args:
            session_recording: The recorded session to evaluate
            screen_actions: Optional list of screen action summaries from screen capture
            enabled_criteria: Optional set of criterion IDs to include. None means all.
            analytics_data: Optional pre-computed transcript analytics to include in prompt

        Returns:
            Scored scorecard dict
        """
        logger.info("Starting evaluation for session %s", session_recording.session_id)

        # Filter scoring config based on enabled criteria
        scoring_config = self._filter_scoring_config(enabled_criteria)

        # Format transcript
        transcript = self._format_transcript(session_recording)

        # Get AI evaluation using structured output
        logger.info("Requesting AI evaluation")
        evaluation_data = await self._get_ai_evaluation(transcript, session_recording, screen_actions, scoring_config, analytics_data)

        # Extract token usage before building scorecard (not part of evaluation schema)
        scoring_token_usage = evaluation_data.pop('_token_usage', None)

        # Convert to scored scorecard
        logger.info("Calculating scores")
        scorecard = build_scorecard(evaluation_data, scoring_config)

        if scoring_token_usage:
            scorecard['_scoring_token_usage'] = scoring_token_usage

        # Save evaluation and scorecard
        self._save_results(session_recording.session_id, evaluation_data, scorecard)

        logger.info("Evaluation complete! Score: %s/%s", scorecard['final_score'], scorecard['total_possible_score'])
        logger.info("Pass: %s, Critical failures: %d", scorecard['passed'], len(scorecard['critical_failures']))

        return scorecard

    async def _get_ai_evaluation(
        self,
        transcript: str,
        session_recording: SessionRecording,
        screen_actions: Optional[List[Dict]] = None,
        scoring_config: Optional[dict] = None,
        analytics_data: Optional[Dict[str, Any]] = None
    ) -> dict:
        """
        Use Claude to evaluate the call against scorecard criteria.

        Returns:
            Raw evaluation dict matching EVALUATION_SCHEMA
        """
        # Build evaluation prompt
        prompt = self._build_evaluation_prompt(transcript, session_recording, screen_actions, scoring_config, analytics_data)

        logger.info("Calling Claude API for structured evaluation")

        # Call Claude via Bedrock invoke_model with structured output
        request_body = {
            'anthropic_version': 'bedrock-2023-05-31',
            'max_tokens': 8000,
            'temperature': 0,
            'messages': [{'role': 'user', 'content': prompt}],
            'output_config': {
                'format': {
                    'type': 'json_schema',
                    'schema': EVALUATION_SCHEMA
                }
            }
        }

        response = self.client.invoke_model(
            modelId=EVALUATION_MODEL_ID,
            body=json.dumps(request_body),
            contentType='application/json',
            accept='application/json'
        )

        response_body = json.loads(response['body'].read())
        evaluation_data = json.loads(response_body['content'][0]['text'])

        # Extract and log token usage
        usage = response_body.get('usage', {})
        input_tokens = usage.get('input_tokens', 0)
        output_tokens = usage.get('output_tokens', 0)
        logger.info("TOKEN_USAGE component=scoring model=%s input_tokens=%d output_tokens=%d session_id=%s",
                     EVALUATION_MODEL_ID, input_tokens, output_tokens,
                     session_recording.session_id)

        # Attach usage to evaluation data for upstream consumption
        evaluation_data['_token_usage'] = {
            'model': EVALUATION_MODEL_ID,
            'input_tokens': input_tokens,
            'output_tokens': output_tokens,
        }

        return evaluation_data

    def _build_evaluation_prompt(
        self,
        transcript: str,
        session_recording: SessionRecording,
        screen_actions: Optional[List[Dict]] = None,
        scoring_config: Optional[dict] = None,
        analytics_data: Optional[Dict[str, Any]] = None
    ) -> str:
        """Build comprehensive evaluation prompt"""

        # Build criteria descriptions from config
        criteria_text = self._format_criteria_for_prompt(scoring_config)

        # Build screen activity section if available
        screen_activity_text = ""
        if screen_actions:
            lines = ["\n# Screen Activity During Call"]
            lines.append("The trainee's screen was captured during the call. Here is what they were doing:\n")
            for action in screen_actions:
                elapsed = action.get('elapsedSeconds', 0)
                mins = elapsed // 60
                secs = elapsed % 60
                desc = action.get('actionDescription', 'Unknown')
                apps = ', '.join(action.get('visibleApplications', []))
                entry = f"- [{mins:02d}:{secs:02d}] {desc}"
                if apps:
                    entry += f" (Applications: {apps})"
                lines.append(entry)
            lines.append(
                "\nUse the screen activity context to better evaluate whether the agent was "
                "using the correct tools and systems during the call, and whether they were "
                "following proper procedures."
            )
            screen_activity_text = "\n".join(lines)

        # Build analytics context section if available
        analytics_text = ""
        if analytics_data:
            analytics_text = f"""
# Call Analytics (Pre-computed from audio timing)
Use these metrics to inform your evaluation of time management and professionalism criteria:
- Max silence gap: {analytics_data.get('max_silence_gap_seconds', 'N/A')}s (threshold: 20s)
- Silence violations (>20s): {analytics_data.get('silence_violations_count', 0)}
- Hold events detected: {analytics_data.get('hold_count', 0)}
- Hedging/uncertainty phrases: {analytics_data.get('confidence_language_count', 0)}
- Talk-overs: {analytics_data.get('talk_over_count', 0)}
- Avg response time: {analytics_data.get('avg_agent_response_time', 'N/A')}s"""

        prompt = f"""You are evaluating a call center training session transcript against a standardized scorecard.

# Session Information
- Scenario: {session_recording.scenario_name}
- Difficulty: {session_recording.difficulty}
- Customer Mood: {session_recording.customer_mood}

# Call Transcript
{transcript}
{screen_activity_text}
{analytics_text}

# Evaluation Criteria
{criteria_text}

# Your Task
Carefully review the transcript{' and screen activity' if screen_actions else ''} and evaluate each criterion. For each criterion, provide:
1. **passed** (boolean): Did the agent meet this criterion? (true/false)
2. **score** (float, non-critical only): A score from 0.0 to the max points. Partial credit is allowed.
3. **reasoning** (string): Brief explanation with specific evidence from the transcript{' and screen activity' if screen_actions else ''}

Provide your structured evaluation as JSON matching the expected schema.

**Important Guidelines:**
- **Critical criteria**: Set `passed` to true/false. The `score` field is not used — critical criteria are binary (full points or zero).
- **Non-critical criteria**: Set `passed` to true/false AND set `score` to a value from 0.0 to the max points. Partial credit is allowed (e.g., 0.5 out of 1.0 if the criterion was partially met).
- Base your assessment ONLY on evidence in the transcript{' and screen activity observations' if screen_actions else ''}
- Be objective and consistent
- For "if applicable" criteria, mark as passed if not applicable and give full score
- Provide specific examples in your reasoning
"""

        return prompt

    def _format_criteria_for_prompt(self, scoring_config: Optional[dict] = None) -> str:
        """Format scoring criteria for prompt"""
        config = scoring_config or self._scoring_config
        lines = []

        for section_id, section in config.items():
            lines.append(f"\n## Section {section_id}: {section['name']}")
            lines.append(f"{section['description']}\n")

            for criterion_id, criterion in section['criteria'].items():
                criticality = criterion['criticality'].value
                description = criterion['description']
                lines.append(f"**{criterion_id}** [{criticality}] - {description}")

        return "\n".join(lines)

    def _format_transcript(self, session_recording: SessionRecording) -> str:
        """Format transcript for evaluation"""
        lines = []
        for turn in session_recording.transcript:
            speaker_label = turn.speaker.upper()
            lines.append(f"{speaker_label}: {turn.text}")
        return "\n".join(lines)

    def _save_results(
        self,
        session_id: str,
        evaluation: dict,
        scorecard: dict
    ):
        """Save evaluation and scorecard to files"""

        # Save AI evaluation
        eval_path = self.evaluations_dir / f"{session_id}_evaluation.json"
        with open(eval_path, 'w', encoding='utf-8') as f:
            json.dump(evaluation, f, indent=2, ensure_ascii=False)

        # Save scorecard (convert enums to strings for JSON serialization)
        scorecard_path = self.evaluations_dir / f"{session_id}_scorecard.json"
        with open(scorecard_path, 'w', encoding='utf-8') as f:
            json.dump(scorecard, f, indent=2, ensure_ascii=False, default=str)

        logger.info("Results saved to %s", self.evaluations_dir)

    def format_scorecard_summary(self, scorecard: dict) -> Dict[str, Any]:
        """
        Format scorecard for API response (compatible with frontend ScorecardResponse interface).
        """
        return format_scorecard_response(scorecard)
