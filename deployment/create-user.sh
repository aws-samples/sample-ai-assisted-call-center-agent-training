#!/bin/bash
# Create a Cognito user for testing

set -e

STACK_NAME="${STACK_NAME:-CallCenterTraining-Connect}"
EMAIL="${1}"
PASSWORD="${2}"
GROUP=""

# Parse optional --group flag
shift 2 2>/dev/null
while [[ $# -gt 0 ]]; do
    case "$1" in
        --group)
            GROUP="$2"
            shift 2
            ;;
        *)
            shift
            ;;
    esac
done

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

if [ -z "$EMAIL" ] || [ -z "$PASSWORD" ]; then
    echo -e "${RED}Usage:${NC} $0 <email> <password> [--group admin|trainee]"
    echo ""
    echo "Example:"
    echo "  $0 test@example.com Password123!"
    echo "  $0 admin@example.com Password123! --group admin"
    echo ""
    exit 1
fi

echo -e "${BLUE}Creating Cognito user...${NC}"

# Get User Pool ID
USER_POOL_ID=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs[?OutputKey==`UserPoolId`].OutputValue' \
  --output text)

if [ -z "$USER_POOL_ID" ]; then
    echo -e "${RED}Error:${NC} Could not find User Pool ID from stack $STACK_NAME"
    exit 1
fi

echo "User Pool ID: $USER_POOL_ID"
echo "Email: $EMAIL"

# Check if user already exists
if aws cognito-idp admin-get-user \
  --user-pool-id "$USER_POOL_ID" \
  --username "$EMAIL" &> /dev/null; then

    echo -e "${BLUE}User already exists. Updating password...${NC}"

    aws cognito-idp admin-set-user-password \
      --user-pool-id "$USER_POOL_ID" \
      --username "$EMAIL" \
      --password "$PASSWORD" \
      --permanent

    echo -e "${GREEN}✓${NC} Password updated for $EMAIL"
else
    echo -e "${BLUE}Creating new user...${NC}"

    aws cognito-idp admin-create-user \
      --user-pool-id "$USER_POOL_ID" \
      --username "$EMAIL" \
      --temporary-password "$PASSWORD" \
      --message-action SUPPRESS

    # Set permanent password
    aws cognito-idp admin-set-user-password \
      --user-pool-id "$USER_POOL_ID" \
      --username "$EMAIL" \
      --password "$PASSWORD" \
      --permanent

    echo -e "${GREEN}✓${NC} User created: $EMAIL"
fi

if [ -n "$GROUP" ]; then
    echo -e "${BLUE}Adding user to group '${GROUP}'...${NC}"

    aws cognito-idp admin-add-user-to-group \
      --user-pool-id "$USER_POOL_ID" \
      --username "$EMAIL" \
      --group-name "$GROUP"

    echo -e "${GREEN}✓${NC} Added to group: $GROUP"
fi

echo ""
echo "Credentials:"
echo "  Email:    $EMAIL"
echo "  Password: $PASSWORD"
if [ -n "$GROUP" ]; then
    echo "  Group:    $GROUP"
fi
echo ""
echo -e "${GREEN}Done!${NC} You can now sign in to the application."
