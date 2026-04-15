# Amazon Connect Integration - Setup & Deployment Guide

Step-by-step instructions for setting up and deploying the Amazon Connect integration for the call center training system.

## Architecture Overview

![Connect Flow Architecture](connect-flow-architecture.png)

The admin initiates an outbound call via the Admin API Lambda, which calls `start_outbound_voice_contact`. When the trainee answers via CCP (Contact Control Panel), the call flows through the Contact Flow which invokes the Session Setup Lambda, then hands off to the AI Agent. The AI Agent uses Nova Sonic speech-to-speech conversation to simulate realistic customer interactions.

---

## Prerequisites

- AWS CLI configured with appropriate permissions
- Node.js 18+ and npm
- CDK CLI (`npm install -g aws-cdk`)
- Docker (for building Lambda containers)
- Python 3.12+ (for Lambda functions)
- AWS account with Amazon Connect service enabled in the target region

---

## Deployment Modes

The deployment script supports 4 modes:

| Mode | Stacks Deployed | Use Case |
|------|----------------|----------|
| `agentcore` | `AgentCoreStack` | Shared backend only |
| `webui` | `AgentCoreStack` + `WebUIStack` | Browser-based training |
| `connect` | `AgentCoreStack` + `ConnectStack` | Amazon Connect training |
| `all` | `AgentCoreStack` + `WebUIStack` + `ConnectStack` | Everything |

---

## Step 1: Create a Connect Instance

