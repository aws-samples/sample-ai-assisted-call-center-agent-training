/**
 * Connect Post-Call Processing Lambda
 *
 * Docker-based Lambda triggered by EventBridge when a Contact Lens analysis
 * JSON file appears in the Connect S3 bucket. Downloads the analysis +
 * Connect recording, extracts agent audio channel (ffmpeg), converts to
 * SessionRecording format, and invokes the scoring Lambda.
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as path from 'path';
import { NagSuppressions } from 'cdk-nag';

export interface ConnectPostCallLambdaProps {
  vpc: ec2.IVpc;
  recordingsBucket: s3.Bucket;
  encryptionKey: kms.Key;
  sessionsTableName: string;
  sessionsTableArn: string;
  scoringLambda: lambda.IFunction;
  connectInstanceArn: string;
  /** S3 bucket name where Connect stores call recordings and Contact Lens analysis */
  connectRecordingsBucket: string;
}

export class ConnectPostCallLambdaConstruct extends Construct {
  public readonly function: lambda.DockerImageFunction;

  constructor(scope: Construct, id: string, props: ConnectPostCallLambdaProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const projectRoot = path.join(__dirname, '../../..');
    const connectInstanceId = cdk.Fn.select(1, cdk.Fn.split('instance/', props.connectInstanceArn));

    // Security group
    const lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc: props.vpc,
      description: 'Security group for Connect post-call Lambda',
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
      description: 'Execution role for Connect post-call Lambda',
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
        DynamoDBSessions: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['dynamodb:Query', 'dynamodb:GetItem', 'dynamodb:UpdateItem'],
              resources: [
                props.sessionsTableArn,
                `${props.sessionsTableArn}/index/ContactIdIndex`,
              ],
            }),
          ],
        }),
        ConnectAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'connect:DescribeContact',
                'connect:GetContactAttributes',
              ],
              resources: [
                props.connectInstanceArn,
                `${props.connectInstanceArn}/contact/*`,
              ],
            }),
          ],
        }),
      },
    });

    // Docker image Lambda — bundles ffmpeg for audio channel extraction
    this.function = new lambda.DockerImageFunction(this, 'Function', {
      code: lambda.DockerImageCode.fromImageAsset(projectRoot, {
        file: 'src/lambda/connect_postcall/Dockerfile',
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
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      ephemeralStorageSize: cdk.Size.mebibytes(2048),  // Large recordings
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [lambdaSg],
      environment: {
        RECORDINGS_BUCKET: props.recordingsBucket.bucketName,
        SESSIONS_TABLE: props.sessionsTableName,
        SCORING_FUNCTION_NAME: props.scoringLambda.functionName,
        CONNECT_INSTANCE_ID: connectInstanceId,
        KMS_KEY_ID: props.encryptionKey.keyId,
        CONNECT_RECORDINGS_BUCKET: props.connectRecordingsBucket,
        LOG_LEVEL: 'INFO',
      },
      logGroup,
      description: 'Processes Connect calls after Contact Lens analysis completes',
    });

    // Grant S3 read/write for recordings bucket
    props.recordingsBucket.grantReadWrite(this.function);
    props.encryptionKey.grantEncryptDecrypt(this.function);

    // Grant S3 read for Connect recordings bucket (Contact Lens analysis + call recordings)
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject', 's3:ListBucket'],
        resources: [
          `arn:aws:s3:::${props.connectRecordingsBucket}`,
          `arn:aws:s3:::${props.connectRecordingsBucket}/*`,
        ],
      })
    );

    // Grant invoke on scoring Lambda
    props.scoringLambda.grantInvoke(this.function);

    // ========================================
    // Enable EventBridge notifications on the Connect S3 bucket
    // ========================================
    new cr.AwsCustomResource(this, 'EnableS3EventBridge', {
      onCreate: {
        service: 'S3',
        action: 'putBucketNotificationConfiguration',
        parameters: {
          Bucket: props.connectRecordingsBucket,
          NotificationConfiguration: {
            EventBridgeConfiguration: {},
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${props.connectRecordingsBucket}-eventbridge`),
      },
      onUpdate: {
        service: 'S3',
        action: 'putBucketNotificationConfiguration',
        parameters: {
          Bucket: props.connectRecordingsBucket,
          NotificationConfiguration: {
            EventBridgeConfiguration: {},
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${props.connectRecordingsBucket}-eventbridge`),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['s3:PutBucketNotification', 's3:GetBucketNotification'],
          resources: [`arn:aws:s3:::${props.connectRecordingsBucket}`],
        }),
      ]),
    });

    // ========================================
    // EventBridge Rule — S3 Object Created (Contact Lens analysis JSON)
    // ========================================
    const postCallRule = new events.Rule(this, 'PostCallAnalysisRule', {
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: { name: [props.connectRecordingsBucket] },
          object: {
            key: [{ prefix: 'Analysis/Voice/' }],
          },
        },
      },
      description: 'Trigger post-call processing when Contact Lens analysis appears in S3',
    });

    postCallRule.addTarget(new targets.LambdaFunction(this.function, {
      retryAttempts: 2,
    }));

    // ========================================
    // IAM5 Suppressions
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
          reason: 'Lambda log group and stream names are dynamic.',
          appliesTo: [`Resource::arn:aws:logs:${stack.region}:${stack.account}:log-group:/aws/lambda/*:*`],
        },
      ],
      true,
    );

    // Suppress CDK grant wildcards
    NagSuppressions.addResourceSuppressions(
      lambdaRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'S3 grantReadWrite and KMS grantEncryptDecrypt generate standard CDK wildcard patterns.',
          appliesTo: [
            'Action::s3:GetObject*',
            'Action::s3:GetBucket*',
            'Action::s3:List*',
            'Action::s3:Abort*',
            'Action::s3:DeleteObject*',
            'Action::kms:GenerateDataKey*',
            'Action::kms:ReEncrypt*',
          ],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'S3 object-level access requires /* suffix. Resources scoped to specific buckets.',
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
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Lambda grantInvoke adds :* suffix for version/alias qualifiers. Resource scoped to specific function.',
          appliesTo: [
            { regex: '/Resource::.*Function.*\\.Arn>:\\*$/g' } as any,
          ],
        },
      ],
      true,
    );

    NagSuppressions.addResourceSuppressions(
      lambdaRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Connect recordings bucket object access requires /* suffix.',
          appliesTo: [
            `Resource::arn:aws:s3:::${props.connectRecordingsBucket}/*`,
          ],
        },
      ],
      true,
    );

    // Suppress Connect instance wildcard
    NagSuppressions.addResourceSuppressions(
      lambdaRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Connect contact IDs are generated dynamically at runtime and cannot be known at deployment time. Wildcard scoped to specific Connect instance contact resources only.',
          appliesTo: [
            {
              regex: '/Resource::.*\\/contact\\/\\*$/g',
            } as any,
          ],
        },
      ],
      true,
    );

    // Outputs
    new cdk.CfnOutput(scope, 'ConnectPostCallLambdaName', {
      value: this.function.functionName,
      description: 'Connect Post-Call Lambda function name',
    });
  }
}
