"""Centralized model ID configuration.

Model IDs are read from environment variables (set by CDK at deploy time).
Defaults match deployment/config.json so local development works without env vars.
"""
import os

EVALUATION_MODEL_ID = os.getenv("BEDROCK_MODEL_ID", "us.anthropic.claude-sonnet-4-6")

NOVA_SONIC_MODEL_ID = os.getenv("NOVA_SONIC_MODEL_ID", "amazon.nova-2-sonic-v1:0")

NOVA_LITE_MODEL_ID = os.getenv("NOVA_LITE_MODEL_ID", "us.amazon.nova-2-lite-v1:0")
