"""
Call scorecard models and scoring logic.

Provides:
- EVALUATION_SCHEMA: JSON schema for Bedrock structured output (AI evaluation)
- build_scorecard(): Convert AI evaluation dict + rubric config -> scored scorecard dict
- format_scorecard_response(): Format scorecard dict for API/frontend consumption
- CriticalityLevel: Enum for criterion criticality
- SCORING_CONFIG: Lazy-loaded rubric from JSON
"""

from enum import Enum
from typing import Dict, List, Optional
from datetime import datetime


# ============================================================================
# CRITICALITY ENUM (stdlib, no pydantic)
# ============================================================================

class CriticalityLevel(str, Enum):
    """Whether a criterion is critical or non-critical."""
    CRITICAL = "Critical"
    NON_CRITICAL = "Non-Critical"


# ============================================================================
# EVALUATION SCHEMA (for Bedrock structured output)
# ============================================================================
# Hand-crafted to be Bedrock-compatible:
# - No anyOf (which pydantic v2 generates for Optional fields)
# - additionalProperties: false on all objects
# - Optional fields simply omitted from required arrays

EVALUATION_SCHEMA = {
    "type": "object",
    "properties": {
        "sections": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "section_id": {"type": "string", "description": "Section identifier (e.g., '1', '2', '4')"},
                    "section_name": {"type": "string", "description": "Name of the section"},
                    "criteria": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "criterion_id": {"type": "string", "description": "Criterion identifier (e.g., '1.1.1', '2.3')"},
                                "description": {"type": "string", "description": "What is being evaluated"},
                                "passed": {"type": "boolean", "description": "Whether the criterion was met (true=Pass, false=Fail)"},
                                "score": {"type": "number", "description": "Score from 0.0 to max points for non-critical criteria"},
                                "reasoning": {"type": "string", "description": "Evidence and reasoning for the evaluation"},
                            },
                            "required": ["criterion_id", "description", "passed"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["section_id", "section_name", "criteria"],
                "additionalProperties": False,
            },
        },
        "overall_comments": {"type": "string", "description": "General comments about the call"},
    },
    "required": ["sections"],
    "additionalProperties": False,
}


# ============================================================================
# SCORING FUNCTIONS
# ============================================================================

def _calculate_criterion_points(
    passed: bool,
    criticality: CriticalityLevel,
    max_points: float,
    ai_score: Optional[float],
) -> float:
    """Calculate points for a single criterion based on criticality and pass/fail."""
    if criticality == CriticalityLevel.CRITICAL:
        # Critical: binary pass/fail - full points or zero
        return max_points if passed else 0.0
    else:
        # Non-critical: use AI-assigned score if available, clamped to [0, max_points]
        if ai_score is not None:
            return max(0.0, min(ai_score, max_points))
        return max_points if passed else 0.0


