/**
 * Connect Admin API Lambda Construct
 *
 * Creates a Lambda that serves the Connect admin API via API Gateway:
 * - GET  /scenarios   — list training scenarios
 * - GET  /agents      — list Connect agents
 * - GET  /calls       — list recent call history
 * - POST /start-call  — initiate outbound training call
 *
 * Uses zip deployment (no external dependencies beyond boto3).
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';
import { execSync } from 'child_process';
import { NagSuppressions } from 'cdk-nag';
import { computeSourceHash } from '../utils/asset-hash';

export interface ConnectAudioBridgeProps {
  /** Connect instance ARN */
  connectInstanceArn: string;
  /** Contact flow ID for outbound calls */
  contactFlowId: string;
  /** Default destination phone number (E.164) for outbound calls */
  destinationPhoneNumber: string;
  /** S3 recordings bucket (for listing call history) */
  recordingsBucket: s3.IBucket;
  /** KMS encryption key */
  encryptionKey: kms.IKey;
  /** VPC for Lambda deployment */
  vpc: ec2.IVpc;
  /** Connect queue ARN (optional — Lambda discovers at runtime if not provided) */
  queueArn?: string;
  /** DynamoDB Scenarios table name */
  scenariosTableName: string;
  /** DynamoDB Scenarios table ARN */
  scenariosTableArn: string;
  /** DynamoDB Sessions table name */
  sessionsTableName: string;
  /** DynamoDB Sessions table ARN */
  sessionsTableArn: string;
}

export class ConnectAudioBridgeConstruct extends Construct {
  public readonly unifiedLambda: lambda.Function;
  /** Pre-computed Lambda ARN as a plain string (no CFN token dependency).
   *  Used by connect-stack to avoid circular CFN references. */
  public readonly lambdaArnString: string;

