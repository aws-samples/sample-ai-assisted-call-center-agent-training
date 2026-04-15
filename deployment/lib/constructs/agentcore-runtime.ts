/**
 * AgentCore Runtime Construct
 * Creates Bedrock AgentCore runtime for training agent with VPC support and Cognito authentication
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { MODEL_IDS } from '../utils/model-config';

export interface AgentCoreRuntimeProps {
  agentImage: ecr_assets.DockerImageAsset;
  agentRole: iam.Role;
  recordingsBucketName: string;
  kmsKeyId: string;
  // VPC configuration
  agentSecurityGroups: string[];
  subnetIds: string[];
  // Authentication configuration (optional)
  userPool?: cognito.IUserPool;
  userPoolClient?: cognito.IUserPoolClient;
  /** DynamoDB scenarios table name for runtime scenario loading */
  scenariosTableName: string;
}

export class AgentCoreRuntimeConstruct extends Construct {
  public readonly agentRuntime: agentcore.CfnRuntime;

  constructor(scope: Construct, id: string, props: AgentCoreRuntimeProps) {
    super(scope, id);

    const region = cdk.Stack.of(this).region;

    // Get Cognito discovery URL for JWT authentication
    const discoveryUrl = props.userPool
      ? `https://cognito-idp.${region}.amazonaws.com/${props.userPool.userPoolId}/.well-known/openid-configuration`
      : undefined;

    // Training Agent Runtime
    this.agentRuntime = new agentcore.CfnRuntime(this, 'TrainingAgentRuntime', {
      agentRuntimeName: 'call_center_training_agent',
      agentRuntimeArtifact: {
        containerConfiguration: {
          containerUri: props.agentImage.imageUri,
        },
      },
      networkConfiguration: {
        networkMode: 'VPC',
        networkModeConfig: {
          securityGroups: props.agentSecurityGroups,
          subnets: props.subnetIds,
        },
      },
      roleArn: props.agentRole.roleArn,
      description: 'AI-powered call center training agent with Nova Sonic voice capabilities',
      environmentVariables: {
        AWS_REGION: region,
        LOG_LEVEL: 'INFO',
        S3_RECORDINGS_BUCKET: props.recordingsBucketName,
        S3_KMS_KEY_ID: props.kmsKeyId,
        SCENARIOS_TABLE: props.scenariosTableName,
        NOVA_SONIC_MODEL_ID: MODEL_IDS.novaSonic,
        NOVA_LITE_MODEL_ID: MODEL_IDS.novaLite,
      },
    });

    // Outputs
    new cdk.CfnOutput(scope, 'AgentRuntimeArn', {
      value: this.agentRuntime.attrAgentRuntimeArn,
      description: 'ARN of the training agent runtime',
    });

    new cdk.CfnOutput(scope, 'AgentRuntimeId', {
      value: this.agentRuntime.attrAgentRuntimeId,
      description: 'ID of the training agent runtime',
    });
  }
}
