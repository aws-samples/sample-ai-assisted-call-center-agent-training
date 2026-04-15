/**
 * WebSocket service with client-side presigned URL generation
 * Uses Cognito AWS credentials to sign WebSocket URLs directly in the browser
 * 
 * Protocol: Strands BidiAgent events (bidi_audio_input, bidi_audio_stream, bidi_transcript_stream, etc.)
 */

import { fetchAuthSession } from 'aws-amplify/auth';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-browser';
import { HttpRequest } from '@smithy/protocol-http';

const region = import.meta.env.VITE_AWS_REGION || 'us-west-2';
const agentRuntimeArn = import.meta.env.VITE_AGENT_RUNTIME_ARN;

export interface WebSocketConfig {
  voiceId?: string;
  systemPrompt?: string;
  scenarioId?: string;
  customerMood?: string;
  languageMode?: string;
  userId?: string;
  userName?: string;
  character_voices?: Record<string, string>;
}

/**
 * Generate presigned WebSocket URL directly with Cognito credentials (client-side)
 */
export const generatePresignedWebSocketUrl = async (
  expires: number = 3600,
  sessionId?: string
): Promise<string> => {
  try {
    if (!agentRuntimeArn) {
      throw new Error('AgentCore Runtime ARN not configured');
    }

    const { credentials } = await fetchAuthSession();
    if (!credentials) {
      throw new Error('Not authenticated - no credentials available');
    }

    console.log('[WebSocket] Generating presigned URL with Cognito credentials (client-side)');

    const hostname = `bedrock-agentcore.${region}.amazonaws.com`;
    const urlPath = `/runtimes/${agentRuntimeArn}/ws`;

    const query: Record<string, string> = {
      qualifier: 'DEFAULT',
    };
    if (sessionId) {
      query['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id'] = sessionId;
      console.log('[WebSocket] Using session ID:', sessionId);
    }

    const request = new HttpRequest({
      method: 'GET',
      protocol: 'https:',
      hostname: hostname,
      path: urlPath,
      query: query,
      headers: {
        host: hostname,
      },
    });

    const signer = new SignatureV4({
      credentials: credentials,
      region: region,
      service: 'bedrock-agentcore',
      sha256: Sha256,
    });

    const signedRequest = await signer.presign(request, {
      expiresIn: expires,
    });

    const queryParts: string[] = [];
    if (signedRequest.query) {
      for (const [key, value] of Object.entries(signedRequest.query)) {
        queryParts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
      }
    }

    const presignedWssUrl = `wss://${hostname}${urlPath}?${queryParts.join('&')}`;

    console.log('[WebSocket] Client-side presigned URL generated successfully');
    console.log('[WebSocket] Expires in:', expires, 'seconds');
    console.log('[WebSocket] URL length:', presignedWssUrl.length);
    console.log('[WebSocket] Has signature:', presignedWssUrl.includes('X-Amz-Signature'));

    return presignedWssUrl;

  } catch (error: any) {
    console.error('[WebSocket] Error generating presigned URL:', error);
    throw new Error(`Failed to generate presigned URL: ${error.message}`);
  }
};

/**
 * WebSocket client for bidirectional streaming with Strands BidiAgent
 * 
 * Protocol:
 * 1. Connect via presigned URL
 * 2. Send session_config with scenario/voice info
 * 3. Send bidi_audio_input events with microphone audio
 * 4. Receive bidi_audio_stream, bidi_transcript_stream, bidi_interruption events
 * 5. Close WebSocket to end session
 */
export class AgentCoreWebSocketClient {
  private ws: WebSocket | null = null;

  async connect(presignedUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log('[WebSocket] Connecting to AgentCore...');

      this.ws = new WebSocket(presignedUrl);

      this.ws.onopen = () => {
        console.log('[WebSocket] Connected successfully');
        resolve();
      };

      this.ws.onerror = (error) => {
        console.error('[WebSocket] Connection error:', error);
        reject(new Error('WebSocket connection failed'));
      };

      this.ws.onclose = (event) => {
        console.log('[WebSocket] Connection closed:', event.code, event.reason);
      };
    });
  }

  /**
   * Send session configuration to start the BidiAgent session.
   * This must be the first message sent after connecting.
   */
  async startSession(config: WebSocketConfig): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    // Send session config — server creates BidiAgent with this info
    await this.sendEvent({
      type: 'session_config',
      scenario_id: config.scenarioId || null,
      voice_id: config.voiceId || 'matthew',
      customer_mood: config.customerMood || 'neutral',
      language_mode: config.languageMode || 'english',
      session_id: null, // Will be set by caller if needed
    });

    // Wait for server to set up the agent
    await this.delay(200);
  }

  /**
   * Send session configuration with a specific session ID.
   */
  async startSessionWithId(config: WebSocketConfig, sessionId: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    await this.sendEvent({
      type: 'session_config',
      scenario_id: config.scenarioId || null,
      voice_id: config.voiceId || 'matthew',
      customer_mood: config.customerMood || 'neutral',
      language_mode: config.languageMode || 'english',
      session_id: sessionId,
      user_id: config.userId || '',
      user_name: config.userName || '',
      ...(config.character_voices ? { character_voices: config.character_voices } : {}),
    });

    await this.delay(200);
  }

  /**
   * Send audio chunk in Strands bidi_audio_input format
   */
  sendAudioChunk(audioBase64: string): void {
    if (!this.ws) return;

    this.sendEvent({
      type: 'bidi_audio_input',
      audio: audioBase64,
      format: 'pcm',
      sample_rate: 16000,
      channels: 1,
    });
  }

  /**
   * Register message handler for incoming Strands events.
   * Events: bidi_audio_stream, bidi_transcript_stream, bidi_interruption,
   *         tool_use_stream, tool_result, session_started, error
   */
  onMessage(callback: (event: any) => void): void {
    if (this.ws) {
      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error parsing message:', error);
        }
      };
    }
  }

  /**
   * End the session by closing the WebSocket.
   * The server will stop the BidiAgent and save the recording.
   */
  async endSession(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private async sendEvent(event: any): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
      await this.delay(50);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}