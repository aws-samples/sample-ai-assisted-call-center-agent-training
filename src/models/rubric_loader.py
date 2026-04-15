"""
Rubric loader — reads scoring rubric from a JSON file and converts it
into the dict format expected by the scoring engine and scorecard models.

The default rubric lives at ``rubrics/default.json`` relative to the
project root.  Override the path by setting the ``RUBRIC_PATH``
environment variable.
"""

import json
import os
from pathlib import Path
from typing import Dict, Optional, Set

from src.models.call_scorecard import CriticalityLevel


def _resolve_default_path() -> Path:
    """Return the default rubric JSON path, checking common deployment layouts."""
    # Check env var first
    env_path = os.environ.get("RUBRIC_PATH")
    if env_path:
        return Path(env_path)

    # Lambda task root (Docker or ZIP deployment)
    task_root = os.environ.get("LAMBDA_TASK_ROOT")
    if task_root:
        candidate = Path(task_root) / "rubrics" / "default.json"
        if candidate.exists():
            return candidate

    # Development: relative to project root (walk up from this file)
    project_root = Path(__file__).resolve().parent.parent.parent
    return project_root / "rubrics" / "default.json"


def load_rubric(path: Optional[str] = None) -> Dict:
    """
    Load a scoring rubric from JSON and return a dict whose shape matches
    ``SCORING_CONFIG``.

    Each criterion's ``"criticality"`` string (``"Critical"`` /
    ``"Non-Critical"``) is converted to the corresponding
    :class:`CriticalityLevel` enum so downstream code works unchanged.

    Parameters
    ----------
    path : str | None
        Explicit path to a rubric JSON file.  When *None*, the default
        resolution order is used (``RUBRIC_PATH`` env var → Lambda task
        root → project ``rubrics/default.json``).

    Returns
    -------
    dict
        Scoring config dict keyed by section ID.
    """
    rubric_path = Path(path) if path else _resolve_default_path()

    with open(rubric_path, "r", encoding="utf-8") as fh:
        data = json.load(fh)

    sections = data.get("sections", data)

    # Convert criticality strings → CriticalityLevel enums
    criticality_map = {
        "Critical": CriticalityLevel.CRITICAL,
        "Non-Critical": CriticalityLevel.NON_CRITICAL,
    }

    for section in sections.values():
        for criterion in section.get("criteria", {}).values():
            raw = criterion.get("criticality", "Non-Critical")
            criterion["criticality"] = criticality_map.get(raw, CriticalityLevel.NON_CRITICAL)

    return sections


def load_rubric_raw(path: Optional[str] = None) -> Dict:
    """
    Load a scoring rubric from JSON without enum conversion.

    Useful for contexts that need plain strings (e.g. the admin Lambda
    returning JSON to the UI).

    Parameters
    ----------
    path : str | None
        Explicit path to a rubric JSON file.

    Returns
    -------
    dict
        Full rubric dict as stored in JSON (includes ``name``, ``version``,
        ``sections``).
    """
    rubric_path = Path(path) if path else _resolve_default_path()

    with open(rubric_path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def get_all_criterion_ids(scoring_config: Dict) -> Set[str]:
    """
    Extract every criterion ID from a loaded scoring config.

    Parameters
    ----------
    scoring_config : dict
        A scoring config dict (as returned by :func:`load_rubric`).

    Returns
    -------
    set[str]
        Set of all criterion IDs (e.g. ``{"1.1.1", "1.1.2", ...}``).
    """
    ids: Set[str] = set()
    for section in scoring_config.values():
        ids.update(section.get("criteria", {}).keys())
    return ids
