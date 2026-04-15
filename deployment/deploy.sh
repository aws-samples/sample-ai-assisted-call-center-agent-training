#!/bin/bash
# Deployment script for Call Center Training Agent
# Supports multiple deployment modes:
#   - agentcore: Shared backend only
#   - webui: AgentCore + Web UI
#   - connect: AgentCore + Amazon Connect
#   - all: AgentCore + Web UI + Connect
#
# Performance optimizations:
#   - Single describe-stacks call per stack (batched output parsing via jq)
#   - Frontend assets deployed via aws s3 sync + CloudFront invalidation
#     (avoids a full second cdk deploy per UI stack)
#   - ts-node --transpile-only skips type checking for fast CDK synthesis

set -e  # Exit on error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOYMENT_DIR="$SCRIPT_DIR"

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}ℹ${NC} $1"; }
log_success() { echo -e "${GREEN}✓${NC} $1"; }
log_warning() { echo -e "${YELLOW}⚠${NC} $1"; }
log_error() { echo -e "${RED}✗${NC} $1"; }

# Helper: extract a single output value from a describe-stacks JSON blob
# Usage: get_output "$STACK_JSON" "OutputKey"
get_output() {
    echo "$1" | jq -r --arg key "$2" '.Stacks[0].Outputs[] | select(.OutputKey==$key) | .OutputValue // "N/A"'
}

# Parse CLI arguments
DEPLOY_MODE=""
while [[ $# -gt 0 ]]; do
    case $1 in
        --mode)
            DEPLOY_MODE="$2"
            shift 2
            ;;
        --agentcore)
            DEPLOY_MODE="agentcore"
            shift
            ;;
        --webui)
            DEPLOY_MODE="webui"
            shift
            ;;
        --connect)
            DEPLOY_MODE="connect"
            shift
            ;;
        --all)
            DEPLOY_MODE="all"
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [--mode <mode>] [--agentcore|--webui|--connect|--all]"
            echo ""
            echo "Deployment modes:"
            echo "  agentcore - Shared AgentCore backend only"
            echo "  webui     - AgentCore + Browser-based Web UI"
            echo "  connect   - AgentCore + Amazon Connect integration"
            echo "  all       - AgentCore + Web UI + Connect (everything)"
            echo ""
            echo "If no mode is specified, an interactive menu is shown."
            exit 0
            ;;
        *)
            log_error "Unknown argument: $1"
            exit 1
            ;;
    esac
done

# Check prerequisites
command -v jq >/dev/null 2>&1 || { log_error "jq is required but not installed. Install with: brew install jq"; exit 1; }

# Check if AWS CLI is configured (single API call for both validation and account ID)
CALLER_IDENTITY=$(aws sts get-caller-identity --output json 2>/dev/null) || {
    log_error "AWS CLI not configured. Run 'aws configure' first."
    exit 1
}

ACCOUNT_ID=$(echo "$CALLER_IDENTITY" | jq -r '.Account')
REGION=${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || echo "us-east-1")}}

# Interactive menu if no mode specified
if [ -z "$DEPLOY_MODE" ]; then
    echo ""
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${CYAN}  Call Center Training Agent - Deployment${NC}"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo -e "  AWS Account: ${BLUE}${ACCOUNT_ID}${NC}"
    echo -e "  Region:      ${BLUE}${REGION}${NC}"
    echo ""
    echo "  Select deployment mode:"
    echo ""
    echo "    1) AgentCore only - Shared backend infrastructure"
    echo "    2) Web UI         - AgentCore + Browser-based training"
    echo "    3) Connect        - AgentCore + Amazon Connect integration"
    echo "    4) All            - AgentCore + Web UI + Connect"
    echo ""
    read -p "  Enter choice [1-4]: " choice

    case $choice in
        1) DEPLOY_MODE="agentcore" ;;
        2) DEPLOY_MODE="webui" ;;
        3) DEPLOY_MODE="connect" ;;
        4) DEPLOY_MODE="all" ;;
        *)
            log_error "Invalid choice: $choice"
            exit 1
            ;;
    esac
    echo ""
fi

log_info "Deploy mode: ${DEPLOY_MODE}"
log_info "AWS Account: ${ACCOUNT_ID}"
log_info "Region: ${REGION}"
echo ""

# ========================================
# Helper: Deploy a UI stack's frontend assets via S3 sync + CloudFront invalidation
# This replaces the slow second `cdk deploy` that was only needed to push built assets.
# Usage: deploy_frontend_assets <bucket_name> <distribution_id> <dist_path> <label>
# ========================================
deploy_frontend_assets() {
    local bucket_name="$1"
    local distribution_id="$2"
    local dist_path="$3"
    local label="$4"

    log_info "Uploading ${label} assets to S3..."
    aws s3 sync "$dist_path" "s3://${bucket_name}/" --delete

    log_info "Invalidating ${label} CloudFront cache..."
    aws cloudfront create-invalidation \
        --distribution-id "$distribution_id" \
        --paths "/*" \
        --no-cli-pager > /dev/null
}

