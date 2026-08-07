"""Custom User-Agent configuration for AWS SDK calls.

AWS collects service API usage for this solution via a marker appended to the
User-Agent header. The marker is set by CDK as the USER_AGENT_STRING environment
variable (from the `Solution` CloudFormation mapping); when it is absent — local
development, tests — clients are created with default configuration.

Usage:
    import boto3
    from src.config.user_agent import boto_config

    client = boto3.client("s3", config=boto_config())

To extend an existing config, pass its keyword arguments through:

    client = boto3.client("s3", config=boto_config(retries={"max_attempts": 3}))
"""
import os

from botocore.config import Config

#: Set by CDK to "AWSSOLUTION/$solutionId/$solutionVersion". Empty when running locally.
SOLUTION_USER_AGENT = os.getenv("USER_AGENT_STRING", "")


def boto_config(**kwargs) -> Config:
    """Return a botocore Config carrying the solution User-Agent marker.

    Any keyword arguments are passed through to ``Config``, so call sites that
    already need retry or signature settings keep them.
    """
    if SOLUTION_USER_AGENT:
        kwargs["user_agent_extra"] = SOLUTION_USER_AGENT
    return Config(**kwargs)
