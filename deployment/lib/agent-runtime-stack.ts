/**
 * Agent Runtime Stack - Web UI's Bedrock AgentCore Runtime
 *
 * Hosts the Strands/Nova Sonic BidiAgent container and everything it uniquely needs:
 * - Agent Docker image (ARM64)
 * - Agent IAM role (bedrock-agentcore.amazonaws.com principal)
 * - bedrock-agentcore VPC endpoint
 * - Agent security group
 * - Bedrock AgentCore Runtime
 *
 * Consumed by the Web UI stack (browser users invoke the runtime directly via the
 * Cognito Identity Pool). The Connect stack does not depend on this stack.
 *
 * Depends on: CoreInfraStack (VPC, shared bedrock endpoint SG, recordings bucket,
 * KMS key, scenarios table).
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { NagSuppressions } from 'cdk-nag';

import { DockerImagesConstruct } from './constructs/docker-images';
import { IamRolesConstruct } from './constructs/iam-roles';
import { AgentCoreRuntimeConstruct } from './constructs/agentcore-runtime';

export interface AgentRuntimeStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  bedrockEndpointSg: ec2.ISecurityGroup;
  recordingsBucket: s3.IBucket;
  encryptionKey: kms.IKey;
  scenariosTable: dynamodb.ITable;
  /** KMS CMK protecting the DynamoDB tables. Required for read access to Scenarios. */
  dynamoEncryptionKey: kms.IKey;
  vpcCidr: string;
  createBedrockAgentCoreEndpoint: boolean;
}

export class AgentRuntimeStack extends cdk.Stack {
  public readonly dockerImages: DockerImagesConstruct;
  public readonly iamRoles: IamRolesConstruct;
  public readonly agentRuntime: AgentCoreRuntimeConstruct;
  public readonly agentSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: AgentRuntimeStackProps) {
    super(scope, id, props);

    // ========================================
    // Docker Image Build
    // ========================================
    this.dockerImages = new DockerImagesConstruct(this, 'DockerImages');

    // ========================================
    // IAM Roles for AgentCore Runtime
    // ========================================
    this.iamRoles = new IamRolesConstruct(this, 'IamRoles', {
      recordingsBucketArn: props.recordingsBucket.bucketArn,
      ecrRepositoryArn: this.dockerImages.agentImage.repository.repositoryArn,
      scenariosTableArn: props.scenariosTable.tableArn,
    });

    // Grant KMS key permissions to agent role
    props.encryptionKey.grantEncryptDecrypt(this.iamRoles.agentRole);
    props.dynamoEncryptionKey.grantDecrypt(this.iamRoles.agentRole);

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
    // bedrock-agentcore VPC Endpoint
    // ========================================
    if (props.createBedrockAgentCoreEndpoint) {
      new ec2.InterfaceVpcEndpoint(this, 'BedrockAgentCoreEndpoint', {
        vpc: props.vpc,
        service: new ec2.InterfaceVpcEndpointService(`com.amazonaws.${this.region}.bedrock-agentcore`),
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [props.bedrockEndpointSg],
      });
    }

    // ========================================
    // Security Group for AgentCore Runtime
    // ========================================
    // Ingress on bedrockEndpointSg is covered by Core's VPC-CIDR rule on that SG, so
    // we do NOT add an SG-to-SG ingress here. Doing so would create a cyclic dep
    // (Core would reference this SG, AgentRuntime already references Core's bucket/KMS).
    this.agentSecurityGroup = new ec2.SecurityGroup(this, 'AgentSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for call center training agent runtime',
      allowAllOutbound: true,
    });

    // ========================================
    // AgentCore Runtime
    // ========================================
    this.agentRuntime = new AgentCoreRuntimeConstruct(this, 'Runtime', {
      agentImage: this.dockerImages.agentImage,
      agentRole: this.iamRoles.agentRole,
      recordingsBucketName: props.recordingsBucket.bucketName,
      kmsKeyId: props.encryptionKey.keyId,
      agentSecurityGroups: [this.agentSecurityGroup.securityGroupId],
      subnetIds: props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
      scenariosTableName: props.scenariosTable.tableName,
    });

    // Ensure IAM role policy is attached before AgentCore Runtime is created
    const roleDefaultPolicy = this.iamRoles.agentRole.node.tryFindChild('DefaultPolicy');
    if (roleDefaultPolicy) {
      this.agentRuntime.agentRuntime.node.addDependency(roleDefaultPolicy);
    }
  }
}