# ========================================
# Helper: Deploy Web UI stack (infra + frontend build + S3 sync)
# ========================================
deploy_webui() {
    # Deploy infrastructure (skip frontend assets — we'll sync them directly)
    log_info "[Web UI] Deploying infrastructure..."
    cd "$DEPLOYMENT_DIR"
    cdk deploy CallCenterTraining-Web --exclusively --require-approval never \
        --context deployMode="$DEPLOY_MODE" --context skipFrontend=true --context skipAdminUI=true

    # Fetch all stack outputs in a single API call
    log_info "[Web UI] Fetching stack outputs..."
    local WEB_OUTPUTS
    WEB_OUTPUTS=$(aws cloudformation describe-stacks --stack-name "CallCenterTraining-Web" --output json)

    local USER_POOL_ID USERPOOL_CLIENT_ID USER_POOL_DOMAIN AGENT_RUNTIME_ARN IDENTITY_POOL_ID
    local API_GATEWAY_URL RECORDINGS_BUCKET FRONTEND_BUCKET DISTRIBUTION_ID
    USER_POOL_ID=$(get_output "$WEB_OUTPUTS" "UserPoolId")
    USERPOOL_CLIENT_ID=$(get_output "$WEB_OUTPUTS" "UserPoolClientId")
    USER_POOL_DOMAIN=$(get_output "$WEB_OUTPUTS" "UserPoolDomain")
    AGENT_RUNTIME_ARN=$(get_output "$WEB_OUTPUTS" "AgentRuntimeArn")
    IDENTITY_POOL_ID=$(get_output "$WEB_OUTPUTS" "IdentityPoolId")
    API_GATEWAY_URL=$(get_output "$WEB_OUTPUTS" "ApiGatewayUrl")
    RECORDINGS_BUCKET=$(get_output "$WEB_OUTPUTS" "RecordingsBucketName")
    FRONTEND_BUCKET=$(get_output "$WEB_OUTPUTS" "FrontendBucketName")
    DISTRIBUTION_ID=$(get_output "$WEB_OUTPUTS" "DistributionId")

    # Store outputs for results display
    WEBUI_URL=$(get_output "$WEB_OUTPUTS" "CloudFrontUrl")

    # Generate frontend env vars
    log_info "[Web UI] Generating environment variables..."
    cat > "$PROJECT_ROOT/frontend/app/.env.production" <<EOF
VITE_AWS_REGION=$REGION
VITE_USER_POOL_ID=$USER_POOL_ID
VITE_USER_POOL_CLIENT_ID=$USERPOOL_CLIENT_ID
VITE_USER_POOL_DOMAIN=$USER_POOL_DOMAIN.auth.$REGION.amazoncognito.com
VITE_IDENTITY_POOL_ID=$IDENTITY_POOL_ID
VITE_AGENT_RUNTIME_ARN=$AGENT_RUNTIME_ARN
VITE_API_URL=$API_GATEWAY_URL
VITE_RECORDINGS_BUCKET=$RECORDINGS_BUCKET
EOF
    cp "$PROJECT_ROOT/frontend/app/.env.production" "$PROJECT_ROOT/frontend/app/.env.local"

    # Build frontend
    log_info "[Web UI] Building frontend..."
    cd "$PROJECT_ROOT/frontend/app"
    if [ ! -d node_modules ]; then
        log_error "Frontend dependencies not installed. Run 'cd frontend/app && npm install' first."
        exit 1
    fi
    npm run build
    cd "$DEPLOYMENT_DIR"

    # Deploy frontend assets directly to S3 + invalidate CloudFront
    deploy_frontend_assets "$FRONTEND_BUCKET" "$DISTRIBUTION_ID" \
        "$PROJECT_ROOT/frontend/app/dist" "Web UI"

    log_success "Web UI stack deployed"
}

