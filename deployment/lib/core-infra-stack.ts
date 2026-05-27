/**
 * Core Infra Stack - Shared Backend Infrastructure
 *
 * Contains infrastructure shared by the Web UI and Connect stacks:
 * - VPC + VPC Endpoints + Flow Logs
 * - S3 Storage (recordings) + KMS encryption
 * - DynamoDB tables (scenarios, criteria config, sessions)
 *
 * AgentCore runtime, agent IAM role, agent Docker image, and the bedrock-agentcore
 * VPC endpoint live in the separate AgentRuntimeStack, since only the Web UI needs them.
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';
import * as fs from 'fs';
import { NagSuppressions } from 'cdk-nag';

import { S3StorageConstruct } from './constructs/storage';
import { DynamoDBTablesConstruct } from './constructs/dynamodb-tables';
import { EncryptLogsAspect } from './utils/encrypt-logs-aspect';

export interface CoreInfraStackProps extends cdk.StackProps {
  // No additional props needed - config loaded from config.json
}

export class CoreInfraStack extends cdk.Stack {
  /** VPC for private connectivity */
  public readonly vpc: ec2.Vpc;
  /** S3 storage construct (recordings + scoring buckets) */
  public readonly storage: S3StorageConstruct;
  /** DynamoDB tables (scenarios + criteria config) */
  public readonly dynamoTables: DynamoDBTablesConstruct;
  /** Security group for Bedrock VPC endpoints */
  public readonly bedrockEndpointSg: ec2.SecurityGroup;
  /** VPC CIDR (from config) for consumers that need to add SG rules */
  public readonly vpcCidr: string;
  /** Whether the bedrock-agentcore VPC endpoint should be created by consumers */
  public readonly createBedrockAgentCoreEndpoint: boolean;

  constructor(scope: Construct, id: string, props?: CoreInfraStackProps) {
    super(scope, id, props);

    // Load configuration
    const configPath = path.join(__dirname, '../config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    this.vpcCidr = config.vpcConfig.vpcCidr;
    this.createBedrockAgentCoreEndpoint = config.vpcEndpoints.createBedrockAgentCoreEndpoint;

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
    // KMS-encrypted log group (Checkov CKV_AWS_158).
    const flowLogsKey = new kms.Key(this, 'FlowLogsEncryptionKey', {
      description: 'KMS key for encrypting VPC flow log CloudWatch log group',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    flowLogsKey.addToResourcePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
      actions: [
        'kms:Encrypt*',
        'kms:Decrypt*',
        'kms:ReEncrypt*',
        'kms:GenerateDataKey*',
        'kms:Describe*',
      ],
      resources: ['*'],
      conditions: {
        ArnLike: {
          'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${this.region}:${this.account}:log-group:*`,
        },
      },
    }));

    const flowLogsGroup = new logs.LogGroup(this, 'VpcFlowLogsLogGroup', {
      retention: logs.RetentionDays.THREE_MONTHS,
      encryptionKey: flowLogsKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.vpc.addFlowLog('VpcFlowLogs', {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogsGroup),
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
      description: 'Security group for Bedrock VPC endpoints',
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
        reason: 'This application uses bedrock-agentcore endpoint (created in AgentRuntimeStack), not bedrock-agent-runtime.',
      },
      {
        id: 'Prototype Security Nag Pack-VPC Endpoint for batch',
        reason: 'AWS Batch is not used by this application.',
      },
    ]);

    // Allow any VPC resource (e.g., admin Lambda in Web stack) to reach Bedrock endpoints.
    // Using VPC CIDR avoids cross-stack SG references that would create cyclic dependencies.
    this.bedrockEndpointSg.addIngressRule(
      ec2.Peer.ipv4(config.vpcConfig.vpcCidr),
      ec2.Port.tcp(443),
      'Allow VPC resources to call Bedrock Runtime',
    );

    // ========================================
    // Storage - S3 Bucket for Recordings
    // ========================================
    this.storage = new S3StorageConstruct(this, 'Storage');

    // ========================================
    // DynamoDB Tables (scenarios + criteria config + sessions)
    // ========================================
    this.dynamoTables = new DynamoDBTablesConstruct(this, 'DynamoTables');

    // ========================================
    // CloudWatch Log Group encryption
    // ========================================
    cdk.Aspects.of(this).add(new EncryptLogsAspect(flowLogsKey));
  }
}
