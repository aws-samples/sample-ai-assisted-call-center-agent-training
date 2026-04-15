/**
 * IAM Roles Construct
 * Creates IAM roles for AgentCore runtime with Bedrock and S3 permissions
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NagSuppressions } from 'cdk-nag';
import { MODEL_IDS, bedrockModelArns } from '../utils/model-config';

export interface IamRolesConstructProps {
  recordingsBucketArn: string;
  ecrRepositoryArn: string;
  scenariosTableArn: string;
}

export class IamRolesConstruct extends Construct {
  public readonly agentRole: iam.Role;

  constructor(scope: Construct, id: string, props: IamRolesConstructProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    // Create IAM role for training agent runtime with inline policies
    this.agentRole = new iam.Role(this, 'AgentRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'IAM role for Call Center Training Agent runtime',
      inlinePolicies: {
        EcrImageAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
              resources: [props.ecrRepositoryArn],
            }),
          ],
        }),
        EcrTokenAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['ecr:GetAuthorizationToken'],
              resources: ['*'],
            }),
          ],
        }),
        BedrockAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'bedrock:InvokeModel',
                'bedrock:InvokeModelWithResponseStream',
                'bedrock:Converse',
              ],
              resources: [
                ...bedrockModelArns(MODEL_IDS.novaSonic, stack.region, stack.account),
                ...bedrockModelArns(MODEL_IDS.novaLite, stack.region, stack.account),
              ],
            }),
          ],
        }),
        CloudWatchLogsGroup: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['logs:DescribeLogStreams', 'logs:CreateLogGroup'],
              resources: [`arn:aws:logs:${stack.region}:${stack.account}:log-group:/aws/bedrock-agentcore/runtimes/*`],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['logs:DescribeLogGroups'],
              resources: [`arn:aws:logs:${stack.region}:${stack.account}:log-group:*`],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['logs:GetLogEvents', 'logs:DescribeLogGroups', 'logs:DescribeLogStreams'],
              resources: [`arn:aws:logs:${stack.region}:${stack.account}:log-group:/aws/codebuild/*`],
            }),
          ],
        }),
        CloudWatchLogsStream: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
              resources: [`arn:aws:logs:${stack.region}:${stack.account}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*`],
            }),
          ],
        }),
        XRayTracing: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'xray:PutTraceSegments',
                'xray:PutTelemetryRecords',
                'xray:GetSamplingRules',
                'xray:GetSamplingTargets',
              ],
              resources: ['*'],
            }),
          ],
        }),
        CloudWatchMetrics: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['cloudwatch:PutMetricData'],
              resources: ['*'],
              conditions: {
                StringEquals: {
                  'cloudwatch:namespace': 'bedrock-agentcore',
                },
              },
            }),
          ],
        }),
        AgentCorePlatformAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['bedrock-agentcore:*'],
              resources: [
                `arn:aws:bedrock-agentcore:${stack.region}:${stack.account}:*`,
              ],
            }),
          ],
        }),
        AgentCoreIamAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'iam:CreateRole',
                'iam:DeleteRole',
                'iam:GetRole',
                'iam:PutRolePolicy',
                'iam:DeleteRolePolicy',
                'iam:AttachRolePolicy',
                'iam:DetachRolePolicy',
                'iam:TagRole',
                'iam:ListRolePolicies',
                'iam:ListAttachedRolePolicies',
              ],
              resources: [
                `arn:aws:iam::${stack.account}:role/*BedrockAgentCore*`,
                `arn:aws:iam::${stack.account}:role/service-role/*BedrockAgentCore*`,
              ],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['iam:PassRole'],
              resources: [
                `arn:aws:iam::${stack.account}:role/AmazonBedrockAgentCore*`,
                `arn:aws:iam::${stack.account}:role/service-role/AmazonBedrockAgentCore*`,
              ],
            }),
          ],
        }),
        AgentCoreCodeBuildAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'codebuild:StartBuild',
                'codebuild:BatchGetBuilds',
                'codebuild:ListBuildsForProject',
                'codebuild:CreateProject',
                'codebuild:UpdateProject',
                'codebuild:BatchGetProjects',
              ],
              resources: [
                `arn:aws:codebuild:${stack.region}:${stack.account}:project/bedrock-agentcore-*`,
                `arn:aws:codebuild:${stack.region}:${stack.account}:build/bedrock-agentcore-*`,
              ],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['codebuild:ListProjects'],
              resources: ['*'],
            }),
          ],
        }),
        AgentCoreS3Access: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                's3:GetObject',
                's3:PutObject',
                's3:ListBucket',
                's3:CreateBucket',
                's3:PutLifecycleConfiguration',
              ],
              resources: [
                'arn:aws:s3:::bedrock-agentcore-*',
                'arn:aws:s3:::bedrock-agentcore-*/*',
              ],
            }),
          ],
        }),
        AgentCoreEcrAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'ecr:CreateRepository',
                'ecr:DescribeRepositories',
                'ecr:GetRepositoryPolicy',
                'ecr:InitiateLayerUpload',
                'ecr:CompleteLayerUpload',
                'ecr:PutImage',
                'ecr:UploadLayerPart',
                'ecr:BatchCheckLayerAvailability',
                'ecr:GetDownloadUrlForLayer',
                'ecr:BatchGetImage',
                'ecr:ListImages',
                'ecr:TagResource',
              ],
              resources: [
                `arn:aws:ecr:${stack.region}:${stack.account}:repository/bedrock-agentcore-*`,
              ],
            }),
          ],
        }),
        S3RecordingsAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                's3:PutObject',
                's3:PutObjectAcl',
                's3:GetObject',
                's3:ListBucket',
              ],
              resources: [
                props.recordingsBucketArn,
                `${props.recordingsBucketArn}/*`,
              ],
            }),
          ],
        }),
        DynamoDBScenariosReadOnly: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['dynamodb:Scan', 'dynamodb:GetItem'],
              resources: [props.scenariosTableArn],
            }),
          ],
        }),
      },
    });

    // ========================================
    // IAM5 Suppressions for required wildcards
    // ========================================

    // Resource::* — ecr:GetAuthorizationToken, X-Ray, cloudwatch:PutMetricData, codebuild:ListProjects do not support resource-level ARNs
    NagSuppressions.addResourceSuppressions(
      this.agentRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Resource::* is required for: ecr:GetAuthorizationToken (no resource-level support per AWS docs), ' +
            'xray:PutTraceSegments/PutTelemetryRecords/GetSamplingRules/GetSamplingTargets (no resource-level support), ' +
            'cloudwatch:PutMetricData (no resource-level support; scoped by namespace condition), ' +
            'codebuild:ListProjects (no resource-level support).',
          appliesTo: ['Resource::*'],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'logs:DescribeLogGroups requires log-group:* resource — cannot be scoped to a specific log group.',
          appliesTo: [`Resource::arn:aws:logs:${stack.region}:${stack.account}:log-group:*`],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'AgentCore runtime log groups have dynamic names. Resource is scoped to /aws/bedrock-agentcore/runtimes/ path.',
          appliesTo: [
            `Resource::arn:aws:logs:${stack.region}:${stack.account}:log-group:/aws/bedrock-agentcore/runtimes/*`,
            `Resource::arn:aws:logs:${stack.region}:${stack.account}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*`,
          ],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'CodeBuild log group names are dynamic. Resource is scoped to /aws/codebuild/ path.',
          appliesTo: [
            `Resource::arn:aws:logs:${stack.region}:${stack.account}:log-group:/aws/codebuild/*`,
          ],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'bedrock-agentcore:* action wildcard required because the AgentCore platform needs internal permissions ' +
            'on the execution role for runtime lifecycle, session routing, and health checks. ' +
            'AWS does not document individual actions — the BedrockAgentCoreFullAccess managed policy (v10) ' +
            'also uses bedrock-agentcore:*. Resource scoped to single region and account.',
          appliesTo: ['Action::bedrock-agentcore:*'],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'AgentCore platform accesses multiple resource types internally (runtimes, runtime-endpoints, ' +
            'workload-identity-directories). Resource scoped to single region and account.',
          appliesTo: [
            `Resource::arn:aws:bedrock-agentcore:${stack.region}:${stack.account}:*`,
          ],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'AgentCore platform manages internal IAM roles with BedrockAgentCore in their name. ' +
            'Resource scoped to this account and name pattern *BedrockAgentCore*.',
          appliesTo: [
            `Resource::arn:aws:iam::${stack.account}:role/*BedrockAgentCore*`,
            `Resource::arn:aws:iam::${stack.account}:role/service-role/*BedrockAgentCore*`,
            `Resource::arn:aws:iam::${stack.account}:role/AmazonBedrockAgentCore*`,
            `Resource::arn:aws:iam::${stack.account}:role/service-role/AmazonBedrockAgentCore*`,
          ],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'AgentCore platform uses CodeBuild for internal image builds. ' +
            'Resource scoped to bedrock-agentcore-* project/build names in this region and account.',
          appliesTo: [
            `Resource::arn:aws:codebuild:${stack.region}:${stack.account}:project/bedrock-agentcore-*`,
            `Resource::arn:aws:codebuild:${stack.region}:${stack.account}:build/bedrock-agentcore-*`,
          ],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'AgentCore platform uses internal S3 buckets for artifacts. Resource scoped to bedrock-agentcore-* bucket name pattern.',
          appliesTo: [
            'Resource::arn:aws:s3:::bedrock-agentcore-*',
            'Resource::arn:aws:s3:::bedrock-agentcore-*/*',
          ],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'AgentCore platform uses internal ECR repositories for container images. ' +
            'Resource scoped to bedrock-agentcore-* repo name pattern in this region and account.',
          appliesTo: [
            `Resource::arn:aws:ecr:${stack.region}:${stack.account}:repository/bedrock-agentcore-*`,
          ],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Foundation model ARNs use wildcard region (arn:aws:bedrock:*::) for cross-region inference. ' +
            'Resources scoped to specific model IDs (Nova Sonic, Nova 2 Lite).',
          appliesTo: [
            'Resource::arn:aws:bedrock:*::foundation-model/amazon.nova-sonic-v1:0',
            ...bedrockModelArns(MODEL_IDS.novaSonic, stack.region, stack.account).map(a => `Resource::${a}`),
            ...bedrockModelArns(MODEL_IDS.novaLite, stack.region, stack.account).map(a => `Resource::${a}`),
          ],
        },
      ],
      true,
    );

    // Output role ARN
    new cdk.CfnOutput(scope, 'AgentRoleArn', {
      value: this.agentRole.roleArn,
      description: 'IAM role ARN for training agent',
    });
  }
}
