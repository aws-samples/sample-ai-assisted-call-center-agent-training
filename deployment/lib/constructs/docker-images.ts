/**
 * Docker Images Construct
 * Builds and manages ECR Docker image assets for training agent
 */

import { Construct } from 'constructs';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as path from 'path';

export class DockerImagesConstruct extends Construct {
  public readonly agentImage: ecr_assets.DockerImageAsset;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // Build agent container image.
    // The Dockerfile COPYs only requirements.txt and src/ — exclude everything
    // else so that CDK's asset hash only changes when those inputs change.
    this.agentImage = new ecr_assets.DockerImageAsset(this, 'AgentImage', {
      directory: path.join(__dirname, '../../..'),  // Project root
      file: 'src/agent/Dockerfile',
      platform: ecr_assets.Platform.LINUX_ARM64,  // AgentCore requires ARM64
      exclude: [
        // Version control & editor
        '.git',
        '.gitignore',
        '.vscode',
        '.DS_Store',
        // Project tooling
        '.claude',
        '.dockerignore',
        '.env',
        '.env.*',
        // Python artifacts
        '**/.venv',
        '**/__pycache__',
        '**/.pytest_cache',
        '**/*.pyc',
        // Node artifacts
        '**/node_modules',
        // Directories NOT used in Docker image
        'deployment',
        'frontend',
        'connect-admin',
        'docs',
        'examples',
        'tests',
        'lib',
        'rubrics',
        'scenarios',
        'scripts',
        'recordings',
        'evaluations',
        // File types NOT used in Docker image
        '*.md',
        '*.xlsx',
      ],
    });
  }
}
