/**
 * AgentCore Stack - Shared Backend Infrastructure
 *
 * This stack contains all shared infrastructure used by both the Web UI and Connect deployments:
 * - VPC + VPC Endpoints + Flow Logs
 * - S3 Storage (recordings) + KMS encryption
 * - Docker image build (ECR)
 * - IAM roles for AgentCore
 * - Bedrock AgentCore Runtime (BidiAgent/Nova Sonic container)
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as path from 'path';
import * as fs from 'fs';
import { NagSuppressions } from 'cdk-nag';

// Import modular constructs
import { DockerImagesConstruct } from './constructs/docker-images';
import { S3StorageConstruct } from './constructs/storage';
import { IamRolesConstruct } from './constructs/iam-roles';
import { AgentCoreRuntimeConstruct } from './constructs/agentcore-runtime';
import { DynamoDBTablesConstruct } from './constructs/dynamodb-tables';

export interface AgentCoreStackProps extends cdk.StackProps {
  // No additional props needed - config loaded from config.json
}

export class AgentCoreStack extends cdk.Stack {
  /** VPC for private connectivity */
  public readonly vpc: ec2.Vpc;
  /** S3 storage construct (recordings + scoring buckets) */
  public readonly storage: S3StorageConstruct;
  /** Docker images construct */
  public readonly dockerImages: DockerImagesConstruct;
  /** IAM roles construct */
  public readonly iamRoles: IamRolesConstruct;
  /** AgentCore runtime construct */
  public readonly agentRuntime: AgentCoreRuntimeConstruct;
  /** Security group for AgentCore runtime */
  public readonly agentSecurityGroup: ec2.SecurityGroup;
  /** DynamoDB tables (scenarios + criteria config) */
  public readonly dynamoTables: DynamoDBTablesConstruct;
  /** Security group for Bedrock VPC endpoints */
  public readonly bedrockEndpointSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props?: AgentCoreStackProps) {
    super(scope, id, props);

    // Load configuration
    const configPath = path.join(__dirname, '../config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    // ========================================
    // VPC Configuration
    // ========================================
    this.vpc = new ec2.Vpc(this, 'TrainingAgentVpc', {
      ipAddresses: ec2.IpAddresses.cidr(config.vpcConfig.vpcCidr),
      maxAzs: config.vpcConfig.maxAzs,
      natGateways: config.vpcConfig.natGateways,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    // VPC Flow Logs to CloudWatch (AwsSolutions-VPC7)
    this.vpc.addFlowLog('VpcFlowLogs', {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(),
      trafficType: ec2.FlowLogTrafficType.ALL,
    });

    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      description: 'VPC ID',
    });

    // ========================================
    // VPC Endpoints for Private Connectivity
    // ========================================
    this.bedrockEndpointSg = new ec2.SecurityGroup(this, 'BedrockAgentCoreEndpointSg', {
      vpc: this.vpc,
      description: 'Security group for Bedrock AgentCore VPC endpoint',
      allowAllOutbound: false,
    });

    // Suppress EC23 validation failure — cdk-nag cannot resolve Fn::GetAtt for VPC CIDR at synth time
    NagSuppressions.addResourceSuppressions(this.bedrockEndpointSg, [
      {
        id: 'CdkNagValidationFailure',
        reason: 'Security group ingress rule references VPC CIDR via Fn::GetAtt which cdk-nag cannot resolve at synth time.',
      },
    ]);

    if (config.vpcEndpoints.createBedrockRuntimeEndpoint) {
      new ec2.InterfaceVpcEndpoint(this, 'BedrockRuntimeEndpoint', {
        vpc: this.vpc,
        service: new ec2.InterfaceVpcEndpointService(`com.amazonaws.${this.region}.bedrock-runtime`),
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [this.bedrockEndpointSg],
      });
    }

    if (config.vpcEndpoints.createBedrockAgentCoreEndpoint) {
      new ec2.InterfaceVpcEndpoint(this, 'BedrockAgentCoreEndpoint', {
        vpc: this.vpc,
        service: new ec2.InterfaceVpcEndpointService(`com.amazonaws.${this.region}.bedrock-agentcore`),
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [this.bedrockEndpointSg],
      });
    }

    if (config.vpcEndpoints.createEcrEndpoint) {
      new ec2.InterfaceVpcEndpoint(this, 'EcrApiEndpoint', {
        vpc: this.vpc,
        service: ec2.InterfaceVpcEndpointAwsService.ECR,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [this.bedrockEndpointSg],
      });

      new ec2.InterfaceVpcEndpoint(this, 'EcrDkrEndpoint', {
        vpc: this.vpc,
        service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [this.bedrockEndpointSg],
      });
    }

    if (config.vpcEndpoints.createCloudWatchLogsEndpoint) {
      new ec2.InterfaceVpcEndpoint(this, 'CloudWatchLogsEndpoint', {
        vpc: this.vpc,
        service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [this.bedrockEndpointSg],
      });
    }

    if (config.vpcEndpoints.createSecretsManagerEndpoint) {
      new ec2.InterfaceVpcEndpoint(this, 'SecretsManagerEndpoint', {
        vpc: this.vpc,
        service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [this.bedrockEndpointSg],
      });
    }

    if (config.vpcEndpoints.createS3Gateway) {
      new ec2.GatewayVpcEndpoint(this, 'S3GatewayEndpoint', {
        vpc: this.vpc,
        service: ec2.GatewayVpcEndpointAwsService.S3,
      });
    }

    // DynamoDB Gateway Endpoint (free, no ENI cost)
    new ec2.GatewayVpcEndpoint(this, 'DynamoDBGatewayEndpoint', {
      vpc: this.vpc,
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    // Suppress VPC endpoint warnings for services not used by this application
    NagSuppressions.addResourceSuppressions(this.vpc, [
      {
        id: 'Prototype Security Nag Pack-VPC Endpoint for bedrock-agent-runtime',
        reason: 'This application uses bedrock-agentcore endpoint (which is created), not bedrock-agent-runtime.',
      },
      {
        id: 'Prototype Security Nag Pack-VPC Endpoint for batch',
        reason: 'AWS Batch is not used by this application.',
      },
    ]);

    // ========================================
    // Security Group for AgentCore Runtime
    // ========================================
    this.agentSecurityGroup = new ec2.SecurityGroup(this, 'AgentSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for call center training agent runtime',
      allowAllOutbound: true,
    });

    this.bedrockEndpointSg.addIngressRule(
      this.agentSecurityGroup,
      ec2.Port.tcp(443),
      'Allow agent to call Bedrock AgentCore API'
    );

    // Allow any VPC resource (e.g., admin Lambda in Web stack) to reach Bedrock endpoints.
    // Using VPC CIDR avoids cross-stack SG references that would create cyclic dependencies.
    this.bedrockEndpointSg.addIngressRule(
      ec2.Peer.ipv4(config.vpcConfig.vpcCidr),
      ec2.Port.tcp(443),
      'Allow VPC resources to call Bedrock Runtime'
    );

    // ========================================
    // Storage - S3 Bucket for Recordings
    // ========================================
    this.storage = new S3StorageConstruct(this, 'Storage');

    // ========================================
    // DynamoDB Tables (scenarios + criteria config)
    // ========================================
    this.dynamoTables = new DynamoDBTablesConstruct(this, 'DynamoTables');

    // ========================================
    // Docker Image Build
    // ========================================
    this.dockerImages = new DockerImagesConstruct(this, 'DockerImages');

    // ========================================
    // IAM Roles for AgentCore Runtime
    // ========================================
    this.iamRoles = new IamRolesConstruct(this, 'IamRoles', {
      recordingsBucketArn: this.storage.recordingsBucket.bucketArn,
      ecrRepositoryArn: this.dockerImages.agentImage.repository.repositoryArn,
      scenariosTableArn: this.dynamoTables.scenariosTable.tableArn,
    });

    // Grant KMS key permissions to agent role
    this.storage.encryptionKey.grantEncryptDecrypt(this.iamRoles.agentRole);

    // Suppress IAM5 wildcards that can only be resolved at this stack level
    NagSuppressions.addResourceSuppressions(
      this.iamRoles.agentRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'kms:GenerateDataKey* and kms:ReEncrypt* are standard CDK KMS grant patterns from grantEncryptDecrypt().',
          appliesTo: ['Action::kms:GenerateDataKey*', 'Action::kms:ReEncrypt*'],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'S3 object-level access requires /* suffix. Resource is scoped to the specific recordings bucket.',
          appliesTo: [
            {
              regex: '/Resource::.*\\.Arn>\\/\\*$/g',
            } as any,
          ],
        },
      ],
      true,
    );

    // ========================================
    // AgentCore Runtime
    // ========================================
    this.agentRuntime = new AgentCoreRuntimeConstruct(this, 'Runtime', {
      agentImage: this.dockerImages.agentImage,
      agentRole: this.iamRoles.agentRole,
      recordingsBucketName: this.storage.recordingsBucket.bucketName,
      kmsKeyId: this.storage.encryptionKey.keyId,
      agentSecurityGroups: [this.agentSecurityGroup.securityGroupId],
      subnetIds: this.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
      scenariosTableName: this.dynamoTables.scenariosTable.tableName,
    });

    // Ensure IAM role policy is attached before AgentCore Runtime is created
    const roleDefaultPolicy = this.iamRoles.agentRole.node.tryFindChild('DefaultPolicy');
    if (roleDefaultPolicy) {
      this.agentRuntime.agentRuntime.node.addDependency(roleDefaultPolicy);
    }
  }
}