def build_scorecard(evaluation_data: dict, scoring_config: dict) -> dict:
    """
    Convert AI evaluation dict + rubric config into a fully scored scorecard dict.

    Parameters
    ----------
    evaluation_data : dict
        Raw AI evaluation response matching EVALUATION_SCHEMA.
    scoring_config : dict
        Loaded rubric config (keyed by section ID, as returned by load_rubric()).

    Returns
    -------
    dict
        Scored scorecard with keys: sections, final_score, total_possible_score,
        percentage_score, critical_failures, passed, general_comments.
    """
    scored_sections = []

    for eval_section in evaluation_data.get("sections", []):
        section_id = eval_section["section_id"]
        section_config = scoring_config.get(section_id, {})
        criteria_config = section_config.get("criteria", {})

        scored_criteria = []
        for eval_criterion in eval_section.get("criteria", []):
            criterion_id = eval_criterion["criterion_id"]
            criterion_config = criteria_config.get(criterion_id, {})

            criticality = criterion_config.get("criticality", CriticalityLevel.NON_CRITICAL)
            max_points = criterion_config.get("max_points", 1.0)

            points_awarded = _calculate_criterion_points(
                passed=eval_criterion["passed"],
                criticality=criticality,
                max_points=max_points,
                ai_score=eval_criterion.get("score"),
            )

            scored_criteria.append({
                "criterion_id": criterion_id,
                "description": eval_criterion["description"],
                "criticality": criticality,
                "max_points": max_points,
                "passed": eval_criterion["passed"],
                "points_awarded": points_awarded,
                "ai_score": eval_criterion.get("score"),
                "comments": eval_criterion.get("reasoning"),
                "source": criterion_config.get("source", "Transcript"),
            })

        section_score = sum(c["points_awarded"] for c in scored_criteria)
        max_score = sum(c["max_points"] for c in scored_criteria)

        scored_sections.append({
            "section_id": section_id,
            "section_name": eval_section["section_name"],
            "section_description": section_config.get("description"),
            "criteria": scored_criteria,
            "section_score": section_score,
            "max_score": max_score,
        })

    # Calculate totals
    final_score = sum(s["section_score"] for s in scored_sections)
    total_possible_score = sum(s["max_score"] for s in scored_sections)
    percentage_score = (final_score / total_possible_score * 100) if total_possible_score > 0 else 0.0

    # Check for critical failures
    critical_failures = [
        c["criterion_id"]
        for s in scored_sections
        for c in s["criteria"]
        if c["criticality"] == CriticalityLevel.CRITICAL and not c["passed"]
    ]

    return {
        "sections": scored_sections,
        "final_score": final_score,
        "total_possible_score": total_possible_score,
        "percentage_score": percentage_score,
        "critical_failures": critical_failures,
        "passed": len(critical_failures) == 0,
        "general_comments": evaluation_data.get("overall_comments"),
    }


def format_scorecard_response(scorecard: dict) -> dict:
    """
    Format scorecard dict for API/frontend consumption.

    Returns a dict compatible with the frontend ScorecardResponse interface:
    - Flat criteria map keyed by criterion_id
    - Section summaries
    - Top-level score fields
    """
    criteria_map = {}
    for section in scorecard["sections"]:
        for criterion in section["criteria"]:
            criticality = criterion["criticality"]
            # Convert enum to string value if needed
            if isinstance(criticality, CriticalityLevel):
                criticality = criticality.value

            criteria_map[criterion["criterion_id"]] = {
                "description": criterion["description"],
                "criticality": criticality,
                "passed": criterion["passed"],
                "score": criterion["points_awarded"],
                "max_points": criterion["max_points"],
                "comments": criterion.get("comments") or "",
            }

    return {
        "final_score": scorecard["final_score"],
        "total_possible_score": scorecard["total_possible_score"],
        "percentage_score": scorecard["percentage_score"],
        "passed": scorecard["passed"],
        "critical_failures": scorecard["critical_failures"],
        "evaluation_timestamp": datetime.now().isoformat(),
        "sections": [
            {
                "section_id": section["section_id"],
                "section_name": section["section_name"],
                "section_score": section["section_score"],
                "max_score": section["max_score"],
            }
            for section in scorecard["sections"]
        ],
        "criteria": criteria_map,
        "general_comments": scorecard.get("general_comments"),
    }


# ============================================================================
# SCORING CONFIGURATION (rubric) - loaded from rubrics/default.json
# ============================================================================

def _load_default_scoring_config() -> dict:
    """Lazy-load the default rubric from JSON on first access."""
    from src.models.rubric_loader import load_rubric
    return load_rubric()


class _LazyScoringConfig:
    """Proxy that loads the rubric JSON on first attribute access."""

    def __init__(self):
        self._config = None

    def _ensure_loaded(self):
        if self._config is None:
            self._config = _load_default_scoring_config()

    def __getitem__(self, key):
        self._ensure_loaded()
        return self._config[key]

    def __iter__(self):
        self._ensure_loaded()
        return iter(self._config)

    def __len__(self):
        self._ensure_loaded()
        return len(self._config)

    def __contains__(self, key):
        self._ensure_loaded()
        return key in self._config

    def items(self):
        self._ensure_loaded()
        return self._config.items()

    def keys(self):
        self._ensure_loaded()
        return self._config.keys()

    def values(self):
        self._ensure_loaded()
        return self._config.values()

    def get(self, key, default=None):
        self._ensure_loaded()
        return self._config.get(key, default)


SCORING_CONFIG = _LazyScoringConfig()
