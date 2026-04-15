# AgentCore Dockerfile for Call Center Training Agent
# Uses Python 3.13 with uv for fast dependency installation

FROM ghcr.io/astral-sh/uv:python3.13-bookworm

# Set working directory
WORKDIR /app

# Set environment variables
ENV PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app \
    UV_SYSTEM_PYTHON=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_NO_PROGRESS=1 \
    DOCKER_CONTAINER=1

# Install system dependencies (portaudio19-dev required by pyaudio, a transitive dep of strands-agents[bidi])
RUN apt-get update && apt-get install -y --no-install-recommends \
    portaudio19-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements file
COPY requirements.txt /app/

# Install Python dependencies with uv
RUN uv pip install -r requirements.txt && \
    uv pip install aws-opentelemetry-distro>=0.12.2

# Copy only the source modules needed by the agent (excludes lambda/, evaluators/, models/)
COPY src/__init__.py /app/src/
COPY src/agent/ /app/src/agent/
COPY src/config/ /app/src/config/
COPY src/scenarios/ /app/src/scenarios/
COPY src/recording/ /app/src/recording/
COPY src/customer_prompt.py /app/src/customer_prompt.py
COPY src/voices.py /app/src/voices.py

# Switch to non-root user (required by AgentCore)
RUN useradd -m -u 1000 bedrock_agentcore
USER bedrock_agentcore

# Expose port for AgentCore protocol
EXPOSE 8080

# Health check for container orchestration
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

# Entry point for Bedrock AgentCore with OpenTelemetry instrumentation
CMD ["opentelemetry-instrument", "python", "src/agent/server.py"]