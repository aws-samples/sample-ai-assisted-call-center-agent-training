/**
 * Lambda Function for Admin Dashboard Operations
 * Lists trainees, sessions, scorecards, transcripts, and generates presigned audio URLs.
 * Uses zip deployment (only dependency is boto3 provided by runtime).
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
import { computeSourceHash } from '../utils/asset-hash';
import { MODEL_IDS, bedrockModelArns } from '../utils/model-config';

export interface AdminLambdaProps {
  recordingsBucket: s3.Bucket;
  encryptionKey: kms.Key;
  vpc: ec2.IVpc;
  scenariosTableName: string;
  scenariosTableArn: string;
  criteriaConfigTableName: string;
  criteriaConfigTableArn: string;
  sessionsTableName: string;
  sessionsTableArn: string;
}

export class AdminLambdaConstruct extends Construct {
  public readonly function: lambda.Function;
  public readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: AdminLambdaProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    // Security group for admin Lambda
    this.securityGroup = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc: props.vpc,
      description: 'Security group for admin Lambda function',
      allowAllOutbound: true,
    });

    // Custom execution role with inline policies (no managed policies per CLAUDE.md)
    const lambdaRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for admin Lambda with inline policies',
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
              resources: [`arn:aws:logs:${stack.region}:${stack.account}:log-group:/aws/lambda/*:*`],
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
        DynamoDBScenariosAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'dynamodb:Scan',
                'dynamodb:GetItem',
                'dynamodb:PutItem',
                'dynamodb:DeleteItem',
              ],
              resources: [props.scenariosTableArn],
            }),
          ],
        }),
        DynamoDBCriteriaConfigAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'dynamodb:GetItem',
                'dynamodb:PutItem',
                'dynamodb:DeleteItem',
              ],
              resources: [props.criteriaConfigTableArn],
            }),
          ],
        }),
        DynamoDBSessionsAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'dynamodb:Query',
                'dynamodb:GetItem',
                'dynamodb:UpdateItem',
                'dynamodb:Scan',
              ],
              resources: [
                props.sessionsTableArn,
                `${props.sessionsTableArn}/index/TimestampIndex`,
              ],
            }),
          ],
        }),
        BedrockInvokeModel: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['bedrock:InvokeModel'],
              resources: bedrockModelArns(MODEL_IDS.evaluation, stack.region, stack.account, { wildcard: true }),
            }),
          ],
        }),
      },
    });

    // Explicit log group (replaces deprecated logRetention property)
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const projectRoot = path.join(__dirname, '../../..');

    // Hash only the source files that get bundled into the Lambda ZIP.
    const assetHash = computeSourceHash(
      path.join(projectRoot, 'src/lambda/admin/index.py'),
      path.join(projectRoot, 'rubrics/default.json'),
    );

    // Create Lambda function (zip deployment — only dependency is boto3 provided by runtime)
    this.function = new lambda.Function(this, 'Function', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.lambda_handler',
      code: lambda.Code.fromAsset(projectRoot, {
        assetHash,
        assetHashType: cdk.AssetHashType.CUSTOM,
        bundling: {
          image: lambda.Runtime.PYTHON_3_13.bundlingImage,
          local: {
            tryBundle(outputDir: string): boolean {
              const fs = require('fs');
              const projectRoot = path.join(__dirname, '../../..');
              fs.copyFileSync(
                path.join(projectRoot, 'src/lambda/admin/index.py'),
                path.join(outputDir, 'index.py'), // nosemgrep: path-join-resolve-traversal
              );
              fs.copyFileSync(
                path.join(projectRoot, 'rubrics/default.json'),
                path.join(outputDir, 'rubric.json'), // nosemgrep: path-join-resolve-traversal
              );
              return true;
            },
          },
          command: [
            'bash', '-c', [
              'cp src/lambda/admin/index.py /asset-output/',
              'cp rubrics/default.json /asset-output/rubric.json',
            ].join(' && '),
          ],
        },
      }),
      role: lambdaRole,
      architecture: lambda.Architecture.X86_64,
      timeout: cdk.Duration.seconds(120),
      memorySize: 512,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.securityGroup],
      environment: {
        RECORDINGS_BUCKET: props.recordingsBucket.bucketName,
        SCENARIOS_TABLE: props.scenariosTableName,
        CRITERIA_CONFIG_TABLE: props.criteriaConfigTableName,
        SESSIONS_TABLE: props.sessionsTableName,
        BEDROCK_MODEL_ID: MODEL_IDS.evaluation,
        LOG_LEVEL: 'INFO',
      },
      logGroup,
      description: 'Admin dashboard operations: list trainees, sessions, scorecards, audio URLs',
    });

    // Grant S3 read/write access (list + get + put objects for admin comments)
    props.recordingsBucket.grantReadWrite(this.function);

    // Grant KMS encrypt/decrypt for encrypted S3 objects (read + write comments)
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
          reason: 'S3 grantReadWrite and KMS grantEncryptDecrypt generate standard CDK wildcard action patterns. Write access needed for admin comments.',
          appliesTo: [
            'Action::s3:GetObject*',
            'Action::s3:GetBucket*',
            'Action::s3:List*',
            'Action::s3:PutObject*',
            'Action::s3:DeleteObject*',
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
      ],
      true,
    );

    // Outputs
    new cdk.CfnOutput(scope, 'AdminLambdaName', {
      value: this.function.functionName,
      description: 'Admin Lambda function name',
    });
  }
}
