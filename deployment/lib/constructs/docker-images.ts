/**
 * Docker Images Construct
 * Builds and manages ECR Docker image assets for training agent
 */

import { IgnoreMode } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as path from 'path';

export class DockerImagesConstruct extends Construct {
  public readonly agentImage: ecr_assets.DockerImageAsset;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.agentImage = new ecr_assets.DockerImageAsset(this, 'AgentImage', {
      directory: path.join(__dirname, '../../..'),  // Project root
      file: 'src/agent/Dockerfile',
      platform: ecr_assets.Platform.LINUX_ARM64,  // AgentCore requires ARM64
      ignoreMode: IgnoreMode.DOCKER,
      // Allowlist: exclude everything, then re-include only what the Dockerfile COPYs.
      // Parents must be re-included before narrowing their children.
      exclude: [
        '*',
        '!requirements.txt',
        '!src',
        'src/*',
        '!src/__init__.py',
        '!src/customer_prompt.py',
        '!src/voices.py',
        '!src/agent',
        '!src/agent/**',
        '!src/config',
        '!src/config/**',
        '!src/scenarios',
        '!src/scenarios/**',
        '!src/recording',
        '!src/recording/**',
        '**/__pycache__',
        '**/*.pyc',
      ],
    });
  }
}
