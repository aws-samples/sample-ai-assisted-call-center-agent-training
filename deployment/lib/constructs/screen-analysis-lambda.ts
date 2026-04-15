/**
 * Lambda Function for Analyzing Screen Captures During Training Sessions
 * Receives screenshot batches, calls Claude vision via Bedrock Converse API
 * with structured output, stores results in S3.
 * Uses zip deployment (no Docker) since the only dependency is boto3 (provided by runtime).
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
import { NagSuppressions } from 'cdk-nag';
import { MODEL_IDS, bedrockModelArns } from '../utils/model-config';

export interface ScreenAnalysisLambdaProps {
  recordingsBucket: s3.Bucket;
  encryptionKey: kms.Key;
  vpc: ec2.IVpc;
}

export class ScreenAnalysisLambdaConstruct extends Construct {
  public readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: ScreenAnalysisLambdaProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    // Security group for screen analysis Lambda
    const lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc: props.vpc,
      description: 'Security group for screen analysis Lambda function',
      allowAllOutbound: true,
    });

    // Explicit log group (defined before role so we can reference its ARN in the policy)
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Custom execution role with inline policies (no managed policies per CLAUDE.md)
    const lambdaRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for screen analysis Lambda with inline policies',
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
        BedrockAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'bedrock:InvokeModel',
                'bedrock:InvokeModelWithResponseStream',
              ],
              resources: bedrockModelArns(MODEL_IDS.evaluation, stack.region, stack.account, { wildcard: true }),
            }),
          ],
        }),
      },
    });

    // Create Lambda function (zip deployment — only dependency is boto3 provided by runtime)
    this.function = new lambda.Function(this, 'Function', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../../src/lambda/screen_analysis')),
      role: lambdaRole,
      architecture: lambda.Architecture.X86_64,
      timeout: cdk.Duration.minutes(2),
      memorySize: 1024,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [lambdaSg],
      environment: {
        RECORDINGS_BUCKET: props.recordingsBucket.bucketName,
        BEDROCK_MODEL_ID: MODEL_IDS.evaluation,
        LOG_LEVEL: 'INFO',
      },
      logGroup,
      description: 'Analyzes screen captures during training using Claude vision',
    });

    // Grant S3 read+write (reads existing summaries, writes updated ones)
    props.recordingsBucket.grantReadWrite(this.function);

    // Grant KMS for encrypted S3 objects
    props.encryptionKey.grantEncryptDecrypt(this.function);

    // ========================================
    // IAM5 Suppressions
    // ========================================
    NagSuppressions.addResourceSuppressions(
      lambdaRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'ec2:CreateNetworkInterface, ec2:DescribeNetworkInterfaces, ec2:DeleteNetworkInterface do not support resource-level ARNs (required for Lambda VPC access).',
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
      ],
      true,
    );

    // Suppress Bedrock IAM5 wildcards for foundation model and inference profile
    NagSuppressions.addResourceSuppressions(
      lambdaRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Foundation model and inference profile ARNs use wildcard for cross-region inference. Scoped to evaluation model family.',
          appliesTo: bedrockModelArns(MODEL_IDS.evaluation, stack.region, stack.account, { wildcard: true }).map(a => `Resource::${a}`),
        },
      ],
      true,
    );

    // Suppress CDK grant wildcards (generated by grantReadWrite, grantEncryptDecrypt)
    NagSuppressions.addResourceSuppressions(
      lambdaRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'S3 grantReadWrite and KMS grantEncryptDecrypt generate standard CDK wildcard action patterns.',
          appliesTo: [
            'Action::s3:GetObject*',
            'Action::s3:GetBucket*',
            'Action::s3:List*',
            'Action::s3:Abort*',
            'Action::kms:GenerateDataKey*',
            'Action::kms:ReEncrypt*',
          ],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'S3 object-level access requires /* suffix on bucket ARN. Resources are scoped to specific buckets.',
          appliesTo: [
            {
              regex: '/Resource::.*\\.Arn>\\/\\*$/g',
            } as any,
          ],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Log group ARN :* suffix is required to cover log streams within the group.',
          appliesTo: [
            { regex: '/Resource::.*LogGroup.*\\.Arn>:\\*$/g' } as any,
          ],
        },
      ],
      true,
    );

    // Outputs
    new cdk.CfnOutput(scope, 'ScreenAnalysisLambdaName', {
      value: this.function.functionName,
      description: 'Screen Analysis Lambda function name',
    });
  }
}
