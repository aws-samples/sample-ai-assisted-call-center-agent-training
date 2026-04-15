/**
 * Media upload service.
 * Uploads screen recording video and audio recordings (WebM) directly to S3 using Cognito credentials.
 */

import { fetchAuthSession } from 'aws-amplify/auth';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const region = import.meta.env.VITE_AWS_REGION || 'us-west-2';

/**
 * Upload a screen recording video to S3.
 *
 * @param sessionId - Training session ID
 * @param blob - WebM video blob from MediaRecorder
 * @returns S3 URI of the uploaded recording
 */
export const uploadScreenRecording = async (
  sessionId: string,
  blob: Blob,
  userId: string
): Promise<string> => {
  const bucketName = import.meta.env.VITE_RECORDINGS_BUCKET;

  if (!bucketName) {
    throw new Error(
      'Recordings bucket not configured. Set VITE_RECORDINGS_BUCKET environment variable.'
    );
  }

  const { credentials } = await fetchAuthSession();
  if (!credentials) {
    throw new Error('Not authenticated - no credentials available');
  }

  const key = `users/${userId}/sessions/${sessionId}/${sessionId}_screen_recording.webm`;

  console.log(`[ScreenRecording] Uploading ${(blob.size / 1024 / 1024).toFixed(1)} MB to s3://${bucketName}/${key}`);

  const s3Client = new S3Client({
    region,
    credentials,
  });

  const arrayBuffer = await blob.arrayBuffer();

  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: new Uint8Array(arrayBuffer),
    ContentType: 'video/webm',
  });

  await s3Client.send(command);

  const s3Uri = `s3://${bucketName}/${key}`;
  console.log(`[ScreenRecording] Upload complete: ${s3Uri}`);
  return s3Uri;
};

/**
 * Upload an audio recording to S3.
 *
 * @param sessionId - Training session ID
 * @param blob - WebM audio blob from MediaRecorder
 * @returns S3 URI of the uploaded audio
 */
export const uploadAudioRecording = async (
  sessionId: string,
  blob: Blob,
  userId: string
): Promise<string> => {
  const bucketName = import.meta.env.VITE_RECORDINGS_BUCKET;

  if (!bucketName) {
    throw new Error(
      'Recordings bucket not configured. Set VITE_RECORDINGS_BUCKET environment variable.'
    );
  }

  const { credentials } = await fetchAuthSession();
  if (!credentials) {
    throw new Error('Not authenticated - no credentials available');
  }

  const key = `users/${userId}/sessions/${sessionId}/${sessionId}_audio.webm`;

  console.log(`[AudioRecording] Uploading ${(blob.size / 1024 / 1024).toFixed(1)} MB to s3://${bucketName}/${key}`);

  const s3Client = new S3Client({
    region,
    credentials,
  });

  const arrayBuffer = await blob.arrayBuffer();

  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: new Uint8Array(arrayBuffer),
    ContentType: 'audio/webm',
  });

  await s3Client.send(command);

  const s3Uri = `s3://${bucketName}/${key}`;
  console.log(`[AudioRecording] Upload complete: ${s3Uri}`);
  return s3Uri;
};

/**
 * Upload enriched transcript with accurate audio timing to S3.
 * Contains client-side measured audio_start_time and audio_duration for each turn.
 * Used by the scoring Lambda for accurate call analytics (silence, talk-overs, etc.).
 *
 * @param sessionId - Training session ID
 * @param turns - Enriched transcript turns with timing data
 * @returns S3 URI of the uploaded transcript
 */
export const uploadEnrichedTranscript = async (
  sessionId: string,
  turns: Array<{
    speaker: string;
    text: string;
    audio_start_time: number;
    audio_duration: number;
    timestamp: string;
  }>,
  userId: string
): Promise<string> => {
  const bucketName = import.meta.env.VITE_RECORDINGS_BUCKET;

  if (!bucketName) {
    throw new Error(
      'Recordings bucket not configured. Set VITE_RECORDINGS_BUCKET environment variable.'
    );
  }

  const { credentials } = await fetchAuthSession();
  if (!credentials) {
    throw new Error('Not authenticated - no credentials available');
  }

  const key = `users/${userId}/sessions/${sessionId}/${sessionId}_client_transcript.json`;
  const body = JSON.stringify(turns, null, 2);

  console.log(`[EnrichedTranscript] Uploading ${turns.length} turns to s3://${bucketName}/${key}`);

  const s3Client = new S3Client({
    region,
    credentials,
  });

  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: body,
    ContentType: 'application/json',
  });

  await s3Client.send(command);

  const s3Uri = `s3://${bucketName}/${key}`;
  console.log(`[EnrichedTranscript] Upload complete: ${s3Uri}`);
  return s3Uri;
};