1. Open the [Amazon Connect console](https://console.aws.amazon.com/connect/) in **us-west-2**
2. Click **Create instance**
3. Configure:
   - **Identity management**: Store users within Amazon Connect
   - **Administrator**: Create an admin user (e.g. `admin`)
   - **Telephony**: Enable both inbound and outbound calls
   - **Data storage**: Use defaults (S3 for call recordings, CloudWatch for logs)
   - **Review and create**
4. Wait for the instance to be created (takes a few minutes)
5. Note the **Instance ARN** from the instance overview page:
   ```
   arn:aws:connect:<region>:<account-id>:instance/<instance-id>
   ```

---

## Step 2: Note the Recordings S3 Bucket

When you created your Connect instance in Step 1, Amazon Connect automatically created an S3 bucket for storing call recordings and Contact Lens analysis.

1. In the Connect console, open your instance
2. Go to **Data storage** section
3. Look for **Call recordings** storage location
4. Note the S3 bucket name (typically `amazon-connect-<random-hash>`)

**Alternative via AWS CLI:**
```bash
aws connect describe-instance --instance-id <instance-id> --region us-west-2
```

This bucket is used for:
- Call recordings (audio files)
- Contact Lens analysis output (JSON files)
- Post-call processing (EventBridge monitors this bucket)

This value is required for the `recordingsBucket` config field in Step 4.

---

## Step 3: Create AI Agent Domain

Before creating AI Agents, you must create a domain.

1. In AWS Console, navigate to **Applications** → **AI Agents**
2. In the navigation pane, choose **AI Agents**, then choose **Add domain**
3. On the **Add domain** page, choose **Create a domain**
4. In the **Domain name** box, enter a friendly name (e.g., your organization name)
5. Under **Encryption**, clear the **Customize encryption settings** checkbox
6. Choose **Add domain**

This is a one-time setup per Connect instance.

---

## Step 4: Create AI Prompt

The AI Prompt defines how the AI Agent role-plays the customer.

**Reference:** [AWS Docs - Create AI Prompts](https://docs.aws.amazon.com/connect/latest/adminguide/create-ai-prompts.html)

1. In Amazon Connect admin website, navigate to **AI agent designer** → **AI prompts**
2. Click **Create AI Prompt**
3. In the **Create AI Prompt** dialog:
   - **Name:** CallCenterTrainingPrompt
   - **AI Prompt type:** Select **Orchestration**
   - **Copy from existing:** Leave **empty** (do not select any existing prompt)
   - Click **Create**
4. **Paste the prompt template:**
   - Open the file `amazon-connect/ai-agent-prompt-template.txt` from the project repository
   - Copy the entire contents
   - In the **AI Prompt** field, delete any default content and paste the copied template
   - The template uses **YAML MESSAGES format** with `system:` and `messages:` sections
5. Click **Save** to save your work
6. Click **Publish** to create an immutable published version

---

## Step 5: Create AI Agent

**Reference:** [AWS Docs - Create AI Agents](https://docs.aws.amazon.com/connect/latest/adminguide/create-ai-agents.html)

1. In Amazon Connect admin website, navigate to **AI agent designer** → **AI agents**
2. Click **Create AI Agent**
3. In the **Create AI Agent** dialog:
   - **Name:** call-center-training
   - **AI Agent type:** Select **Orchestration**
   - **Copy from existing:** Select **SelfServiceOrchestrator**
   - Click **Create**
4. On the AI Agent builder page:
   - **Locale:** Select **en-US**
5. **Replace the AI Prompt:**
   - In the **AI prompts** section, you'll see **SelfServiceOrchestrator** already added
   - Click the **Remove** (X) button next to **SelfServiceOrchestrator** to remove it
   - Click **Add AI prompt**
   - Select **CallCenterTrainingPrompt** (the published prompt you created in Step 5)
   - **Important:** You must select a *published* version, not a saved draft
6. Click **Save** to save your work
7. Click **Publish** to create a published version
8. **Get the AI Agent Assistant ID:**
   - In Amazon Connect admin website, navigate to **AI agent designer** → **AI agents**
   - Click on **call-center-training**
   - In the **Overview** section, find the **Assistant ARN**
   - The ARN format is: `arn:aws:wisdom:<REGION>:<ACCOUNT_ID>:assistant/<ASSISTANT_ID>`
   - Copy the last part after the final `/` (the Assistant ID)
   - You'll need this Assistant ID for config.json in Step 9

---

## Step 6: Create Conversational AI Bot

The Conversational AI bot connects your AI Agent to Amazon Connect contact flows and enables speech-to-speech conversation.

1. In Amazon Connect admin website, go to **Flows** → **Conversational AI** tab
2. Click **Create Conversational AI bot**
3. **Bot name:** Enter `call-center-agent-training`
4. Click **Create**
5. **Add language:**
   - Click **Add language**
   - Select **English (US)**
6. **Link AI Agent:**
   - Enable the **Amazon Connect AI agent Intent** toggle button
   - Select your AI assistant ARN from the dropdown (the AI Agent you created in Step 6)
   - Click **Confirm**
7. **Build the bot:**
   - Click **Build Language**
   - Wait for the build to complete
8. **Configure Speech-to-Speech:**
   - **Model type:** Select **Speech-to-speech**
   - **Voice provider:** Select **Amazon Nova Sonic**
   - Click **Confirm**
9. **Rebuild with speech-to-speech configuration:**
   - Click **Build Language** again
   - Wait for the build to complete

The bot is now configured and ready to use in contact flows.

---

## Step 7: Import Contact Flow

1. In Amazon Connect console, go to **Routing** → **Contact flows**
2. Click **Create contact flow**
3. Click the dropdown arrow next to **Save** → **Import flow (beta)**
4. Select `amazon-connect/AIAgentFlow.json`
5. The imported flow will have some blocks that need configuration (Lambda and AI Agent) - **don't configure them yet**
6. Click **Save** (don't publish yet - we'll configure it after deployment)
7. **Get the Contact Flow ID:**
   - Click the **Details** tab in the flow designer
   - Copy the ARN (format: `arn:aws:connect:<REGION>:<ACCOUNT_ID>:instance/<INSTANCE_ID>/contact-flow/<CONTACT_FLOW_ID>`)
   - Extract the last part after `/contact-flow/` as the Contact Flow ID
   - You'll need this for config.json in Step 9

---

## Step 8: Claim a Phone Number

1. In the Connect console, open your instance
2. Go to **Channels** > **Phone numbers**
3. Click **Claim a number**
4. Select:
   - **Country**: United States
   - **Type**: Toll free
5. **Associate with:** Select **Sample queue customer** (built-in inbound flow)
6. Note the claimed phone number (E.164 format, e.g. `+18332894032`)
   - You'll need this for config.json in Step 9

This phone number serves as the **destination** for outbound training calls - it routes calls to agents via CCP.

---

## Step 9: Update config.json

Edit `deployment/config.json` with all the values you've collected:

```json
{
  "connect": {
    "instanceArn": "arn:aws:connect:us-west-2:<account-id>:instance/<instance-id>",
    "recordingsBucket": "amazon-connect-<random-hash>",
    "contactFlowId": "<contact-flow-id>",
    "destinationPhoneNumber": "+1XXXXXXXXXX",
    "AIAgentAssistantId": "<assistant-id>"
  }
}
```

**Values:**
- `instanceArn` — from Step 1
- `recordingsBucket` — from Step 2
- `contactFlowId` — from Step 7
- `destinationPhoneNumber` — from Step 8
- `AIAgentAssistantId` — from Step 5 (optional but recommended)

---

## Step 10: Deploy CDK

```bash
cd deployment
./deploy.sh --all
```

This creates:
- **Session Setup Lambda** — injects scenario data into AI Agent sessions
- **Admin API Lambda** — HTTP API for managing calls
- **Admin UI** — CloudFront-hosted web app
- **Post-call processing Lambda** — handles Contact Lens analysis and scoring

**Note the outputs:**
- `AIAgentSessionSetupLambdaArn` — you'll need this in Step 11 to configure the contact flow
- `ConnectAdminApiUrl` — admin API endpoint

---

## Step 11: Import Lambda Function into Connect

Before configuring the contact flow, you must import the Session Setup Lambda function into your Connect instance.

1. In Amazon Connect console, go to **Flows** (left navigation bar)
2. Scroll down to the **AWS Lambda** section
3. From the dropdown, select your Session Setup Lambda function:
   - Function name format: `CallCenterTraining-Connect-AIAgentSessionSetup...`
   - Use the ARN from CDK output: `AIAgentSessionSetupLambdaArn`
4. Click **Add Lambda Function**

The Lambda function is now available for use in contact flows.

---

## Step 12: Configure Contact Flow

Now configure the contact flow with the deployed resources.

1. Open the Contact Flow you imported in Step 7
2. **Configure the AWS Lambda Function block:**
   - Find the **Invoke AWS Lambda function** block (first block after logging)
   - Click the block to edit
   - Select your Session Setup Lambda from the dropdown
   - Function name format: `CallCenterTraining-Connect-AIAgentSessionSetup...`
   - Click **Save**
3. **Configure the Connect Assistant (AI Agent) block:**
   - Find the **Connect Assistant** or **AI Agent** block (after the Lambda block)
   - Click to edit
   - **AI Agent:** Select **call-center-training** (the agent you created in Step 5)
   - **Version:** Select **$LATEST**
   - Click **Save**
4. **Configure the Get Customer Input block:**
   - Find the **Get Customer Input** block (where the bot interaction happens)
   - Click to edit
   - **Bot name:** Select **call-center-training-agent** (the bot you created in Step 6)
   - **Bot alias:** Select the alias (typically **$LATEST** or **Live**)
   - **AI Agent:** Select **call-center-training**
   - Click **Save**
5. **Save and Publish the flow:**
   - Click **Save**
   - Click **Publish**

The contact flow is now fully configured and ready to use!

---

## Step 13: Create an Admin User

Create a user in the **Admin Cognito User Pool** (separate from Connect agent users):

```bash
cd deployment
./create-user.sh admin@example.com Password123!
```

---

## Step 14: Test

The deployment outputs the following URLs:

| URL | Purpose |
|-----|---------|
| **Admin UI URL** | Where admins initiate training calls |
| **CCP URL** | Where trainees accept calls via softphone |

### Testing a Training Call

1. **Open CCP:**
   - Open the CCP URL: `https://<instance-alias>.my.connect.aws/ccp-v2/`
   - Log in with your admin user (from Step 1)
   - Set status to **Available**

2. **Initiate call from Admin UI:**
   - Open the Admin UI URL (from CDK output `ConnectAdminUiUrl`)
   - Log in with the Cognito credentials (from Step 13)
   - Select a training scenario
   - Enter the Connect agent username (your admin user)
   - Click **Start Training Call**

3. **Accept the call in CCP:**
   - The call should appear in CCP
   - Accept the incoming call
   - The AI customer should greet and begin the training scenario
   - Verify the AI customer responds via Nova Sonic voice

## Tearing Down

To destroy the Connect stack:

```bash
cd deployment
cdk destroy CallCenterTraining-Connect --context deployMode=connect
```

To destroy everything:

```bash
cd deployment
cdk destroy --all --context deployMode=all
```

> **Note**: S3 buckets and Cognito User Pools with `RETAIN` removal policy will not be deleted. Remove them manually if needed.
