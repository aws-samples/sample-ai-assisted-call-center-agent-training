#!/bin/bash
# Generate frontend environment variables from deployed CloudFormation stack

set -e

STACK_NAME="${1:-CallCenterTraining-Web}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_PROD_FILE="$PROJECT_ROOT/frontend/app/.env.production"
ENV_LOCAL_FILE="$PROJECT_ROOT/frontend/app/.env.local"

echo "Fetching CloudFormation outputs from stack: $STACK_NAME"

# Get outputs
USER_POOL_ID=$(aws cloudformation describe-stacks \
  --stack-name $STACK_NAME \
  --query 'Stacks[0].Outputs[?OutputKey==`UserPoolId`].OutputValue' \
  --output text)

USER_POOL_CLIENT_ID=$(aws cloudformation describe-stacks \
  --stack-name $STACK_NAME \
  --query 'Stacks[0].Outputs[?OutputKey==`UserPoolClientId`].OutputValue' \
  --output text)

USER_POOL_DOMAIN=$(aws cloudformation describe-stacks \
  --stack-name $STACK_NAME \
  --query 'Stacks[0].Outputs[?OutputKey==`UserPoolDomain`].OutputValue' \
  --output text)

AGENT_RUNTIME_ARN=$(aws cloudformation describe-stacks \
  --stack-name $STACK_NAME \
  --query 'Stacks[0].Outputs[?OutputKey==`AgentRuntimeArn`].OutputValue' \
  --output text)

IDENTITY_POOL_ID=$(aws cloudformation describe-stacks \
  --stack-name $STACK_NAME \
  --query 'Stacks[0].Outputs[?OutputKey==`IdentityPoolId`].OutputValue' \
  --output text)

EVALUATION_LAMBDA_NAME=$(aws cloudformation describe-stacks \
  --stack-name $STACK_NAME \
  --query 'Stacks[0].Outputs[?OutputKey==`EvaluationLambdaName`].OutputValue' \
  --output text)

TRAINEE_LAMBDA_NAME=$(aws cloudformation describe-stacks \
  --stack-name $STACK_NAME \
  --query 'Stacks[0].Outputs[?OutputKey==`TraineeLambdaName`].OutputValue' \
  --output text)

AWS_REGION=$(aws cloudformation describe-stacks \
  --stack-name $STACK_NAME \
  --query 'Stacks[0].StackId' \
  --output text | cut -d: -f4)

# Validate
if [ -z "$USER_POOL_ID" ] || [ -z "$USER_POOL_CLIENT_ID" ]; then
  echo "Error: Could not fetch Cognito configuration from stack"
  exit 1
fi

# Generate environment variables content
ENV_CONTENT="# Auto-generated from CloudFormation stack: $STACK_NAME
# Generated at: $(date)

VITE_AWS_REGION=$AWS_REGION
VITE_USER_POOL_ID=$USER_POOL_ID
VITE_USER_POOL_CLIENT_ID=$USER_POOL_CLIENT_ID
VITE_USER_POOL_DOMAIN=$USER_POOL_DOMAIN.auth.$AWS_REGION.amazoncognito.com
VITE_IDENTITY_POOL_ID=$IDENTITY_POOL_ID
VITE_AGENT_RUNTIME_ARN=$AGENT_RUNTIME_ARN
VITE_EVALUATION_LAMBDA_NAME=$EVALUATION_LAMBDA_NAME
VITE_TRAINEE_LAMBDA_NAME=$TRAINEE_LAMBDA_NAME"

# Generate .env.production
cat > "$ENV_PROD_FILE" <<EOF
# Production environment variables
$ENV_CONTENT
EOF

# Generate .env.local (for local development)
cat > "$ENV_LOCAL_FILE" <<EOF
# Local development environment variables
$ENV_CONTENT
EOF

echo "✅ Generated $ENV_PROD_FILE"
echo "✅ Generated $ENV_LOCAL_FILE"
echo ""
echo "Environment variables:"
cat "$ENV_PROD_FILE"
