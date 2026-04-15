/**
 * Docker-based Lambda Function for Audio Empathy Analysis
 * Downloads session audio (webm) from S3, converts to WAV via ffmpeg,
 * runs librosa-based prosodic analysis to evaluate agent empathy and tone.
 * Invoked synchronously by the scoring Lambda.
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

export interface AudioEmpathyLambdaProps {
  recordingsBucket: s3.Bucket;
  encryptionKey: kms.Key;
  vpc: ec2.IVpc;
}

export class AudioEmpathyLambdaConstruct extends Construct {
  public readonly function: lambda.DockerImageFunction;

  constructor(scope: Construct, id: string, props: AudioEmpathyLambdaProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const projectRoot = path.join(__dirname, '../../..');

    // Security group
    const lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc: props.vpc,
      description: 'Security group for audio empathy Lambda function',
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
      description: 'Execution role for audio empathy Lambda with inline policies',
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
      },
    });

    // Docker image Lambda — bundles librosa, ffmpeg, and source modules
    this.function = new lambda.DockerImageFunction(this, 'Function', {
      code: lambda.DockerImageCode.fromImageAsset(projectRoot, {
        file: 'src/lambda/audio_empathy/Dockerfile',
        buildArgs: {},
        // Include only needed files in the Docker build context
        exclude: [
          'deployment',
          'connect-admin',
          'frontend',
          'node_modules',
          '.git',
          'cdk.out',
          '*.md',
        ],
      }),
      role: lambdaRole,
      architecture: lambda.Architecture.X86_64,
      timeout: cdk.Duration.minutes(3),
      memorySize: 2048,  // librosa FFT operations need memory
      ephemeralStorageSize: cdk.Size.mebibytes(1024),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [lambdaSg],
      environment: {
        RECORDINGS_BUCKET: props.recordingsBucket.bucketName,
        // numba (librosa dependency) needs a writable cache directory;
        // Lambda filesystem is read-only except /tmp
        NUMBA_CACHE_DIR: '/tmp/numba_cache',
        MPLCONFIGDIR: '/tmp/matplotlib',
        LOG_LEVEL: 'INFO',
      },
      logGroup,
      description: 'Analyzes audio empathy and tone using librosa prosodic features',
    });

    // Explicitly grant log group write (belt-and-suspenders with CDK's auto-grant)
    logGroup.grantWrite(this.function);

    // Grant S3 read for audio and session JSON files
    props.recordingsBucket.grantRead(this.function);

    // Grant KMS for encrypted S3 objects
    props.encryptionKey.grantDecrypt(this.function);

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

    // Suppress CDK grant wildcards (generated by grantRead, grantDecrypt, grantWrite)
    NagSuppressions.addResourceSuppressions(
      lambdaRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'S3 grantRead and KMS grantDecrypt generate standard CDK wildcard action patterns.',
          appliesTo: [
            'Action::s3:GetObject*',
            'Action::s3:GetBucket*',
            'Action::s3:List*',
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
    new cdk.CfnOutput(scope, 'AudioEmpathyLambdaName', {
      value: this.function.functionName,
      description: 'Audio Empathy Lambda function name',
    });
  }
}
