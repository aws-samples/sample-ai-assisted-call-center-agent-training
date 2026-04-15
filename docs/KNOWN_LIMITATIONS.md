# Known Limitations

## Nova Sonic 55-Second Audio Timeout

Amazon Nova Sonic requires audio bytes or interactive content to be sent at least every **55 seconds** during a bidirectional streaming session. If no audio or content is received within that window, Nova Sonic terminates the session with a `ValidationException`:

```
ValidationException: Timed out waiting for audio bytes or interactive content.
Please ensure gaps between audio bytes and interactive content are less than 55 seconds.
```

### What this affects

- **Web UI sessions**: If a trainee stays silent or idle for over 55 seconds, the session will be disconnected.
- **Test script** (`scripts/test_scenario.py`): If Nova Sonic's response takes long enough that the next `agent.send()` call exceeds the 55-second gap, the session will fail. Scenarios with many long turns are more susceptible.
- **Amazon Connect integration**: Long hold times or extended silence during a call may trigger this timeout.

### Workarounds

- Keep conversation turns concise — shorter agent/customer exchanges reduce the risk of hitting the timeout.
- In the test script, the `--delay` flag controls the pause *between* turns but cannot prevent timeouts caused by long model response times.
- There is no client-side configuration to extend this limit; it is enforced server-side by the Nova Sonic service.

---

## Nova Sonic 8-Minute Session Limit

Nova Sonic enforces an approximately **8-minute maximum** per bidirectional stream connection. When this limit is reached, the service terminates the stream with a `ModelTimeoutException`.

### How it's handled

The Strands `BidiAgent` SDK handles this **automatically**. When the timeout occurs:

1. `BidiNovaSonicModel.receive()` catches the timeout and raises `BidiModelTimeoutError`
2. `_BidiAgentLoop._restart_connection()` stops the old connection
3. A new connection is started with the full conversation history (all prior transcript turns) replayed as text events via `_get_message_history_events()`
4. Audio streaming resumes transparently

### Known gaps in the auto-restart

- **Brief audio loss during reconnection**: There is a ~1-second window during reconnection where user audio is not buffered. Anything the user says during this gap is lost. (The [AWS reference implementation](https://github.com/aws-samples/amazon-nova-samples/tree/main/speech-to-speech/repeatable-patterns/resume-conversation) uses a 10-second ring buffer to avoid this, but Strands does not.)
- **No UI indication**: The frontend receives a `BidiConnectionRestartEvent` but does not display anything to the user — the conversation simply pauses briefly.
- **Conversation history is text-only**: On restart, prior turns are replayed as text, not audio. The model loses audio context (tone, emotion, accent nuances) from before the restart.

---

## Nova Sonic Region Availability

Nova Sonic (`amazon.nova-2-sonic-v1:0`) is only available in specific AWS regions (e.g., `us-west-2`, `us-east-1`, `eu-north-1`). All runtime code reads the region from environment variables (`AWS_REGION`, `AWS_DEFAULT_REGION`, or `VITE_AWS_REGION`) and falls back to `us-west-2` as a default. Deploying to another region requires setting the appropriate env vars and verifying Nova Sonic availability in that region.

---

## Nova Sonic Concurrent Connection Limit

Nova Sonic allows a maximum of **20 concurrent bidirectional stream connections per AWS account**. Each active training session — whether via the Web UI or Amazon Connect — consumes one connection.

### What this means

- With 20 trainees in simultaneous sessions, the 21st session will fail to start.
- The 8-minute auto-restart (see above) briefly consumes a second connection during the reconnection window.
- This is a service quota enforced by AWS and cannot be increased through configuration. Contact AWS support to request a quota increase if needed.

---

## Nova Sonic Voice and Language Constraints

Nova Sonic provides **16 voices** across **7 languages**: English, French, Italian, German, Spanish, Portuguese, and Hindi.

| Constraint | Detail |
|---|---|
| Polyglot voices (speak all supported languages) | Only `matthew` and `tiffany` |
| Hindi-capable voices | Only `kiara` and `arjun` |
| Other non-English voices | Can speak their native language or English only — no cross-language support (e.g., `ambre` speaks French or English, not Spanish) |

The full voice registry is defined in `src/voices.py`.

---

## Nova Sonic Audio Format Constraints

Nova Sonic's bidirectional stream only supports uncompressed PCM audio:

| Direction | Format | Sample Rate | Channels |
|---|---|---|---|
| Input (microphone) | PCM 16-bit | 16,000 Hz | Mono |
| Output (playback) | PCM 16-bit | 24,000 Hz | Mono |

Compressed formats (Opus, MP3, AAC, etc.) are **not supported** over the bidirectional stream. The browser must capture raw PCM from the microphone and decode PCM for playback via the Web Audio API.

---

## Amazon Connect Post-Call Processing Delay

After a training call ends on Amazon Connect, it may take up to **6 minutes** before the session appears in the Connect admin UI. This delay is caused by the EventBridge event delivery pipeline — Connect publishes contact events to EventBridge, which triggers the post-call Lambda for scoring and storage. The delay is inherent to the EventBridge integration and cannot be reduced through configuration.
