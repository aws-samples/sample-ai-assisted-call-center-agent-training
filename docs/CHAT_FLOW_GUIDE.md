# Converting Voice Flow to Chat Flow

## Quick Guide: Modify AIAgentFlow for Chat Channel

### What to Change

#### 1. **Remove Voice-Specific Blocks**
- **Delete**: "Set voice" block (`UpdateContactTextToSpeechVoice`)
  - This block sets TTS voice (matthew/tiffany/amy)
  - Not needed for chat (text-only)

#### 2. **Update Recording & Analytics Block**
- **Block**: "Set recording and analytics behavior" (`UpdateContactRecordingAndAnalyticsBehavior`)
- **Current settings (voice)**:
  ```
  Voice recording: Enabled
  Call analytics: Enabled, Post-contact
  ```
- **New settings (chat)**:
  ```
  Chat analytics: Enabled, Post-contact
  ```
  - Remove voice recording configuration
  - Keep analytics enabled for Contact Lens transcript

#### 3. **Update Lex Bot Block (if needed)**
- **Block**: "Get customer input" (`ConnectParticipantWithLexBot`)
- **Current**: May have voice-specific session attributes like `voice_id`
- **Change**: Remove voice_id attribute for chat
- **Keep**: `x-amz-lex:q-in-connect:ai-agent-arn` attribute (works for both voice and chat)

### What to Keep (Works for Both Voice and Chat)

✅ **Entry message** - "MessageParticipant" works for both voice (TTS) and chat (text)

✅ **Create Wisdom Session** blocks - Channel-agnostic, works for both

✅ **Invoke Lambda Function** (Session Setup) - Works for both voice and chat
  - Lambda uses `DescribeContact` which returns WisdomInfo for both channels
  - Scenario injection works identically

✅ **Set contact attributes** - Works for both channels

✅ **Error handling** - Keep all error branches, just ensure error messages are text-appropriate

✅ **Disconnect** - Works for both channels

### Summary of Changes

| Block Type | Action | Reason |
|------------|--------|--------|
| UpdateContactTextToSpeechVoice | **DELETE** | Chat doesn't use TTS |
| UpdateContactRecordingAndAnalyticsBehavior | **MODIFY** | Change from voice recording to chat analytics |
| ConnectParticipantWithLexBot | **REVIEW** | Remove voice_id if present |
| All other blocks | **KEEP** | Channel-agnostic |

### Testing the Chat Flow

1. **Import flow** in Connect Console
2. **Publish** the flow
3. **Copy flow ID** and add to `deployment/config.json`:
   ```json
   "chatContactFlowId": "<your-chat-flow-id>"
   ```
4. **Test** with the script:
   ```bash
   python scripts/start_chat.py --scenario athene_death_notification_01 --profile salehanw+dxc-admin
   ```

### Key Points

- **Same AI Agent** can be used for both voice and chat (ID: `2fb8826c-da11-4502-b667-e1c08df19edd`)
- **Same Session Setup Lambda** works for both channels
- **Same scenario injection** mechanism works identically
- Voice uses Nova Sonic (speech), chat uses Claude (text) - automatic based on channel

### Contact Flow Settings

When creating the chat flow in Connect Console:

1. **Type**: Contact flow (not IVR or customer queue flow)
2. **Channel**: CHAT (or leave as default - it will detect based on start_chat_contact)
3. **Name**: Something like "ChatTrainingFlow" or "AIAgentChatFlow"

### Verification

After deployment, the post-call Lambda will automatically:
- Detect channel type (VOICE vs CHAT)
- Skip audio processing for chat
- Process Contact Lens transcript (same format for both)
- Invoke scoring Lambda (same for both)

No Lambda code changes needed for basic functionality - the post-call Lambda already handles channel detection once you deploy the code updates.
