"""Tool for verifying spelling of text read back by the call center agent."""

import logging
import os

import boto3
from strands.tools.decorator import tool

from src.config.models import NOVA_LITE_MODEL_ID

logger = logging.getLogger(__name__)

VERIFICATION_PROMPT = """You are verifying if text read back by a call center agent matches the original.

Original (correct) text: {original_text}
What was read back: {spoken_text}

Step 1: The read-back text may be in phonetic alphabet format (e.g., "a as in apple, n as in november"). If so, decode it by extracting the first letter from each phonetic phrase:
- "a as in apple" → a
- "m as in mark" → m
- "n as in november" → n
- "at sign" or "at" → @
- "dot" → .
Reconstruct the full plain text from the decoded letters and symbols.

Step 2: Compare the decoded plain text against the original, character by character.
- Ignore differences in capitalization.
- Ignore spacing differences around symbols like @ and periods.
- Every letter, number, and symbol must match exactly otherwise.

Step 3: Respond with ONLY one of these formats:
- If they match: MATCH: The text is correct.
- If they differ: MISMATCH: [explain what differs, e.g. "they said 'm as in mark' for the 2nd letter but it should be 'n' — the correct spelling is 'anna' not 'amna'"]

Respond with ONLY the MATCH or MISMATCH line, nothing else."""


@tool
def verify_spelling(original_text: str, spoken_text: str) -> str:
    """Verify if text read back by the agent matches the original.

    Use this tool when the call center agent reads back an email address,
    name, policy number, mailing address, or any other detail to you for
    verification. Compare what they said against what you know is correct.

    Args:
        original_text: The correct text you know (e.g., your email address).
        spoken_text: What the agent said back to you.

    Returns:
        Whether the text matches, and what specifically is wrong if it doesn't.
    """
    logger.info(f"verify_spelling: original='{original_text}' spoken='{spoken_text}'")

    try:
        region = os.getenv("AWS_REGION", os.getenv("AWS_DEFAULT_REGION", "us-west-2"))
        client = boto3.client("bedrock-runtime", region_name=region)

        prompt = VERIFICATION_PROMPT.format(
            original_text=original_text,
            spoken_text=spoken_text,
        )

        response = client.converse(
            modelId=NOVA_LITE_MODEL_ID,
            messages=[{"role": "user", "content": [{"text": prompt}]}],
            inferenceConfig={"maxTokens": 150},
        )

        verification = response["output"]["message"]["content"][0]["text"]

        logger.info(f"verify_spelling result: {verification}")
        return verification

    except Exception as e:
        logger.error(f"verify_spelling error: {e}", exc_info=True)
        return f"ERROR: Could not verify spelling. Compare manually: original is '{original_text}', they said '{spoken_text}'."
