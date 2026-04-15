import * as path from 'path';
import * as fs from 'fs';

const configPath = path.join(__dirname, '../../config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

export const MODEL_IDS = {
  evaluation: config.agent.evaluationModelId as string,
  novaSonic: config.agent.voiceModelId as string,
  novaLite: config.agent.liteModelId as string,
};

/**
 * Strips the regional prefix from a cross-region inference profile ID.
 * e.g. "us.anthropic.claude-sonnet-4-6" → "anthropic.claude-sonnet-4-6"
 *      "amazon.nova-2-sonic-v1:0" → "amazon.nova-2-sonic-v1:0" (unchanged)
 */
export function baseModelId(modelId: string): string {
  return modelId.replace(/^us\./, '');
}

/**
 * Returns IAM resource ARNs for a Bedrock model (foundation-model + inference-profile).
 * Only includes the inference-profile ARN if the model uses a regional prefix.
 */
export function bedrockModelArns(
  modelId: string,
  region: string,
  account: string,
  options?: { wildcard?: boolean },
): string[] {
  const base = baseModelId(modelId);
  const suffix = options?.wildcard ? '*' : '';
  const arns = [
    `arn:aws:bedrock:*::foundation-model/${base}${suffix}`,
  ];
  if (modelId !== base) {
    arns.push(
      `arn:aws:bedrock:${region}:${account}:inference-profile/${modelId}${suffix}`,
    );
  }
  return arns;
}