# ========================================
# Helper: Deploy Connect stack (infra + admin UI build + S3 sync)
# ========================================
deploy_connect() {
    # Deploy infrastructure (skip admin UI assets — we'll sync them directly)
    log_info "[Connect] Deploying infrastructure..."
    cd "$DEPLOYMENT_DIR"
    cdk deploy CallCenterTraining-Connect --exclusively --require-approval never \
        --context deployMode="$DEPLOY_MODE" --context skipAdminUI=true --context skipFrontend=true

    # Fetch all stack outputs in a single API call
    log_info "[Connect] Fetching stack outputs..."
    local CONNECT_OUTPUTS
    CONNECT_OUTPUTS=$(aws cloudformation describe-stacks --stack-name "CallCenterTraining-Connect" --output json)

    local ADMIN_USER_POOL_ID ADMIN_USER_POOL_CLIENT_ID CONNECT_API_URL
    local CONNECT_INSTANCE_ARN ADMIN_BUCKET ADMIN_DIST_ID
    ADMIN_USER_POOL_ID=$(get_output "$CONNECT_OUTPUTS" "AdminUserPoolId")
    ADMIN_USER_POOL_CLIENT_ID=$(get_output "$CONNECT_OUTPUTS" "AdminUserPoolClientId")
    CONNECT_API_URL=$(get_output "$CONNECT_OUTPUTS" "ConnectAdminApiUrl")
    CONNECT_INSTANCE_ARN=$(get_output "$CONNECT_OUTPUTS" "ConnectInstanceArn")
    ADMIN_BUCKET=$(get_output "$CONNECT_OUTPUTS" "AdminBucketName")
    ADMIN_DIST_ID=$(get_output "$CONNECT_OUTPUTS" "AdminDistributionId")

    # Store outputs for results display
    ADMIN_UI_URL=$(get_output "$CONNECT_OUTPUTS" "AdminUIUrl")

    # Generate admin UI env vars
    log_info "[Connect] Generating environment variables..."
    cat > "$PROJECT_ROOT/connect-admin/app/.env.production" <<EOF
VITE_AWS_REGION=$REGION
VITE_ADMIN_USER_POOL_ID=$ADMIN_USER_POOL_ID
VITE_ADMIN_USER_POOL_CLIENT_ID=$ADMIN_USER_POOL_CLIENT_ID
VITE_API_URL=$CONNECT_API_URL
VITE_CONNECT_INSTANCE_ARN=$CONNECT_INSTANCE_ARN
EOF
    cp "$PROJECT_ROOT/connect-admin/app/.env.production" "$PROJECT_ROOT/connect-admin/app/.env.local"

    # Build admin UI
    log_info "[Connect] Building admin UI..."
    cd "$PROJECT_ROOT/connect-admin/app"
    if [ ! -d node_modules ]; then
        log_error "Admin UI dependencies not installed. Run 'cd connect-admin/app && npm install' first."
        exit 1
    fi
    npm run build
    cd "$DEPLOYMENT_DIR"

    # Deploy admin UI assets directly to S3 + invalidate CloudFront
    deploy_frontend_assets "$ADMIN_BUCKET" "$ADMIN_DIST_ID" \
        "$PROJECT_ROOT/connect-admin/app/dist" "Connect Admin UI"

    log_success "Connect stack deployed"
}

# ========================================
# MULTI-STACK DEPLOYMENT
# ========================================

# Step 1: Verify CDK prerequisites
log_info "Step 1: Verifying CDK prerequisites..."
cd "$DEPLOYMENT_DIR"

# Check that dependencies are installed
if [ ! -d node_modules ]; then
    log_error "CDK dependencies not installed. Run 'cd deployment && npm install' first."
    exit 1
fi

log_success "CDK ready"

# Step 2: Deploy AgentCore stack (always required)
log_info "Step 2: Deploying AgentCore stack..."
cdk deploy CallCenterTraining-Core --require-approval never \
    --context deployMode=all --context skipFrontend=true --context skipAdminUI=true
log_success "AgentCore stack deployed"

# Variables to hold outputs for results display (set by deploy functions)
WEBUI_URL=""
ADMIN_UI_URL=""

# Step 3: Deploy UI stacks
if [ "$DEPLOY_MODE" = "all" ]; then
    log_info "Step 3: Deploying Web UI stack..."
    deploy_webui
    log_info "Step 4: Deploying Connect stack..."
    deploy_connect

elif [ "$DEPLOY_MODE" = "webui" ]; then
    log_info "Step 3: Deploying Web UI stack..."
    deploy_webui

elif [ "$DEPLOY_MODE" = "connect" ]; then
    log_info "Step 3: Deploying Connect stack..."
    deploy_connect
fi

# ========================================
# Display results
# ========================================
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Deployment Complete! [mode: ${DEPLOY_MODE}]${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Show AgentCore outputs (single API call, reuse cached value if available)
if [ -z "$CORE_AGENT_RUNTIME_ARN" ]; then
    CORE_AGENT_RUNTIME_ARN=$(aws cloudformation describe-stacks --stack-name "CallCenterTraining-Core" \
        --query 'Stacks[0].Outputs[?OutputKey==`AgentRuntimeArn`].OutputValue' --output text 2>/dev/null || echo "N/A")
fi
echo -e "${BLUE}AgentCore Stack:${NC}"
echo "  Runtime ARN: $CORE_AGENT_RUNTIME_ARN"
echo ""

# Show Web UI outputs
if [ "$DEPLOY_MODE" = "webui" ] || [ "$DEPLOY_MODE" = "all" ]; then
    echo -e "${BLUE}Web UI Stack:${NC}"
    echo "  Frontend URL: $WEBUI_URL"
    echo ""
fi

# Show Connect outputs
if [ "$DEPLOY_MODE" = "connect" ] || [ "$DEPLOY_MODE" = "all" ]; then
    echo -e "${BLUE}Connect Stack:${NC}"
    echo "  Admin UI URL: $ADMIN_UI_URL"
    echo ""
    echo -e "${YELLOW}Next steps for Connect:${NC}"
    echo "  1. Create an admin user:  cd deployment && ./create-user.sh <email> <password>"
    echo "  2. Create a Connect agent in the Connect console"
    echo "  3. Open Admin UI: $ADMIN_UI_URL"
    echo ""
fi

log_success "Deployment complete!"