  constructor(scope: Construct, id: string, props: ConnectAudioBridgeProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const lambdaDir = path.join(__dirname, '../../../src/lambda/connect_lambda');

    // Explicit function name so we can pre-compute the ARN as a plain string.
    // This breaks circular CFN dependencies between the Lambda, LambdaAssociation,
    // and the Admin UI's Cognito authenticated role.
    const explicitFunctionName = `${stack.stackName}-training-bridge`;
    this.lambdaArnString = `arn:aws:lambda:${stack.region}:${stack.account}:function:${explicitFunctionName}`;

    // Hash source files so CDK only redeploys when code/deps change.
    const assetHash = computeSourceHash(
      path.join(lambdaDir, 'index.py'),
      path.join(lambdaDir, 'requirements.txt'),
    );

    // Security group
    const lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc: props.vpc,
      description: 'Security group for Connect audio bridge Lambda',
      allowAllOutbound: true,
    });

    // Explicit log group
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Custom execution role with inline policies (no managed policies per CLAUDE.md)
    const lambdaRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for Connect audio bridge Lambda',
      inlinePolicies: {
        CloudWatchLogs: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['logs:CreateLogGroup'],
              resources: [`arn:aws:logs:${stack.region}:${stack.account}:log-group:/aws/lambda/*`],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
              resources: [
                `arn:aws:logs:${stack.region}:${stack.account}:log-group:/aws/lambda/*:*`,
                logGroup.logGroupArn,
                `${logGroup.logGroupArn}:*`,
              ],
            }),
          ],
        }),
        VpcNetworkInterface: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'ec2:CreateNetworkInterface',
                'ec2:DescribeNetworkInterfaces',
                'ec2:DeleteNetworkInterface',
              ],
              resources: ['*'],
            }),
          ],
        }),
        S3Access: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
              resources: [
                props.recordingsBucket.bucketArn,
                `${props.recordingsBucket.bucketArn}/*`,
              ],
            }),
          ],
        }),
        KmsAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey'],
              resources: [props.encryptionKey.keyArn],
            }),
          ],
        }),
        ConnectAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'connect:StartOutboundVoiceContact',
                'connect:ListUsers',
                'connect:DescribeUser',
                'connect:ListQueues',
              ],
              resources: [
                props.connectInstanceArn,
                `${props.connectInstanceArn}/contact/*`,
                `${props.connectInstanceArn}/user/*`,
                `${props.connectInstanceArn}/queue/*`,
              ],
            }),
          ],
        }),
        DynamoDBScenariosRead: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['dynamodb:Scan', 'dynamodb:GetItem'],
              resources: [props.scenariosTableArn],
            }),
          ],
        }),
        DynamoDBSessionsAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
              resources: [props.sessionsTableArn, `${props.sessionsTableArn}/index/TimestampIndex`],
            }),
          ],
        }),
      },
    });

    // ========================================
    // Unified Lambda (zip deployment)
    // ========================================
    this.unifiedLambda = new lambda.Function(this, 'UnifiedFunction', {
      functionName: explicitFunctionName,
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(lambdaDir, {
        assetHash,
        assetHashType: cdk.AssetHashType.CUSTOM,
        bundling: {
          image: lambda.Runtime.PYTHON_3_14.bundlingImage,
          local: {
            tryBundle(outputDir: string): boolean {
              try {
                execSync(
                  // nosemgrep: detect-child-process
                  `pip install -r ${path.join(lambdaDir, 'requirements.txt')} -t "${outputDir}" --quiet --platform manylinux2014_x86_64 --implementation cp --python-version 3.14 --only-binary=:all:`,
                  { stdio: 'inherit' },
                );
                require('fs').copyFileSync(
                  path.join(lambdaDir, 'index.py'),
                  path.join(outputDir, 'index.py'), // nosemgrep: path-join-resolve-traversal
                );
                return true;
              } catch {
                return false; // Fall back to Docker bundling
              }
            },
          },
          command: [
            'bash', '-c',
            'pip install -r requirements.txt -t /asset-output && cp index.py /asset-output/',
          ],
        },
      }),
      role: lambdaRole,
      architecture: lambda.Architecture.X86_64,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [lambdaSg],
      environment: {
        AWS_REGION_NAME: stack.region,
        RECORDINGS_BUCKET: props.recordingsBucket.bucketName,
        CONNECT_INSTANCE_ARN: props.connectInstanceArn,
        CONNECT_INSTANCE_ID: cdk.Fn.select(1, cdk.Fn.split('instance/', props.connectInstanceArn)),
        CONTACT_FLOW_ID: props.contactFlowId,
        DESTINATION_PHONE: props.destinationPhoneNumber,
        ...(props.queueArn ? { QUEUE_ARN: props.queueArn } : {}),
        SCENARIOS_TABLE: props.scenariosTableName,
        SESSIONS_TABLE: props.sessionsTableName,
        LOG_LEVEL: 'INFO',
      },
      logGroup,
      description: 'Connect training admin API Lambda',
    });

    // ========================================
    // IAM5 Suppressions for required wildcards
    // ========================================
    NagSuppressions.addResourceSuppressions(
      lambdaRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'VPC network interface actions do not support resource-level ARNs.',
          appliesTo: ['Resource::*'],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'logs:CreateLogGroup is scoped to /aws/lambda/ path. Wildcard required because Lambda log group name is dynamic.',
          appliesTo: [`Resource::arn:aws:logs:${stack.region}:${stack.account}:log-group:/aws/lambda/*`],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Lambda log group and stream names are dynamic. Resource is scoped to /aws/lambda/ path.',
          appliesTo: [`Resource::arn:aws:logs:${stack.region}:${stack.account}:log-group:/aws/lambda/*:*`],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Log group ARN :* suffix is required to cover log streams within the group.',
          appliesTo: [
            { regex: '/Resource::.*LogGroup.*\\.Arn>:\\*$/g' } as any,
          ],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'S3 object-level access requires /* suffix on bucket ARN. Resource scoped to recordings bucket.',
          appliesTo: [
            { regex: '/Resource::.*\\.Arn>\\/\\*$/g' } as any,
          ],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Connect contact IDs are generated dynamically at runtime and cannot be known at deployment time. Wildcard scoped to specific Connect instance contact resources only.',
          appliesTo: [
            { regex: '/Resource::.*\\/contact\\/\\*$/g' } as any,
          ],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Connect user IDs are managed by Connect service and cannot be enumerated at deployment time. Wildcard scoped to specific Connect instance user resources only.',
          appliesTo: [
            { regex: '/Resource::.*\\/user\\/\\*$/g' } as any,
          ],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Connect queue IDs are managed by Connect service and cannot be enumerated at deployment time. Wildcard scoped to specific Connect instance queue resources only.',
          appliesTo: [
            { regex: '/Resource::.*\\/queue\\/\\*$/g' } as any,
          ],
        },
      ],
      true,
    );

    // ========================================
    // Outputs
    // ========================================
    new cdk.CfnOutput(scope, 'AdminLambdaArn', {
      value: this.unifiedLambda.functionArn,
      description: 'Connect Admin API Lambda ARN',
    });

    new cdk.CfnOutput(scope, 'AdminLambdaName', {
      value: this.unifiedLambda.functionName,
      description: 'Connect Admin API Lambda Function Name',
    });
  }
}
