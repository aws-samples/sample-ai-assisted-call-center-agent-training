# AI Assisted Call Center Training & Enablement - Prototype Report Content

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Detailed Architecture Flow](#detailed-architecture-flow)
3. [Duo Mode](#duo-mode)
4. [Technical Approach](#technical-approach)
5. [Call Metrics](#call-metrics)
6. [Deployment](#deployment)
7. [Cost Estimates](#cost-estimates)
8. [Outcomes](#outcomes)
9. [Recommendations](#recommendations)
10. [Scenario Development](#scenario-development)
11. [Scenario Schema](#scenario-schema)
12. [Scenario Inventory](#scenario-inventory)
13. [Rubric Structure](#rubric-structure)
14. [Key File Reference](#key-file-reference)
15. [Links and References](#links-and-references)

---

## Architecture Overview

The prototype follows a serverless, event-driven architecture deployed entirely on AWS. The system is composed of three independently deployable CDK stacks that together provide a complete AI-powered voice training platform for call center agents.

The architecture supports two training modes:

- **Web UI Mode:** Trainees access a React-based web application served via Amazon CloudFront, authenticated through Amazon Cognito. Voice streaming occurs directly between the browser and a Bedrock AgentCore Runtime container via WebSocket, using Amazon Nova Sonic for bidirectional audio.

- **Amazon Connect Mode:** Trainees receive outbound phone calls through Amazon Connect. Amazon Connect AI Agents provide natural conversation simulation, with a Session Setup Lambda injecting scenario data before the conversation starts. AI Agents use Amazon Bedrock (Claude Haiku) for conversation orchestration. Post-call scoring is triggered automatically via Amazon EventBridge.

Both modes share a common backend comprising Amazon DynamoDB for scenario and session storage, Amazon S3 (KMS-encrypted) for audio recordings, transcripts, and scorecards, and Claude (via Amazon Bedrock) for AI-powered evaluation. All Lambda functions are deployed within a VPC with private subnets and VPC endpoints for secure access to AWS services including Bedrock, S3, DynamoDB, ECR, CloudWatch Logs, and Secrets Manager.

![Figure 1 - Web UI Architecture](web-ui-architecture.png)
*Figure 1 - Web UI Architecture*

![Figure 2 - Amazon Connect Architecture](amazon-connect-architecture.png)
*Figure 2 - Amazon Connect Architecture*

![Figure 3 - Connect Contact Flow](connect-flow-architecture.png)
*Figure 3 - Connect Contact Flow*

### AWS Services Used

| Service | Purpose |
|---------|---------|
| Amazon Bedrock (AgentCore Runtime + Nova Sonic) | Serverless voice agent container with bidirectional streaming |
| Amazon Bedrock (Claude Sonnet 4.6) | AI-powered session evaluation and scoring |
| AWS Lambda (7 functions) | Trainee API, Admin API, Scoring, Screen Analysis, Audio Empathy, AI Agent Session Setup, Connect Admin |
| Amazon API Gateway v2 (HTTP API) | RESTful backend with JWT authorization |
| Amazon Cognito | User pools (admin/trainee groups) and identity pools for temporary credentials |
| Amazon CloudFront | CDN for React frontend and Connect admin UI |
| Amazon S3 (KMS-encrypted) | Recordings, transcripts, scorecards with lifecycle policies |
| Amazon DynamoDB (3 tables) | Scenarios, Sessions (with GSIs), CriteriaConfig |
| Amazon VPC + VPC Endpoints | Private connectivity to Bedrock, ECR, CloudWatch, Secrets Manager, S3, DynamoDB |
| Amazon ECR | Docker image repository for AgentCore container |
| Amazon Connect | Phone-based training with AI Agents for customer simulation |
| Amazon EventBridge | Post-call scoring triggers |
| AWS KMS | Encryption keys for S3 and Cognito |

### VPC Architecture

- **CIDR:** 10.0.0.0/16, 2 availability zones, 1 NAT Gateway
- **Public Subnets:** NAT Gateways
- **Private Subnets:** Lambda functions, AgentCore Runtime, VPC Endpoints
- **Interface Endpoints:** Bedrock AgentCore, Bedrock Runtime, ECR, ECR Docker, CloudWatch Logs, Secrets Manager
- **Gateway Endpoints:** S3, DynamoDB

---

## Detailed Architecture Flow

### Web UI Training Session Flow

The following describes the end-to-end data flow when a trainee completes a training session via the web UI:

**1. Authentication**
- Trainee navigates to the CloudFront-hosted React application
- AWS Amplify authenticates via Cognito User Pool (email + password)
- Cognito returns ID token (JWT) and temporary AWS credentials via the Identity Pool
- Frontend stores credentials for API calls and presigned URL generation

**2. Scenario Selection**
- Frontend calls `GET /scenarios` via API Gateway
- API Gateway validates JWT token against Cognito authorizer
- Trainee Lambda (`src/lambda/trainee/index.py::list_scenarios()`) queries DynamoDB Scenarios table
- Returns scenario list with names, difficulties, and character info
- Trainee selects scenario, customer mood, voice, and language settings

**3. Session Initialization**
- Frontend generates a UUID for the session
- Calls `POST /sessions` to create a DynamoDB session record (status: "initiated")
- Generates a presigned WebSocket URL using SigV4 signing in the browser:
  - Uses Cognito Identity Pool temporary credentials
  - Signs a request to `bedrock-agentcore.{region}.amazonaws.com/runtimes/{agentRuntimeArn}/ws`
  - Returns a WSS URL with embedded X-Amz-Signature, X-Amz-Credential, X-Amz-Date

**4. WebSocket Connection & Voice Streaming**
- Browser opens WebSocket connection to AgentCore Runtime using the presigned URL
- Sends session configuration message:
  ```json
  {
    "type": "session_config",
    "scenario_id": "athene_tax_call_01",
    "voice_id": "matthew",
    "customer_mood": "neutral",
    "language_mode": "english",
    "session_id": "uuid",
    "user_id": "cognito-sub",
    "user_name": "Trainee Name",
    "character_voices": {}
  }
  ```
- AgentCore server (`src/agent/server.py::websocket_endpoint()`) receives config, loads scenario from DynamoDB, builds system prompt
- Creates a Strands BidiAgent with Nova Sonic model (16kHz input, 24kHz output)
- Starts SessionRecorder to capture transcript

**5. Bidirectional Audio Streaming**
- Browser captures microphone audio via MediaRecorder, streams PCM chunks over WebSocket
- AgentCore forwards audio to Nova Sonic BidiAgent
- Nova Sonic processes speech-to-text, generates AI response, synthesizes speech
- Response audio (24kHz) and real-time transcript streamed back over WebSocket
- Events: `bidi_audio_input`, `bidi_audio_stream`, `bidi_transcript_stream`, `bidi_interruption`
- System supports natural interruptions (trainee can interrupt the customer mid-sentence)

**6. Client-Side Recording (Concurrent)**
- Audio recording: Captures a single stereo WebM file (agent on one channel, customer on the other), uploaded to S3
- Enriched transcript: Builds transcript with accurate browser-side timestamps, uploads as `{sessionId}_client_transcript.json`
- Screen capture (optional): Periodic screenshots every 10 seconds, batched in groups of 3 (every 30 seconds) and sent to the Screen Analysis Lambda, which uses Claude vision to describe on-screen activity for compliance checking

**7. Session End & S3 Upload**
- On disconnect, SessionRecorder creates `SessionRecording` object with full transcript and metadata
- Saves JSON to S3: `users/{userId}/sessions/{sessionId}/{sessionId}_server_transcript.json`
- Client uploads stereo audio: `users/{userId}/sessions/{sessionId}/{sessionId}_audio.webm`

**8. Scoring (Async)**
- Frontend calls `POST /scoring` with sessionId and userId
- Scoring Lambda returns `202 Accepted` immediately
- Lambda self-invokes asynchronously (`InvocationType='Event'`)
- Frontend polls `GET /scoring/{sessionId}` every 5 seconds (up to 5 minutes)
- See [Scoring Pipeline Detail](#scoring-pipeline-detail) below

**9. Results Display**
- Frontend receives completed scorecard
- Displays: overall score, letter grade, pass/fail, per-section breakdown, critical failures, empathy score, call metrics
- Results stored in DynamoDB for historical tracking

### Amazon Connect Training Flow

**1. Call Initiation**
- Admin calls `POST /start-call` with scenario_id, voice_id, language_code, language_mode, and destination phone number
- Connect Admin Lambda (`src/lambda/connect_lambda/index.py::handle_start_call()`) starts an outbound voice contact via Amazon Connect
- Contact attributes include scenario_id, voice_id, language_code, language_mode, training_session_id, voice_engine, voice_style
- Creates preliminary session record in DynamoDB (userId: "connect", status: "initiated")

**2. Session Setup**
- Contact flow invokes Session Setup Lambda synchronously
- Session Setup Lambda (`src/lambda/ai_agent_session_setup/index.py`):
  1. Retrieves session information from Amazon Connect (with retry logic for timing)
  2. Loads scenario from DynamoDB Scenarios table
  3. Injects scenario fields into AI Agent session as custom data:
     - scenarioId, name, context, initial_message, caller_gender
     - key_challenges (JSON string), success_criteria (JSON string), characters (JSON string for duo scenarios)
  4. Retries with exponential backoff (5 attempts, 0.5s to 8s) if timing issues occur
  5. Returns success response to contact flow

**3. AI Customer Conversation**
- Contact flow invokes Amazon Connect AI Agent block (using Q Connect backend), which orchestrates conversation via Amazon Bedrock (Claude Haiku)
- AI Agent uses orchestration prompt referencing `{{$.Custom.*}}` variables for scenario data
- Nova Sonic handles STT (trainee speech → text), Claude Haiku generates responses (text → text), Nova Sonic handles TTS (text → customer speech)
- Trainee interacts naturally via phone, with AI customer role-playing based on the scenario

**4. Post-Call Processing**
- When the call ends, Contact Lens generates an analysis JSON in S3
- EventBridge rule triggers the Post-Call Lambda (`src/lambda/connect_postcall/index.py`)
- Post-Call Lambda:
  1. Looks up session by contactId (DynamoDB GSI: ContactIdIndex)
  2. Downloads Contact Lens analysis JSON (transcript, sentiment, interruptions)
  3. Downloads stereo WAV recording from Connect
  4. Extracts agent-only audio (right channel to mono via ffmpeg)
  5. Converts Contact Lens transcript to SessionRecording format
  6. Uploads session JSON, agent audio, and stereo audio to recordings S3 bucket
  7. Invokes Scoring Lambda asynchronously

### Scoring Pipeline Detail

The scoring pipeline runs asynchronously after a training session ends. It uses a Lambda self-invocation pattern to work around API Gateway's 30-second timeout:

**Step 1: Download & Prepare**
- Downloads server transcript from S3 (`{sessionId}_server_transcript.json`)
- Merges client-side enriched transcript (if available) for more accurate audio timing
- Downloads screen action summaries (if screen recording was enabled)
- Loads enabled criteria from DynamoDB CriteriaConfig table (allows per-scenario criteria customization)

**Step 2: Compute Transcript Analytics**
- `compute_transcript_analytics()` in `src/evaluators/transcript_analytics.py` extracts call metrics:
  - Agent silence (seconds, percentage, max gap, violations >20s)
  - Talk-over count (overlapping speech detection)
  - Questions asked/answered by customer
  - Hold count (phrase detection)
  - Confidence language count (hedging phrases)
  - Average agent response time

**Step 3: Audio Empathy Analysis (Concurrent)**
- Kicks off Audio Empathy Lambda in a thread pool (runs concurrently with Claude evaluation)
- Extracts agent audio from right channel of stereo recording, then uses librosa to extract prosodic features: pitch variation, energy, speaking rate, voice quality (ZCR), and consistency
- Calculates weighted empathy score (0-100) from 5 components, combined 50/50 with text-based empathy from Claude

**Step 4: Claude AI Evaluation**
- Sends transcript + analytics + screen actions to Claude (Sonnet 4.6) via Bedrock
- Uses structured JSON output schema to ensure consistent evaluation format
- Prompt includes:
  - Full call transcript with speaker labels
  - Pre-computed call analytics (silence, talk-overs, response time, etc.)
  - Screen activity descriptions (if available)
  - Full rubric criteria with descriptions and criticality levels

**Step 5: Build Scorecard**
- `build_scorecard()` in `src/models/call_scorecard.py` processes Claude's evaluation:
  - **Critical criteria:** Binary pass/fail (full points or zero). Any critical failure = automatic overall FAIL
  - **Non-critical criteria:** Partial credit allowed (0 to max_points, AI-assigned score)
  - Calculates per-section scores, overall percentage, and letter grade (A-F)
  - Collects critical failure details with reasoning

**Step 6: Save Results**
- Uploads scorecard JSON to S3: `users/{userId}/sessions/{sessionId}/{sessionId}_scorecard.json`
- Updates DynamoDB Sessions table with grade, pass/fail, percentage score
- Aggregates per-component token usage (Nova Sonic, Claude scoring) and stores in DynamoDB `tokenUsage` field for cost monitoring

### Admin Flow

- **Scenario Management:** `GET/POST/PUT/DELETE /admin/scenarios` - Full CRUD via Admin Lambda. Includes AI-powered scenario generation from call transcripts using Claude.
- **Trainee Management:** `GET /admin/trainees` - Aggregates session data by userId from DynamoDB, returns latest scores and dates.
- **Session Review:** `GET /admin/trainees/{userId}/sessions` - Lists all sessions for a trainee. `GET /admin/trainees/{userId}/sessions/{sessionId}/scorecard` - Downloads full scorecard from S3. The admin session detail view displays per-session token usage breakdown by component (Nova Sonic, Claude scoring, screen analysis) for cost monitoring.
- **Criteria Configuration:** `GET/PUT /admin/criteria/config/{scenarioId}` - Enable/disable specific rubric criteria per scenario. Changes take effect immediately for subsequent scoring.

---

## Duo Mode

Duo mode is an experimental feature (beyond the original scope) that enables multi-character training scenarios where two or more AI-simulated customers participate in a single call, with natural handoffs between characters.

**Note:** Duo mode is only supported in Web UI mode and does not work with Amazon Connect integration.

### Scenario Structure

Duo scenarios use a `characters` array instead of a single character definition:

```json
{
  "id": "athene_tax_call_01",
  "name": "Athene Tax Call - PO with Spouse",
  "characters": [
    {
      "id": "customer_1",
      "name": "Jay Forrester",
      "voice": "matthew",
      "gender": "male",
      "is_primary": true,
      "context": "Policy owner. Handles opening and identity verification...",
      "initial_message": "Hi, I'm calling about my tax form...",
      "handoff_trigger": "When wife wants to ask about the surrender check",
      "handoff_to": "customer_2"
    },
    {
      "id": "customer_2",
      "name": "Merry Forrester",
      "voice": "tiffany",
      "gender": "female",
      "is_primary": false,
      "context": "Spouse. Handles financial questions about surrender...",
      "initial_message": "Hi, my husband said you could help me...",
      "handoff_trigger": "When done asking questions, hand back to husband",
      "handoff_to": "customer_1"
    }
  ]
}
```

Key fields:
- `is_primary`: Exactly one character must be primary (starts the conversation)
- `handoff_trigger`: Natural language description of when the character should hand off
- `handoff_to`: Target character ID to hand off to

### Internal Mechanism

The duo session engine (`src/agent/duo_session.py`) orchestrates multiple BidiAgents sharing a single WebSocket connection:

**Agent Creation:**
- One Strands BidiAgent is created per character
- Each agent gets a unique Nova Sonic voice and a character-specific system prompt
- All agents share a mutable state dictionary and a common `hand_off` tool

**Shared State:**
```python
state = {
    "active": primary.id,        # Currently speaking character
    "pending_handoff": None,     # Queued handoff target
    "output_handles": {},        # Task handles per character
    "ready": set(),              # Characters currently running
}
```

**The hand_off Tool:**
- Dynamically created tool available to all characters
- Takes a `target` parameter (character ID or name, resolved case-insensitively)
- When invoked by a character: sets `state["active"]` and `state["pending_handoff"]` to the target
- Returns a confirmation message to the invoking character

**Active Character Gating:**
- Only the active character's audio and transcript events are forwarded to the WebSocket
- Non-active characters are silenced (their output is suppressed)
- This prevents overlapping or conflicting responses from multiple agents

**Handoff Execution (`_do_handoff`):**

When the input loop detects `pending_handoff` is set:

1. **Stop all agents:** Cancel all output tasks, await cancellation, call `stop()` on every agent
2. **Copy and relabel message history:** The `relabel_messages()` function:
   - Deep copies the source agent's full conversation history
   - Tracks the current speaker through hand_off tool calls
   - Converts the non-target character's assistant messages to user role, wrapped as `"(Name said: original_text)"`
   - The target character's own previous messages remain as assistant role
   - This gives the new character full conversational context
3. **Assign to target:** Sets `agents[target_id].messages = relabeled_messages`
4. **Start target agent:** Awaits `start()` with the shared `invocation_state`
5. **Send context nudge:**
   - Primary character: reminds them of previous context, no repeat introduction
   - Non-primary character: tells them to introduce themselves and explain their issue
6. **Clear pending:** Resets `pending_handoff = None`

**Transcript Recording:**
- Speaker format for AI characters: `"customer (CharacterName)"` (e.g., `"customer (Jay Forrester)"`)
- Speaker format for trainee: `"agent"`
- Each transcript event is enriched with `character_id` and `character_name`

**Frontend Handling:**
- Detects duo mode when `scenario.characters.length > 1`
- Renders per-character voice dropdowns (one for each character)
- Auto-selects gender-appropriate voices for each character
- Passes `character_voices` map in session config
- Displays character names in transcript view

---

## Technical Approach

The prototype leverages the Strands Agents SDK (v1.24.0) with Amazon Bedrock AgentCore Runtime for building multi-turn, bidirectional voice agents. The core interaction engine uses a BidiAgent configured with Amazon Nova 2 Sonic for real-time speech-to-speech communication, supporting 16 distinct voices across 7 languages.

### Voice Streaming

The bidirectional streaming protocol exchanges WebSocket messages between the frontend and AgentCore Runtime. Audio input (16kHz PCM from the trainee's microphone) is streamed to the agent, which processes it through Nova Sonic and returns synthesized customer responses (24kHz audio) along with real-time transcription. The system handles interruptions, allowing natural conversation flow where the trainee can interrupt the simulated customer mid-sentence.

Supported voices: matthew, tiffany, amy, olivia, kiara, arjun, ambre, florian, beatrice, lorenzo, tina, lennart, lupe, carlos, carolina, leo

Supported languages: English, French, Italian, German, Spanish, Portuguese, Hindi

### Scenario Simulation

Each training scenario is defined as a structured JSON document containing a detailed customer persona, personal details (name, DOB, SSN, policy number), situation context, key challenges, and success criteria. The system includes 18+ pre-built scenarios covering various call types across multiple carriers including tax calls, death claims, surrenders, loans, withdrawals, and rider inquiries. A scenario generator powered by Claude Sonnet can create new scenarios from raw call transcripts. The system supports both single-character and multi-character (duo) scenarios, where multiple AI characters can hand off to each other mid-conversation.

The BidiAgent is equipped with a `verify_spelling` tool that ensures accurate verification of customer details during calls. When the trainee reads back an email address, name, policy number, or other detail for verification, the AI customer invokes this tool before responding. It takes the correct value from the scenario and what the agent said, then calls Claude via Bedrock Converse API to compare the two — handling phonetic alphabet decoding (e.g. "B as in Bravo, H as in Hotel") and ignoring case/spacing differences. The tool returns MATCH or MISMATCH with specific details, allowing the AI customer to realistically confirm or correct the trainee. This prevents the model from hallucinating whether a read-back was correct, which is a common failure mode in voice LLM interactions.

### AI Agent Orchestration

The Amazon Connect integration uses **Amazon Connect AI Agents** for conversation simulation. Training calls leverage a Session Setup Lambda to inject scenario data before the conversation starts, providing the AI Agent with full scenario context from the first turn.

The Session Setup Lambda (`src/lambda/ai_agent_session_setup/index.py`) is invoked synchronously by the contact flow at the beginning of each training call. It retrieves session information from Amazon Connect, loads the scenario from DynamoDB, and injects scenario fields as custom session data. The AI Agent's orchestration prompt references this data using template variables (e.g., `{{$.Custom.scenarioId}}`, `{{$.Custom.context}}`, `{{$.Custom.initial_message}}`), allowing the AI to naturally role-play the customer persona.

Retry logic with exponential backoff (5 attempts, 0.5s to 8s delays) handles timing issues during session initialization. This ensures scenario data is successfully injected before the AI Agent begins the conversation.

The AI Prompt and AI Agent are created in the Amazon Connect console (under **AI agent designer**). This allows for easy prompt iteration and testing without redeployment. The orchestration prompt template (`amazon-connect/ai-agent-prompt-template.txt`) is provided as a reference. AI Agents use Amazon Bedrock (Claude Haiku) for conversation orchestration, with Amazon Connect handling speech-to-text and text-to-speech automatically.

Post-call processing uses Contact Lens analysis: when the call ends, Contact Lens generates a transcript and analytics JSON in S3. EventBridge triggers the Post-Call Lambda, which extracts the transcript, processes the audio recording, and invokes the Scoring Lambda. The AI Agent flow shares the same DynamoDB tables, S3 buckets, and scoring pipeline as other training modes.

### Evaluation Engine

After each training session, an asynchronous scoring pipeline evaluates the trainee's performance. The session transcript is submitted to Claude (Sonnet 4.6) with a structured JSON output schema and evaluated against a comprehensive rubric containing 30+ criteria across 6 sections: Security, Professional Call Handling, Complete/Correct Information, Time Efficiency, Scripting & Scope, and Reducing Customer Effort. Critical criteria (such as identity verification and compliance) result in an automatic call failure if not met, while non-critical criteria contribute to a weighted percentage score. The system produces a detailed scorecard with per-criterion pass/fail results, reasoning, and an overall letter grade (A-F). The rubric can be customized for each scenario.

### Audio Empathy Analysis

In addition to transcript-based evaluation, the system includes an audio empathy analyzer that extracts prosodic features from the agent's voice using the librosa signal processing library. The agent's audio is isolated by extracting the right channel from the stereo recording (agent channel) as mono WAV at 24kHz using ffmpeg.

The feature set is based on the Geneva Minimalistic Acoustic Parameter Set (GeMAPS) standard [Eyben et al., 2015], which defines a validated minimal set of acoustic parameters for affect detection. The analyzer extracts seven prosodic features — pitch mean and variation, energy (RMS) mean and variation, zero crossing rate, spectral centroid, and speaking rate (via beat tracking) — and combines them into five weighted components:

| Component | Weight | What It Measures | Ideal Range |
|-----------|--------|-----------------|-------------|
| Pitch Variation | 25% | Natural vocal inflection vs. monotone delivery | 20-40 Hz std deviation |
| Energy/Volume | 20% | Appropriate and consistent speaking volume | 0.01-0.05 RMS |
| Speaking Rate | 20% | Patient, clear pacing vs. rushing or hesitation | 100-140 BPM |
| Voice Quality | 20% | Warm vocal tone (low zero crossing rate) | ZCR 0.05-0.15 |
| Consistency | 15% | Stable delivery across the conversation | Low variation across segments |

The audio empathy score is combined 50/50 with text-based empathy (assessed by Claude from the transcript) to produce the final empathy score displayed on the scorecard. Qualitative feedback is generated based on thresholds — for example, pitch standard deviation below 15 Hz triggers "voice sounds somewhat monotone", while a speaking rate above 150 BPM triggers "speaking pace is fast".

Scoring thresholds were informed by empirical findings in the vocal affect literature — particularly the mapping of moderate F0 variability and slower speech rate to warmth and empathy [Juslin & Laukka, 2003] and the component process model of vocal emotion [Scherer, 2003]. The specific numeric thresholds are calibrated for the recording pipeline and should be validated against actual call center QA data during pilot testing.

**References:**
- Eyben, F., Scherer, K. R., Schuller, B. W., et al. (2015). "The Geneva Minimalistic Acoustic Parameter Set (GeMAPS) for Voice Research and Affective Computing." *IEEE Transactions on Affective Computing*, 7(2), 190-202.
- Juslin, P. N., & Laukka, P. (2003). "Communication of emotions in vocal expression and music performance: Different channels, same code?" *Psychological Bulletin*, 129(5), 770-814.
- Scherer, K. R. (2003). "Vocal communication of emotion: A review of research paradigms." *Speech Communication*, 40(1-2), 227-256.
- Pentland, A. (2008). *Honest Signals: How They Shape Our World.* MIT Press.

---

## Call Metrics

The prototype captures and evaluates the following performance metrics for each training session:

### Call Performance Metrics

| Metric | Description | How It's Computed |
|--------|-------------|-------------------|
| **Call Duration** | Total length of the training call in seconds | End time minus start time from session recording |
| **Agent Silence** | Total seconds and percentage of the call where the agent was silent | Sum of gaps >= 1.0s between customer speech end and agent speech start |
| **Max Silence Gap** | Longest single period of agent silence in seconds | Maximum individual gap in the silence gaps list |
| **Silence Violations** | Count of silence gaps exceeding the acceptable threshold | Gaps > 20 seconds |
| **Talk-Over Count** | Number of times the agent spoke over the customer | Detected when one speaker's audio end time overlaps the next speaker's start time |
| **Average Agent Response Time** | Mean time in seconds between customer finishing and agent responding | Average of all customer-to-agent transition gaps |
| **Hold Count** | Number of times the agent placed the caller on hold | Phrase detection in agent turns: "put you on hold", "place you on hold", "one moment please", "brief hold", etc. |
| **Confidence Language Count** | Occurrences of hedging or low-confidence language | Phrase detection: "I don't know", "I'm not sure", "it looks like", "I think maybe", "I guess" |
| **Questions Asked** | Number of questions the customer asked during the call | Count of `?` characters in customer turns |
| **Questions Answered** | Number of customer questions the agent successfully addressed | Customer questions followed by a non-empty agent response |

### Audio Empathy Metrics

| Metric | Description |
|--------|-------------|
| **Empathy Score** | Composite score (0-100) blending audio prosody (50%) and text-based empathy (50%) |
| **Pitch Analysis** | Mean, standard deviation, and range of vocal pitch indicating emotional engagement |
| **Tempo & Energy** | Speech rate (BPM) and energy levels (RMS) reflecting pacing and confidence |
| **Voice Quality** | Zero crossing rate and spectral centroid measuring vocal warmth |
| **Consistency** | Variation of pitch and energy across conversation segments |

### Scoring Metrics

| Metric | Description |
|--------|-------------|
| **Overall Score** | Weighted percentage across all rubric sections (0-100%) |
| **Letter Grade** | A through F based on overall score thresholds |
| **Pass/Fail** | Binary outcome; any critical criteria failure results in automatic fail |
| **Critical Failures** | Count and details of failed critical criteria with reasoning |
| **Per-Section Scores** | Breakdown across 6 rubric sections with individual criteria results |

---

## Deployment

The prototype is deployed using AWS Cloud Development Kit (CDK) v2 with TypeScript, organized into three independent stacks that can be deployed individually or together:

### CDK Stacks

**CallCenterTraining-Core (AgentCore Stack)**
Shared infrastructure including:
- VPC (10.0.0.0/16 with public and private subnets across 2 availability zones)
- VPC endpoints for Bedrock, ECR, CloudWatch, Secrets Manager, S3, DynamoDB
- S3 buckets (see Storage Detail below)
- 3 DynamoDB tables (see Data Storage Detail below)
- ECR repository for the agent Docker image
- Bedrock AgentCore Runtime configuration
- IAM roles and security groups

**CallCenterTraining-Web (Web UI Stack)**
Web application resources including:
- Cognito User Pool (email sign-in, no self-signup, password policy enforced) with admin and trainee groups
- Cognito Identity Pool for temporary AWS credentials (presigned URLs)
- CloudFront distribution serving the React frontend
- HTTP API Gateway with JWT authorization and CORS
- 5 Lambda functions: Trainee API, Admin API, Scoring, Screen Analysis, Audio Empathy

**CallCenterTraining-Connect (Connect Stack)**
Phone integration resources including:
- Amazon Connect AI Agent configuration (Q Connect backend)
- AI Agent orchestration via Amazon Bedrock (Claude Haiku)
- Session Setup Lambda (injects scenario data into AI Agent sessions)
- Post-call scoring Lambda triggered via EventBridge
- Connect admin Lambda API
- CloudFront-hosted Connect admin UI

### Data Storage Detail

#### DynamoDB Tables

All tables use on-demand billing (PAY_PER_REQUEST) with point-in-time recovery enabled.

| Table | Partition Key | Sort Key | GSIs | Purpose |
|-------|--------------|----------|------|---------|
| Scenarios | `scenarioId` (S) | — | — | Scenario definitions (context, challenges, criteria, difficulty, caller gender) |
| Sessions | `userId` (S) | `sessionId` (S) | TimestampIndex (`gsiPk`/`timestamp`), ContactIdIndex (`contactId`) | Session metadata, scores, admin comments |
| CriteriaConfig | `scenarioId` (S) | — | — | Per-scenario evaluation criteria overrides (disabled criteria set) |

**Sessions table fields:** userId, sessionId, userName, scenarioId, scenarioName, timestamp, customerMood, difficulty, score, grade, passed, adminComment (text + author + timestamps), contactId, tokenUsage (per-component token counts for cost tracking).

**TimestampIndex:** All sessions have `gsiPk="ALL"`, enabling a single query to retrieve all sessions sorted by timestamp — used by the admin dashboard to list trainees with latest scores.

**ContactIdIndex:** Maps Amazon Connect contactId to sessionId, enabling the post-call Lambda to look up the session when EventBridge fires after a call ends.

#### S3 Buckets

| Stack | Bucket | Encryption | Lifecycle | Purpose |
|-------|--------|-----------|-----------|---------|
| Core | Recordings | KMS (key rotation) | Glacier after 90d, delete after 365d | Audio, transcripts, scorecards, screen recordings |
| Core | Recordings Access Logs | KMS | 90-day expiration | Server access logs for recordings bucket |
| Web | Frontend Assets | KMS (key rotation) | — | React app served via CloudFront |
| Web | Frontend Access Logs | KMS | 90-day expiration | Server access logs for frontend |
| Web | CloudFront Logs | S3-managed (AES-256)* | 90-day expiration | CloudFront distribution logs |
| Connect | Admin UI Frontend | KMS (key rotation) | — | React admin app served via CloudFront |
| Connect | Admin UI Access Logs | KMS | 90-day expiration | Server access logs for admin frontend |
| Connect | Admin UI CloudFront Logs | S3-managed (AES-256)* | 90-day expiration | Admin UI CloudFront logs |

*CloudFront standard logging does not support KMS-encrypted destinations.

All buckets: public access blocked, SSL enforcement enabled.

**Recordings Bucket Key Patterns:**
```
users/{userId}/sessions/{sessionId}/{sessionId}_audio.webm
users/{userId}/sessions/{sessionId}/{sessionId}_server_transcript.json
users/{userId}/sessions/{sessionId}/{sessionId}_client_transcript.json
users/{userId}/sessions/{sessionId}/{sessionId}_scorecard.json
users/{userId}/sessions/{sessionId}/{sessionId}_screen_recording.webm
```

#### Cognito Authentication & Authorization

**User Pool:** Email sign-in, self-signup disabled (admin-managed enrollment), password policy (8+ chars, upper/lower/digit/symbol), PLUS feature plan with full threat protection.

| Group | API Routes | Capabilities |
|-------|-----------|-------------|
| trainee | `/scenarios`, `/sessions` | List/view scenarios, create sessions, upload audio/screen recordings, invoke AgentCore WebSocket |
| admin | `/admin/*` | All trainee capabilities + view all trainees/sessions/scorecards, manage scenarios (CRUD + AI generation), configure evaluation criteria, add comments, access recordings/transcripts via presigned URLs |

**Authorization flow:** API Gateway validates JWT signature and expiration → Admin Lambda additionally checks `cognito:groups` claim for "admin" membership → returns 403 if not admin. Trainee routes are open to all authenticated users.

**Identity Pool:** Provides temporary AWS credentials via Cognito Identity. Token-based role mapping assigns `adminAuthenticatedRole` to admin group members, granting S3, Bedrock AgentCore, and KMS permissions. Default authenticated role applies to trainee group members with the same base permissions.

### Prerequisites and Setup

The following tools and configurations are required:

- Python 3.13 or later
- Node.js 18+ and npm (for CDK and frontend build)
- AWS CLI configured with appropriate credentials and permissions
- AWS CDK CLI (`npm install -g aws-cdk`)
- Docker (for building the AgentCore container image)

The deploying AWS account must have access to Amazon Bedrock models (Nova 2 Sonic v1 for voice, Claude Sonnet 4.6 for evaluation) in the target region (us-west-2). If using the Amazon Connect integration, a Connect instance must be pre-created with the appropriate contact flows configured.

**Local Testing:** The `scripts/test_local.py` and `scripts/test_local_duo.py` scripts allow testing scenarios locally without deploying to AgentCore, using the same system prompts and tools as production. Console-based voice testing requires headphones since echo cancellation is not available in terminal mode (the browser Web UI handles echo cancellation via WebRTC).

### Configuration

Deployment parameters are defined in `deployment/config.json`:

- **VPC configuration:** CIDR range (10.0.0.0/16), number of availability zones (2), NAT gateway count (1)
- **VPC endpoints:** Toggles for interface endpoints (Bedrock AgentCore, Bedrock Runtime, ECR, CloudWatch Logs, Secrets Manager) and gateway endpoints (S3, DynamoDB)
- **Agent configuration:** Voice model ID (`amazon.nova-2-sonic-v1:0`), evaluation model ID (`us.anthropic.claude-sonnet-4-6`), Connect conversation model ID (`us.anthropic.claude-haiku-4-5-20251001-v1:0`), available voices
- **Connect configuration (optional):** Connect instance ARN, contact flow ID, destination phone number

### CDK Deployment Process

Before the first deployment, install Node.js dependencies in each project directory:

```bash
cd deployment && npm install          # CDK infrastructure dependencies
cd ../frontend/app && npm install     # Web UI React app (needed for --webui or --all)
cd ../../connect-admin/app && npm install  # Connect Admin UI React app (needed for --connect or --all)
```

A deployment script (`deployment/deploy.sh`) orchestrates the build and deployment. The script checks for `node_modules` in each required directory and will exit with an error if dependencies are missing.

```bash
# Full deployment (all 3 stacks in dependency order)
./deployment/deploy.sh --all

# Individual stacks
./deployment/deploy.sh --agentcore
./deployment/deploy.sh --webui
./deployment/deploy.sh --connect

# Direct CDK deployment of a single stack
cd deployment && npm run build && cdk deploy CallCenterTraining-Core \
  --require-approval never \
  --region us-west-2
```

The deployment process builds CDK TypeScript code, synthesizes CloudFormation templates, deploys stacks, syncs the React frontend to S3, and creates a CloudFront cache invalidation.

First-time deployment requires `cdk bootstrap` in the target account/region. Subsequent deployments are incremental.

---

## Cost Estimates

This section presents an estimation of the AWS infrastructure costs to run this prototype. These estimates use standard public AWS pricing for us-west-2. AWS offers enterprise discounts via Private Pricing - consult your AWS Account team for organization-specific pricing. The main purpose of this exercise is to highlight the key cost drivers and optimization levers.

### Assumptions

- **Training volume:** 100 agents, 20 training sessions per agent per month = 2,000 sessions/month
- **Average session duration:** ~95 seconds of bidirectional audio
- **Nova Sonic tokens per session:** ~195,069 input + ~58,382 output (measured from full training session)
- **Claude Sonnet scoring tokens per evaluation:** ~3,976 input + ~3,409 output (measured)
- **Claude Sonnet screen analysis tokens per session:** ~12,226 input + ~920 output (10 screenshots over 100s)
- **AgentCore Runtime per session:** ~0.026 vCPU-hours + ~3.15 GB-hours (measured across 10 sessions)
- **AI Agent orchestration tokens per Connect session:** ~17,341 input + ~258 output across ~11 turns (measured from 133-second call) - **cost included in $0.038/min voice service charge**
- **Web UI mode only** (Connect adds telephony and voice service costs)

### Monthly Cost Estimate

| Service | Unit Price | Usage/Month | Estimated Monthly Cost |
|---------|-----------|-------------|----------------------|
| **Amazon Bedrock - Nova Sonic** | $3.00/M input, $12.00/M output | 2,000 sessions (390.1M input + 116.8M output) | ~$2,572 |
| **Amazon Bedrock - Claude Sonnet 4.6** (scoring) | $3.00/M input, $15.00/M output | 2,000 evaluations (7.95M input + 6.82M output) | ~$126 |
| **Amazon Bedrock - Claude Sonnet 4.6** (screen analysis) | $3.00/M input, $15.00/M output | 2,000 sessions (24.5M input + 1.8M output) | ~$101 |
| **Bedrock AgentCore Runtime** | $0.0895/vCPU-hr, $0.00945/GB-hr | 2,000 sessions (51.8 vCPU-hrs + 6,300 GB-hrs) | ~$64 |
| **AWS Lambda** | $0.0000166667/GB-sec | 7 functions, ~50,000 invocations | ~$15 |
| **Amazon DynamoDB** (on-demand) | $1.25/M write, $0.25/M read | ~10,000 writes, ~50,000 reads | ~$1 |
| **Amazon S3** (storage) | $0.023/GB + KMS | ~50 GB recordings/month | ~$5 |
| **Amazon CloudFront** | $0.085/GB + $0.0100/10K requests | ~10 GB transfer, ~100K requests | ~$2 |
| **NAT Gateway** | $0.045/hr + $0.045/GB | 1 gateway, ~20 GB processed | ~$34 |
| **VPC Endpoints** (6 interface) | $0.01/hr/AZ each | 6 endpoints x 2 AZs x 730 hrs | ~$88 |
| **Amazon Cognito** | Free tier up to 50K MAU | 100 MAU | $0 |
| **Amazon API Gateway v2** | $1.00/M requests | ~100K requests | ~$1 |
| **Amazon ECR** | $0.10/GB | ~2 GB image | ~$1 |
| | | **Estimated Total (Web UI)** | **~$3,010/month** |

### Per-Session Cost Breakdown

Each training session incurs the following variable costs (measured from a 95-second session):

| Component | Calculation | Cost per Session |
|-----------|------------|-----------------|
| **Nova Sonic** (voice) | 195K input × $3.00/M + 58K output × $12.00/M | ~$1.29 |
| **Claude Sonnet** (scoring) | 4.0K input × $3.00/M + 3.4K output × $15.00/M | ~$0.06 |
| **Claude Sonnet** (screen analysis) | 12.2K input × $3.00/M + 0.9K output × $15.00/M | ~$0.05 |
| **AgentCore Runtime** | 0.026 vCPU-hrs × $0.0895 + 3.15 GB-hrs × $0.00945 | ~$0.03 |
| **Lambda, DynamoDB, S3, API GW** | Per-invocation and storage | ~$0.01 |
| | **Variable cost per session** | **~$1.43** |

Fixed monthly infrastructure costs (always-on regardless of session count):

| Component | Monthly Cost |
|-----------|-------------|
| VPC Endpoints (6 interface) | ~$88 |
| NAT Gateway | ~$34 |
| ECR, CloudFront, Cognito | ~$4 |
| **Fixed total** | **~$126/month** |

### Realistic Usage Scenario: Cohort-Based Training

The 2,000 sessions/month estimate above assumes steady-state usage. In practice, BPO teams are more likely to run training in cohorts — onboarding a group of new agents with a concentrated burst of sessions, then pausing until the next cohort. Usage will be intermittent and spikey rather than continuous.

**Example: 70 new agents × 10 training sessions = 700 sessions over ~2 weeks**

| Component | Cost |
|-----------|------|
| Variable costs (700 sessions × $1.43) | ~$1,001 |
| Fixed infrastructure (1 month) | ~$126 |
| **Total for training cohort** | **~$1,127** |
| **Cost per agent** (10 sessions) | **~$16.10** |
| **Cost per session** | **~$1.61** |

If infrastructure is shut down between cohorts (e.g., removing VPC endpoints and NAT Gateway when not in use), fixed costs only apply during active training months. With Connect voice pricing (~$0.09/session for voice service + telephony, replacing $1.29 Nova Sonic + $0.03 AgentCore), the variable cost drops to ~$0.27/session, reducing the cohort total to approximately $315 — or ~$4.50 per agent.

### Additional Costs for Amazon Connect Mode

| Service | Unit Price | Usage/Month | Estimated Monthly Cost |
|---------|-----------|-------------|----------------------|
| **Amazon Connect** (telephony) | $0.018/min outbound | 2,000 calls x 1.6 min | ~$58 |
| **Amazon Connect** (voice service) | $0.038/min (includes Nova Sonic STT/TTS) | 2,000 calls x 1.6 min | ~$122 |
| **Contact Lens** (analytics) | $0.015/min | 2,000 calls x 1.6 min | ~$48 |
| | | **Connect Add-on Total** | **~$228/month** |

**Note:** The Amazon Connect voice service charge ($0.038/min) includes Amazon Nova Sonic for speech-to-text and text-to-speech. Amazon Connect AI Agents use Claude Haiku via Amazon Bedrock for conversation generation (text response generation), with no separate per-token charges — both Nova Sonic and Claude Haiku costs are included in the voice service pricing. There is no Lex V2 usage in the current implementation; AI Agents handle conversation directly through the Q Connect backend.

**Connect Mode Limitations:**

- **Additional latency:** Connect mode uses Amazon Connect AI Agents which introduce latency compared to the Web UI's bidirectional streaming. The AI Agent architecture processes each turn as: Nova Sonic STT → Claude Haiku (text generation via Bedrock) → Nova Sonic TTS. This three-step pipeline has higher latency than the Web UI's AgentCore container, which runs Nova Sonic's native bidirectional speech-to-speech model locally with direct BidiAgent control.
- **No Strands Agents support:** Connect mode uses Amazon Connect AI Agents with Bedrock orchestration rather than the Strands Agents SDK available in the Web UI's AgentCore container. This means several Web UI features are unavailable in Connect mode, including the verify spelling tool (which spells out names and policy numbers letter-by-letter for confirmation) and duo/multi-character scenarios (which rely on Strands agent tool calling for character handoffs).
- **No screen capture:** The Web UI captures periodic screenshots of the trainee's screen during calls and analyzes them with Claude vision for compliance checking. Connect mode (phone-based) has no equivalent screen capture. Two options to address this: (1) Amazon Connect provides native screen recording for agents using the Connect agent workspace, which could be leveraged if trainees use the Connect CCP during training; (2) the Web UI's screen capture logic could be ported to the Connect admin UI, allowing supervisors who monitor training sessions via the admin dashboard to have screen activity captured and analyzed alongside the call.

### Key Cost Drivers

1. **Bedrock Nova Sonic + AgentCore Runtime** (~88% of Web UI cost): Voice streaming ($2,572) and container runtime ($64) are by far the largest cost drivers. Token consumption scales with session duration and conversational complexity. Optimization: shorter practice sessions, session time limits, consider Nova Sonic Lite if available, or migrate to Connect voice pricing to eliminate both costs.
2. **Bedrock Claude Sonnet** (~8%): Scoring evaluation and screen analysis combined. Scales with evaluation count and transcript length. Optimization: consider Nova Lite for preliminary screening, cache rubric prompts.
3. **VPC Endpoints** (~3%): Fixed cost regardless of usage. Optimization: evaluate which endpoints are essential; consider using NAT Gateway for low-traffic services instead.
4. **NAT Gateway** (~1%): Fixed hourly cost plus data processing. Already minimized with VPC endpoints for high-traffic services.

### Important Notes

- **Token usage logging** has been added to the prototype. All Bedrock model invocations (Nova Sonic, Claude scoring, screen analysis) log input/output token counts to CloudWatch and include them in the scorecard JSON. This enables precise cost tracking from real usage data.
- All token counts above are measured from a real training session. Actual usage will vary by scenario length, complexity, and number of screenshots captured.
- Nova Sonic dominates costs at ~87% of the total. Session duration is the primary cost lever — token consumption scales roughly linearly with call length.
- Bedrock allows a maximum of 20 concurrent Nova Sonic connections per AWS account. Each active training session consumes one connection. Request a quota increase if needed.
- S3 lifecycle policies transition recordings to Glacier after 30 days and delete after 365 days, reducing long-term storage costs.
- Costs scale roughly linearly with the number of training sessions. At 10x volume (20,000 sessions/month), expect approximately 10x the variable costs with fixed costs (VPC endpoints, NAT Gateway) remaining constant.

### Known Unknowns for Business Case

The following items will need to be resolved to build a comprehensive business case. These are not blockers for the prototype but represent gaps that should be addressed before production commitment:

1. **Session Duration at Scale:** The prototype measured a 95-second session. Production training sessions may be significantly longer (3-10 minutes), which would increase Nova Sonic costs proportionally. Conduct pilot sessions with real trainees to establish a representative duration distribution.

2. **Token Consumption Variance:** Nova Sonic token usage varies by scenario complexity, customer mood, conversational depth, and hold duration. Measure across a representative sample of scenarios and difficulty levels to establish reliable per-session cost ranges.

3. **Training Volume Projections:** The estimates assume 100 agents × 20 sessions/month. Actual ramp-up trajectory, seasonal peaks, and whether the platform will be used for initial training only or ongoing gap training will materially affect costs.

4. **Trainer Time Savings (ROI Baseline):** Quantifying the return on investment requires baseline data on current training costs: trainer FTEs dedicated to role-play, time per trainee per session, trainer-to-trainee ratios, and opportunity cost of pulling experienced agents for coaching. This data is needed to calculate the break-even point.

5. **Training Effectiveness Metrics:** To justify continued investment, define measurable outcomes: improvement in QA scores post-training, reduction in time-to-competency for new hires, decrease in call escalation rates. These require pre/post measurement over a pilot period.

6. **Web UI vs Connect Mix:** If phone-based training via Amazon Connect is used alongside the web UI, telephony costs add ~$164/month at current estimates. The actual mix will depend on trainee preferences and whether connect-based training offers pedagogical advantages (e.g., more realistic phone handling).

7. **Scenario Content Lifecycle:** Creating and maintaining scenarios requires subject matter expertise. Estimate the effort for: initial scenario library expansion, ongoing scenario updates as products/processes change, quality review workflows, and whether the AI scenario generator reduces authoring time sufficiently.

8. **Bedrock Pricing at Scale:** AWS may offer volume discounts or committed throughput pricing for Bedrock models. Engage your AWS account team to explore options such as Provisioned Throughput for Nova Sonic if concurrent session counts are predictable.

9. **Data Retention and Compliance:** Regulatory and compliance requirements (e.g., PCI-DSS for insurance data, internal audit retention policies) may dictate longer retention periods for recordings and transcripts, increasing S3 and KMS costs beyond the current lifecycle policy estimates.

10. **Integration Costs:** Production deployment may require integration with existing systems: Learning Management Systems (LMS), quality management platforms, HR/workforce management tools, and SSO/identity providers beyond Cognito. These integration efforts carry their own development and maintenance costs.

11. **Duo Mode Maturity:** Multi-character (duo) scenarios require additional development before production readiness. Scenario prompt engineering for duo mode is significantly more difficult than single-character scenarios — each character needs carefully crafted handoff triggers, identity boundaries, and behavioral constraints. Currently, handoffs between characters are unreliable: calling the other person by name is the only method that consistently triggers a handoff, while other natural conversational cues are often missed. The underlying issue is that Nova Sonic's tool calling (used for the `hand_off` tool) is not yet reliable enough for seamless multi-character coordination. Production-quality duo mode may need to wait for additional platform features such as Swarm-style multi-agent orchestration for BidiAgents or improvements to Nova Sonic's tool calling reliability.

12. **Customer Mood Simulation Limitation:** Amazon Nova Sonic does not natively support a customer mood parameter. The prototype's mood selection (neutral, frustrated, confused, etc.) works by embedding mood instructions into the scenario system prompt, which influences tone indirectly. This approach is functional but less controllable than a native mood parameter. Some alternative voice models (e.g., ElevenLabs) offer direct emotion and tone controls that could provide more reliable mood simulation. Evaluate whether prompt-based mood control meets training fidelity requirements during pilot testing.

---

## Outcomes

### Functional Outcomes

- AI-powered customer simulation using Amazon Nova Sonic for realistic bidirectional voice conversations, with configurable customer personas, moods, and difficulty levels across 18+ pre-built insurance scenarios
- Automated performance evaluation using Claude (Sonnet 4.6) with a comprehensive rubric containing 30+ criteria across 6 sections, producing detailed scorecards with letter grades, per-criterion feedback, and critical failure identification
- Multi-character (duo) scenario support enabling realistic multi-party interactions with AI-driven character handoffs during a single training session. This is an experimental feature and was not part of the scope or even stretch goals.
- Admin dashboard for scenario management (CRUD operations, AI-powered scenario generation from call transcripts), trainee management, and per-scenario evaluation criteria configuration
- Session recording with stereo audio capture (agent and customer on separate channels), real-time transcription, and S3 storage with KMS encryption and lifecycle policies
- Real-time transcript display with talk-over detection — segments where the trainee speaks over the customer are highlighted in amber for immediate visual feedback
- Amazon Connect integration providing phone-based training as an alternative to the web UI, with automatic post-call scoring via EventBridge triggers

### Non-Functional Outcomes

- The prototype codebase, including all CDK infrastructure code, Lambda functions, agent server code, frontend application, and scenario definitions, is provided as a complete, deployable package
- Comprehensive documentation including this prototype report, architecture overview, and deployment instructions
- The prototype follows AWS Well-Architected Framework principles including KMS encryption for all storage, VPC isolation for all compute, least-privilege IAM policies (no AWS managed policies), and Cognito-based authentication with self-registration disabled

### Success Criteria Results

| Criteria | Description | Result |
|----------|-------------|--------|
| SC1 | Ability to use platform to simulate inbound calls adequately and free up trainer based on scenarios | Achieved |
| SC2 | Ability for trainers to select specific call types and personas (initial and gap training) | Achieved |
| SC3 | Provide initial scorecard on call for trainer and supervisor to review | Achieved |

---

## Recommendations

### Technical Recommendations

- **Load Testing and Auto-Scaling:** Conduct load testing to determine appropriate Lambda concurrency limits and DynamoDB capacity settings. Consider reserved capacity for DynamoDB if usage patterns become predictable.
- **Monitoring and Observability:** Implement CloudWatch dashboards and alarms for key metrics including Lambda error rates, Bedrock API latency, WebSocket connection failures, and scoring pipeline throughput.
- **CI/CD Pipeline:** Establish a continuous integration and deployment pipeline to automate testing, building, and deploying changes across all three CDK stacks.
- **Multi-Region Considerations:** The current deployment targets us-west-2. For production resilience, evaluate multi-region deployment strategies, particularly for the DynamoDB tables (global tables) and S3 buckets (cross-region replication).
- **Scenario Content Management:** As the scenario library grows, consider implementing version control for scenarios and a review/approval workflow for new content before it becomes available to trainees.
- **Cost Optimization — Connect Voice Pricing:** The most impactful cost optimization is migrating from direct Bedrock Nova Sonic (token-based pricing) to Amazon Connect's voice service, which bundles Nova Sonic into a flat $0.038/min rate. This reduces voice AI costs by ~94% ($2,572 → $152/month at current volume). Connect supports in-app and web calling — not just telephony — making this viable for the web UI mode. This would also unify the Web UI and Connect architectures and provide Contact Lens analytics for all sessions. The trade-off is replacing the AgentCore/BidiAgent WebSocket pattern with Connect's in-app calling SDK and contact flow framework.
- **Cost Optimization — General:** Monitor Bedrock model invocation costs closely as usage scales. Evaluate Nova Lite as a lower-cost alternative for scoring. Leverage S3 Intelligent-Tiering for recording storage if access patterns are unpredictable.
- **Nova Sonic Quota:** Bedrock allows a maximum of 20 concurrent Nova Sonic connections per AWS account. Each active training session -- whether via the Web UI or Amazon Connect -- consumes one connection. Consult with your account team if you need a quota increase.
- **Amazon Connect Evaluations:** Although we have implemented the Scoring Lambda function to be auto triggered when an Amazon Connect call ends, we recommend that you use Amazon Connect evaluations for rubric scoring. Your account team can help you with enablement. The current Connect implementation fails to associate the outbound call with the inbound call which leads to failure to identify which trainer took the call. One possible solution is to use a pool of outbound phone numbers to allow for this association.
- **Strands BidiAgent:** Strands BidiAgent is experimental. We recommend upgrading to the latest version of Strands as soon as v1 is released. Moreover, the multi-character mode is implemented using a hand off tool. Another option would be using a multi agent architecture such as Swarm. Although Strands does not currently support use of BidiAgents in multi agent architecture, we recommend testing this approach once it becomes available.

### Alternative Voice Models

The prototype uses Amazon Nova Sonic for bidirectional voice streaming. The following alternative voice AI services are worth evaluating alongside Nova Sonic, each with different trade-offs in capability, cost, and AWS integration depth.

| Service | Type | AWS Integration | Pricing | Key Strength | Key Trade-off |
|---------|------|----------------|---------|--------------|---------------|
| **Deepgram** | Voice Agent API (STT + LLM + TTS) | Amazon Connect integration, AWS Marketplace (45-day trial) | $0.08/min standard; $0.05/min BYO LLM+TTS; STT only: $0.0077/min | Call center-optimized, self-hostable, HIPAA/GDPR compliant | Voice quality (TTS) may not match Nova Sonic naturalness |
| **ElevenLabs** | Conversational AI Platform (STT + LLM + TTS) | External API | Enterprise pricing (not publicly listed) | Best-in-class voice quality, 5,000+ voices across 31 languages, voice cloning | Not on AWS, no Connect integration, adds external dependency |
| **OpenAI Realtime API** | Bidirectional Voice (GPT-4o) | External API | Token-based | Strong reasoning + natural voice-to-voice | Not on AWS, external dependency, vendor lock-in |
| **Google Gemini Live** | Bidirectional Voice | External API | Token-based | Multimodal (voice + vision), strong multilingual | Not on AWS, less mature voice quality |

**Deepgram** is purpose-built for voice and call center workloads. Its Voice Agent API provides a unified conversational AI stack with built-in barge-in detection, turn-taking prediction, and function calling. It offers Amazon Connect integration and is available on the AWS Marketplace with a 45-day trial period. Deployment options include fully managed, dedicated single-tenant, in-VPC, or self-hosted configurations with HIPAA and GDPR compliance. Audio intelligence add-ons provide sentiment analysis, intent recognition, and summarization. The BYO (bring your own) LLM+TTS option at $0.05/min allows pairing Deepgram's STT with a preferred LLM and TTS provider for maximum flexibility. Deepgram also offers $200 in free credits to start.

**ElevenLabs Conversational AI (Eleven Agents)** is a full-stack conversational AI platform — not just TTS. It combines a fine-tuned ASR model, LLM orchestration, and industry-leading TTS with proprietary turn-taking technology. The platform offers 5,000+ voices across 31 languages with voice cloning capability. Native SDKs are available for React, iOS (Swift), Android (Kotlin), and React Native. Telephony integration is supported via SIP trunking and Twilio. Built-in features include conversation analysis, A/B testing, and automated agent testing — useful for training quality assurance. The main trade-off is that it operates outside the AWS ecosystem with no native Amazon Connect integration.

**Mood & Emotion Support:** Nova Sonic does not expose a customer mood parameter, so the prototype embeds mood directives in the system prompt. ElevenLabs offers native emotion controls and voice style parameters. Deepgram's audio intelligence includes sentiment analysis. When evaluating alternatives, consider whether native mood/emotion APIs would improve training realism over prompt-based mood simulation.

**Recommendation:** For AWS-native deployments, Deepgram is the strongest alternative given its Connect integration and Marketplace availability. ElevenLabs offers the best voice quality and largest voice library if an external API dependency is acceptable.

---

## Scenario Development

There are two approaches to building training scenarios, both defined as structured JSON files:

### Approach 1: Context-Only (Improvised Dialogue)

Define the customer's persona, personal details, and situation. Nova Sonic improvises all dialogue naturally based on this context. This is the primary approach used by most scenarios in the prototype.

The scenario context is written in second person ("You are Donald Derk, the owner of JNL policy number 8214...") and includes:
- Personal details the customer knows and can provide when asked (name, DOB, SSN, policy number, address, email)
- The customer's situation — why they are calling and what they want
- Emotional context that shapes how the customer reacts

Nova Sonic generates natural, conversational responses based on this context without any scripted dialogue. The AI adapts to whatever the trainee says, creating a unique conversation each time.

### Approach 2: Context + Conditional Directives (Guided Responses)

In addition to the context above, define specific responses to specific agent actions using conditional conversation directives embedded in the context field. This approach is used when a scenario requires precise pivotal moments — for example, a customer who should only reveal certain information when asked in a specific way, or who should escalate emotionally at a particular point in the conversation.

Conditional directives follow the pattern:
- "When the agent tells you [X], respond by [Y]"
- "If the agent asks about [topic], say [specific response]"
- "Do NOT mention [detail] unless the agent specifically asks about it"

This gives scenario authors fine-grained control over critical moments while still allowing Nova Sonic to improvise the rest of the conversation naturally.

### Scenario Generator

The prototype includes a scenario generator that converts raw call transcripts into structured scenario JSON using Claude. It extracts the customer persona, personal details, situation, key challenges, success criteria, and conditional directives from the transcript. The admin dashboard exposes this via the API (`POST /admin/scenarios/generate`), allowing trainers to create new scenarios by pasting a call transcript directly in the UI.

### Local Testing

Scenarios can be tested locally without deploying to AgentCore using the `scripts/test_local.py` script. This connects the scenario to your local microphone and speakers, with Nova Sonic simulating the customer in real time:

```bash
python scripts/test_local.py --scenario jnl_bene_change_01
python scripts/test_local.py --scenario jnl_bene_change_01 --voice tiffany --mood frustrated
python scripts/test_local.py --scenario jnl_bene_change_01 --text-only
python scripts/test_local.py --list  # List all available scenarios
```

For multi-character (duo) scenarios, use `scripts/test_local_duo.py`, which runs multiple BidiAgents with distinct voices and supports real-time handoffs between characters:

```bash
python scripts/test_local_duo.py
python scripts/test_local_duo.py --scenario athene_tax_call_01_duo --mood frustrated
python scripts/test_local_duo.py --voice customer_1=matthew --voice customer_2=tiffany
python scripts/test_local_duo.py --text-only
```

This enables rapid scenario iteration — authors can test a scenario immediately after creating it, without requiring a full deployment cycle.

---

## Scenario Schema

Scenarios are defined as JSON files loaded by the `ScenarioLoader` (`src/scenarios/loader.py`). The schema supports both single-character and multi-character (duo) scenarios.

### Single-Character Scenario Fields

| Field | Type | Description |
|-------|------|-------------|
| `scenario_id` | string | Unique identifier (e.g., `jnl_bene_change_01`) |
| `name` | string | Display name (e.g., "JNL Bene Change") |
| `context` | string | Second-person customer profile including personal details, situation, and optional conditional directives |
| `key_challenges` | string[] | 4-7 challenges for the agent (what makes the call difficult) |
| `success_criteria` | string[] | 5-8 observable behaviors the agent should demonstrate |
| `difficulty` | string | `"beginner"`, `"intermediate"`, or `"advanced"` |
| `original_call_logs` | string | Full transcript from the original real call (used by the generator and as reference) |
| `initial_message` | string | Customer's first utterance when the agent greets them |
| `caller_gender` | string | `"male"` or `"female"` (determines default voice selection) |

### Multi-Character (Duo) Additional Fields

Duo scenarios add a `characters` array. When present with more than one entry, the system activates multi-character mode with handoff support.

| Field | Type | Description |
|-------|------|-------------|
| `characters[].id` | string | Character identifier (e.g., `customer_1`) |
| `characters[].name` | string | Character's name (e.g., "Jay Forrester") |
| `characters[].voice` | string | Nova Sonic voice ID (e.g., `matthew`, `tiffany`) |
| `characters[].gender` | string | `"male"` or `"female"` |
| `characters[].is_primary` | boolean | Whether this character speaks first |
| `characters[].context` | string | Character-specific persona and situation |
| `characters[].initial_message` | string | Character's opening line (primary character only) |
| `characters[].handoff_trigger` | string | Condition for handing off (e.g., "agent asks to speak with Merry") |
| `characters[].handoff_to` | string | Target character ID to hand off to |

---

## Scenario Inventory

| File | Name | Type | Carrier/Topic |
|------|------|------|---------------|
| antelope_death_claim_01.json | Antelope Death Claim | Single | Antelope - Death claim processing |
| antelope_surrender_inquiry_01.json | Antelope Surrender | Single | Antelope - Surrender inquiry |
| antelope_unauthorized_pushy_01.json | Antelope Unauthorized Caller - Pushy | Single | Antelope - Unauthorized caller (aggressive) |
| antelope_unauthorized_wrong_info_01.json | Antelope Unauthorized Caller - Wrong Info | Single | Antelope - Unauthorized caller (incorrect info) |
| antelope_underpaying_ul_01.json | Antelope Underpaying UL | Single | Antelope - Underpaying universal life |
| athene_death_notification_01.json | Athene Death Notification | Single | Athene - Death notification |
| athene_loan_01.json | Athene Loan Request | Single | Athene - Loan request |
| athene_tax_call_01.json | Athene Tax Call - PO with Spouse | Duo | Athene - Tax form with spouse handoff |
| athene_tax_call_01_duo.json | Athene Tax Call - PO with Spouse | Duo | Athene - Tax form with spouse (duo variant) |
| athene_withdrawal_01.json | Athene - Urgent Withdrawal | Single | Athene - Urgent withdrawal request |
| bhf_disbursement_inquiry_01.json | BHF Impatient RMD | Single | BHF - Impatient RMD disbursement |
| bhf_form_request_01.json | BHF BOA Form Request | Single | BHF - Beneficiary form request |
| gafg_child_rider_01.json | GAFG Child Rider | Single | GAFG - Child rider inquiry |
| jnl_accelerated_benefit_01.json | JNL Accelerated Benefit | Single | JNL - Accelerated benefit |
| jnl_bene_change_01.json | JNL Bene Change | Single | JNL - Beneficiary change |
| jnl_db_value_01.json | JNL DB Value | Single | JNL - Death benefit value |
| jnl_surrender_inquiry_01.json | JNL Trustee Surrender | Single | JNL - Trustee surrender |
| jnl_values_and_benes_01.json | JNL Values and Benes | Single | JNL - Values and beneficiaries |
| legacy_dbx_01.json | DBX Project | Single | Legacy DBX project |
| metlife_death_claim_followup_01.json | MetLife Life Death Claim Follow Up | Single | MetLife - Death claim follow-up |

---

## Rubric Structure

The evaluation rubric (`rubrics/default.json`) defines the scoring criteria used by Claude to evaluate training sessions.

### Sections

| Section | Name | Focus Area |
|---------|------|------------|
| 1 | Security | Identity verification, DOB/SSN, policy number, relationship, broker info |
| 2 | Professional Call Handling | Courteous behavior, opening/closing, acknowledgment, expectations management |
| 3 | Complete/Correct Information | Product knowledge, feature/benefit explanations |
| 4 | Time Efficiency | Appropriate pacing, minimal dead air, efficient call handling |
| 5 | Scripting & Scope | Following scripts, staying within scope of authority |
| 6 | Reducing Customer Effort | First-call resolution, clear next steps, minimizing transfers |

### Criticality Levels

- **Critical:** Binary pass/fail. Full points if passed, zero if failed. Any critical failure causes the entire evaluation to be marked as FAIL regardless of other scores.
- **Non-Critical:** Partial credit allowed. AI assigns a score from 0 to max_points. Contributes to the weighted percentage score.

### Grading

- Percentage score = (total points awarded / total possible points) x 100
- Letter grades: A (90-100%), B (80-89%), C (70-79%), D (60-69%), F (<60%)
- Pass threshold: 70% AND no critical failures

### Per-Scenario Customization

Administrators can enable/disable specific criteria per scenario via the CriteriaConfig DynamoDB table and the admin UI. This allows tailoring evaluations to the specific learning objectives of each scenario.

---

## Key File Reference

| Component | File Path | Purpose |
|-----------|-----------|---------|
| **Agent Server** | `src/agent/server.py` | FastAPI WebSocket server (AgentCore container) |
| **Duo Session** | `src/agent/duo_session.py` | Multi-character handoff logic |
| **System Prompt** | `src/customer_prompt.py` | System prompt generation for Nova Sonic |
| **Scenario Loader** | `src/scenarios/loader.py` | Load scenarios from JSON/DynamoDB |
| **Scenario Seeder** | `scripts/seed_scenarios.py` | Seeds DynamoDB Scenarios table from JSON files |
| **Local Test (Single)** | `scripts/test_local.py` | Local voice agent testing without AgentCore deployment |
| **Local Test (Duo)** | `scripts/test_local_duo.py` | Local multi-character duo mode testing |
| **Session Recorder** | `src/recording/session_recorder.py` | Transcript capture and S3 upload |
| **Scoring Engine** | `src/evaluators/scoring_engine.py` | Claude evaluation orchestration |
| **Transcript Analytics** | `src/evaluators/transcript_analytics.py` | Call metrics computation |
| **Audio Empathy** | `src/evaluators/audio_empathy_evaluator.py` | Prosodic analysis via librosa |
| **Scorecard Model** | `src/models/call_scorecard.py` | Scorecard schema + scoring logic |
| **Trainee Lambda** | `src/lambda/trainee/index.py` | Scenario listing, session creation |
| **Admin Lambda** | `src/lambda/admin/index.py` | Scenario CRUD, trainee management |
| **Scoring Lambda** | `src/lambda/scoring/index.py` | Async scoring orchestration |
| **Screen Analysis Lambda** | `src/lambda/screen_analysis/index.py` | Screen capture analysis |
| **Audio Empathy Lambda** | `src/lambda/audio_empathy/index.py` | Empathy scoring Lambda wrapper |
| **Connect Lambda** | `src/lambda/connect_lambda/index.py` | Outbound call initiation |
| **Post-Call Lambda** | `src/lambda/connect_postcall/index.py` | Contact Lens processing |
| **AI Agent Session Setup** | `src/lambda/ai_agent_session_setup/index.py` | Injects scenario data into AI Agent sessions |
| **WebSocket Presigned** | `frontend/app/src/services/websocket-presigned.ts` | Client-side presigned URL generation |
| **Scenario Selection** | `frontend/app/src/components/ScenarioSelection.tsx` | Scenario picker UI |
| **Training Session** | `frontend/app/src/components/TrainingSession.tsx` | Audio I/O and transcript display |
| **Scoring Results** | `frontend/app/src/components/ScoringResults.tsx` | Scorecard display |
| **Core CDK Stack** | `deployment/lib/agentcore-stack.ts` | VPC, S3, DynamoDB, AgentCore |
| **Web CDK Stack** | `deployment/lib/webui-stack.ts` | Cognito, CloudFront, API Gateway, Lambdas |
| **Connect CDK Stack** | `deployment/lib/connect-stack.ts` | AI Agents, Connect integration, EventBridge |
| **Deploy Config** | `deployment/config.json` | VPC, model IDs, Connect ARNs |
| **Deploy Script** | `deployment/deploy.sh` | Multi-stack deployment orchestration |
| **Default Rubric** | `rubrics/default.json` | Medical insurance evaluation rubric |

---

## Security Recommendations

### 1. Executive Summary

The Call Center Training Agent prototype demonstrates a strong architectural foundation using serverless AWS services (Lambda, DynamoDB, S3, CloudFront, API Gateway) with Amazon Bedrock AI integration (Nova Sonic, Nova 2 Lite). Authentication is handled via dual Amazon Cognito User Pools with role-based access control.

A comprehensive security assessment was performed covering infrastructure-as-code analysis, threat modeling (STRIDE methodology), and a Well-Architected Framework review. The prototype scored 6.0/10 overall maturity with the Security pillar at 5/10, indicating that while the foundation is sound, significant hardening is required before production deployment.

### 2. Current Security Strengths

The prototype already incorporates several security best practices:

- Lambda functions deployed within a VPC with dedicated security groups per function
- Comprehensive VPC Endpoints for private connectivity to AWS services (Bedrock, ECR, CloudWatch, Secrets Manager, S3, DynamoDB)
- Five KMS Customer Managed Keys with key rotation enabled for encryption at rest
- S3 buckets configured with public access blocked, SSL-only policies, and CloudFront Origin Access Identity
- CDK Nag integration with both AWS Solutions and Prototype Security Nag Packs applied
- Infrastructure as Code via AWS CDK with modular, well-organized constructs

### 3. Critical Recommendations (Address Before Production)

#### 3.1 Identity and Access Management

IAM policies require tightening to enforce least-privilege principles. Several roles use wildcard permissions that, while documented with suppression reasons for the prototype, must be scoped to specific resource ARNs for production. Key actions:

- Audit all IAM policies and replace wildcard resource permissions with explicit ARNs
- Implement IAM Permissions Boundaries for compute resources that create IAM resources
- Ensure IAM roles (not IAM Users) are used for all service access
- Implement separation of duties via IAM Identity Center user group strategy
- Monitor IAM Identity Center management API events via CloudTrail
- Implement automatic secret rotation via AWS Secrets Manager

**References:**
- [IAM Access Analyzer](https://aws.amazon.com/iam/access-analyzer/) — review actual access patterns to reduce policy scope to achieve least privilege
- [IAM Access Analyzer User Guide](https://docs.aws.amazon.com/IAM/latest/UserGuide/what-is-access-analyzer.html)

#### 3.2 Container Security

All Dockerfiles (audio_empathy, connect_lambda, connect_postcall) currently run as root. For production:

- Add non-root user directives to all container images
- Add HEALTHCHECK instructions to all Dockerfiles
- Implement regular image vulnerability scanning
- Establish an image hardening process

#### 3.3 Data Encryption

While KMS encryption is applied to S3 buckets and key rotation is enabled, gaps remain:

- Enable KMS Customer Managed Key encryption on all three DynamoDB tables (currently using AWS-managed keys)
- Encrypt all CloudWatch Log Groups with KMS
- Confirm encryption of data in transit across all service integrations

### 4. High-Priority Recommendations (Address During Production Hardening)

#### 4.1 Reliability and Resilience

- Configure Dead Letter Queues (DLQ) on all Lambda functions to capture and retry failed invocations
- Enable S3 versioning on all data buckets to support recovery from accidental deletions
- Enable DynamoDB Point-in-Time Recovery (PITR) on all tables
- Set Lambda reserved concurrent execution limits to prevent runaway invocations
- Implement retry logic with exponential backoff for Bedrock API calls
- Define Recovery Time Objective (RTO) and Recovery Point Objective (RPO) targets

#### 4.2 Observability and Monitoring

- Create CloudWatch Dashboards for key operational metrics (Lambda errors/duration, API Gateway error rates, DynamoDB throttling, Bedrock token usage)
- Implement CloudWatch Alarms with SNS notifications for error thresholds
- Enable AWS X-Ray distributed tracing on all Lambda functions and API Gateways
- Create operational runbooks for common failure scenarios
- Implement AWS Budgets with alerts at 50%, 80%, and 100% of expected monthly spend

#### 4.3 Network Security

- Define firewall rules to allow only necessary traffic with deny-by-default posture
- Evaluate use of AWS Network Firewall or AWS Firewall Manager for centralized policy management
- Activate VPC Flow Logs on key network segments with appropriate retention policies
- Ensure routing rules restrict internet access to only subnets that require it

### 5. Production Readiness Recommendations

#### 5.1 Logging and Compliance

- Configure production log levels (disable DEBUG/INFO in production)
- Ensure no sensitive data (PII, session tokens, credentials) appears in log output
- Implement log retention policies (30–90 days based on compliance requirements)
- Enable CloudTrail for API auditing across all services
- Consider Amazon Macie for PII detection in S3 data stores

#### 5.2 AI/ML-Specific Security

- Enable Bedrock model invocation logging for responsible AI compliance
- Configure Bedrock Guardrails for content filtering (harmful categories and prompt attacks)
- Implement alerting on Guardrail interventions
- Enable PII redaction in Amazon Connect and any transcription services
- Ensure the Bedrock agent has a least-privileged IAM role
- Implement a data retention policy for AI-generated content and training session data

**References:**
- [OWASP AI Top 10 Testing Guide](https://github.com/OWASP/www-project-ai-testing-guide)
- [Cloud Security Alliance (CSA) MAESTRO AI Threat Model](https://github.com/CloudSecurityAlliance/MAESTRO)

#### 5.3 Cost Governance

- Implement AWS Budgets with automated alerts tied to Bedrock token consumption
- Set Lambda concurrency limits proportional to expected load to cap Bedrock costs
- Evaluate VPC Endpoint consolidation (6 Interface Endpoints at ~$43/month fixed cost)
- Implement S3 Intelligent-Tiering or lifecycle policies for audio recordings after scoring

#### 5.4 Maintenance and Lifecycle

- Upgrade Node.js runtime from v18 (EOL November 2025) to v20 LTS or later
- Establish a process for periodic dependency scanning and updates
- Implement regular container image vulnerability scanning
- Validate open-source library licenses against approved lists
- Generate a Software Bill of Materials (SBOM) for the solution

### 6. Threat Model Summary

A STRIDE-based threat model identified 7 threats with 9 mitigations. Current mitigation status:

| Threat Area | Status | Notes |
|-------------|--------|-------|
| EC2/VPC ingress exposure | Mitigated | Security groups restrict inbound access |
| IAM over-permissive policies | Partially Mitigated | Wildcard permissions documented but need scoping |
| S3 public data exposure | Mitigated | Public access blocked on all buckets |
| S3 repudiation | Mitigated | Access logging enabled |
| S3 man-in-the-middle | Mitigated | SSL-only bucket policies enforced |
| CloudFront bypass | Mitigated | Origin Access Identity configured |
| Unnecessary security groups | Mitigated | Descriptions required on all groups |

### 7. Recommended Prioritization

| Priority | Category | Effort | Impact |
|----------|----------|--------|--------|
| P1 — Immediate | IAM least-privilege hardening | Medium | Prevents privilege escalation |
| P1 — Immediate | Container non-root user | Low | Prevents container breakout |
| P1 — Immediate | DynamoDB CMK encryption | Low | Meets encryption-at-rest requirements |
| P1 — Immediate | Secrets management cleanup | Low | Prevents credential exposure |
| P2 — Before Launch | Lambda DLQ and concurrency limits | Medium | Prevents data loss and cost overruns |
| P2 — Before Launch | S3 versioning and DynamoDB PITR | Low | Enables data recovery |
| P2 — Before Launch | CloudWatch alarms and dashboards | Medium | Enables operational visibility |
| P3 — Post-Launch | X-Ray tracing | Medium | Improves debugging capability |
| P3 — Post-Launch | Bedrock Guardrails and PII redaction | Medium | Responsible AI compliance |
| P3 — Post-Launch | Cost governance (Budgets, lifecycle) | Low | Controls operational costs |

---

## Links and References

- Amazon Bedrock AgentCore Documentation: https://docs.aws.amazon.com/bedrock/latest/userguide/agentcore.html
- Strands Agents SDK: https://github.com/strands-agents/sdk-python
- Amazon Nova Sonic: https://docs.aws.amazon.com/nova/latest/userguide/speech.html
- AWS CDK Documentation: https://docs.aws.amazon.com/cdk/v2/guide/home.html
- Amazon Connect Administrator Guide: https://docs.aws.amazon.com/connect/latest/adminguide/
- Pool of phone numbers for Amazon Connect transfers: https://github.com/aws-samples/Transfers_from_Legacy_Platform_into_Amazon_Connect
