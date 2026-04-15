/**
 * Lambda Function for Scoring Training Sessions
 * Retrieves recordings from S3, runs scoring engine with call center scorecard, saves results
 * Uses ZIP deployment with bundled Python dependencies
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

export interface ScoringLambdaProps {
  recordingsBucket: s3.Bucket;
  scoringBucket: s3.Bucket;
  encryptionKey: kms.Key;
  vpc: ec2.IVpc;
  criteriaConfigTableName: string;
  criteriaConfigTableArn: string;
  sessionsTableName: string;
  sessionsTableArn: string;
}

export class ScoringLambdaConstruct extends Construct {
  public readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: ScoringLambdaProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const projectRoot = path.join(__dirname, '../../..');

    // Security group for scoring Lambda
    const lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc: props.vpc,
      description: 'Security group for scoring Lambda function',
      allowAllOutbound: true,
    });

    // Explicit log group (defined before role so we can reference its ARN in the policy)
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Custom execution role with inline policies (fixes IAM4 — no managed policies)
    const lambdaRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for scoring Lambda with inline policies',
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
        DynamoDBCriteriaConfigRead: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['dynamodb:GetItem'],
              resources: [props.criteriaConfigTableArn],
            }),
          ],
        }),
        DynamoDBSessionsUpdate: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['dynamodb:UpdateItem'],
              resources: [props.sessionsTableArn],
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

    // Hash only the source files that get bundled into the Lambda ZIP.
    // This prevents CDK from rebuilding when unrelated project files change.
    const assetHash = computeSourceHash(
      path.join(projectRoot, 'src/config/models.py'),
      path.join(projectRoot, 'src/lambda/scoring/index.py'),
      path.join(projectRoot, 'src/recording/session_types.py'),
      path.join(projectRoot, 'src/recording/__init__.py'),
      path.join(projectRoot, 'src/evaluators/scoring_engine.py'),
      path.join(projectRoot, 'src/evaluators/transcript_analytics.py'),
      path.join(projectRoot, 'src/evaluators/__init__.py'),
      path.join(projectRoot, 'src/models/call_scorecard.py'),
      path.join(projectRoot, 'src/models/rubric_loader.py'),
      path.join(projectRoot, 'src/models/__init__.py'),
      path.join(projectRoot, 'rubrics/default.json'),
    );

    // Create Lambda function with ZIP deployment and bundled dependencies
    this.function = new lambda.Function(this, 'Function', {
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: 'index.lambda_handler',
      code: lambda.Code.fromAsset(projectRoot, {
        assetHash,
        assetHashType: cdk.AssetHashType.CUSTOM,
        bundling: {
          image: lambda.Runtime.PYTHON_3_14.bundlingImage,
          local: {
            tryBundle(outputDir: string): boolean {
              const fs = require('fs');

              // Create directory structure
              const dirs = [
                'src/config',
                'src/recording',
                'src/evaluators',
                'src/models',
                'rubrics',
              ];
              for (const dir of dirs) {
                fs.mkdirSync(path.join(outputDir, dir), { recursive: true }); // nosemgrep: path-join-resolve-traversal
              }

              // Copy Lambda handler
              fs.copyFileSync(
                path.join(projectRoot, 'src/lambda/scoring/index.py'),
                path.join(outputDir, 'index.py'), // nosemgrep: path-join-resolve-traversal
              );

              // Copy source modules
              const sourceFiles: [string, string][] = [
                ['src/config/__init__.py', 'src/config/__init__.py'],
                ['src/config/models.py', 'src/config/models.py'],
                ['src/recording/session_types.py', 'src/recording/session_types.py'],
                ['src/recording/__init__.py', 'src/recording/__init__.py'],
                ['src/evaluators/scoring_engine.py', 'src/evaluators/scoring_engine.py'],
                ['src/evaluators/transcript_analytics.py', 'src/evaluators/transcript_analytics.py'],
                ['src/evaluators/__init__.py', 'src/evaluators/__init__.py'],
                ['src/models/call_scorecard.py', 'src/models/call_scorecard.py'],
                ['src/models/rubric_loader.py', 'src/models/rubric_loader.py'],
                ['src/models/__init__.py', 'src/models/__init__.py'],
                ['rubrics/default.json', 'rubrics/default.json'],
              ];
              for (const [src, dest] of sourceFiles) {
                fs.copyFileSync(
                  path.join(projectRoot, src),
                  path.join(outputDir, dest), // nosemgrep: path-join-resolve-traversal
                );
              }

              // Create src/__init__.py
              fs.writeFileSync(path.join(outputDir, 'src/__init__.py'), ''); // nosemgrep: path-join-resolve-traversal

              return true;
            },
          },
          command: [
            'bash', '-c', [
              // Create directory structure
              'mkdir -p /asset-output/src/config /asset-output/src/recording /asset-output/src/evaluators /asset-output/src/models /asset-output/rubrics',
              // Copy handler
              'cp src/lambda/scoring/index.py /asset-output/',
              // Copy source modules
              'cp src/config/__init__.py src/config/models.py /asset-output/src/config/',
              'cp src/recording/session_types.py /asset-output/src/recording/',
              'cp src/recording/__init__.py /asset-output/src/recording/',
              'cp src/evaluators/scoring_engine.py src/evaluators/transcript_analytics.py /asset-output/src/evaluators/',
              'cp src/evaluators/__init__.py /asset-output/src/evaluators/',
              'cp src/models/call_scorecard.py src/models/rubric_loader.py src/models/__init__.py /asset-output/src/models/',
              'cp rubrics/default.json /asset-output/rubrics/',
              // Create src package init
              'touch /asset-output/src/__init__.py',
            ].join(' && '),
          ],
        },
      }),
      role: lambdaRole,
      architecture: lambda.Architecture.X86_64,
      timeout: cdk.Duration.minutes(5),  // Scoring can take time with LLM calls
      memorySize: 2048,  // Scoring is memory-intensive
      ephemeralStorageSize: cdk.Size.mebibytes(1024),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [lambdaSg],
      environment: {
        RECORDINGS_BUCKET: props.recordingsBucket.bucketName,
        SCORING_BUCKET: props.scoringBucket.bucketName,
        CRITERIA_CONFIG_TABLE: props.criteriaConfigTableName,
        SESSIONS_TABLE: props.sessionsTableName,
        BEDROCK_MODEL_ID: MODEL_IDS.evaluation,
        LOG_LEVEL: 'INFO',
      },
      logGroup,
      description: 'Scores training session recordings using call center scorecard with AI',
    });

    // Grant S3 permissions
    props.recordingsBucket.grantRead(this.function);
    props.scoringBucket.grantWrite(this.function);

    // Grant KMS permissions for encrypted S3 objects
    props.encryptionKey.grantDecrypt(this.function);

    // Grant self-invoke for async scoring pattern (API GW has 30s timeout, scoring takes 1-3 min)
    // Uses L1 CfnPolicy to avoid circular dependency:
    // - CDK auto-adds DependsOn from Lambda → DefaultPolicy (ensures IAM propagation)
    // - addToPrincipalPolicy/grantInvoke add to DefaultPolicy, which references functionArn
    // - This creates: Function → DependsOn → DefaultPolicy → Ref → Function (cycle)
    // A separate CfnPolicy bypasses CDK's auto-DependsOn, breaking the cycle.
    new iam.CfnPolicy(this, 'SelfInvokePolicy', {
      policyName: 'ScoringLambdaSelfInvoke',
      roles: [lambdaRole.roleName],
      policyDocument: {
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Action: 'lambda:InvokeFunction',
          Resource: this.function.functionArn,
        }],
      },
    });

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

    // Suppress CDK grant wildcards (generated by grantRead, grantWrite, grantDecrypt, grantInvoke)
    NagSuppressions.addResourceSuppressions(
      lambdaRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'S3 grantRead/grantWrite and KMS grantDecrypt generate standard CDK wildcard action patterns.',
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

    // Outputs
    new cdk.CfnOutput(scope, 'ScoringLambdaName', {
      value: this.function.functionName,
      description: 'Lambda Function name for direct invocation',
    });

    new cdk.CfnOutput(scope, 'ScoringLambdaArn', {
      value: this.function.functionArn,
      description: 'Scoring Lambda Function ARN',
    });
  }
}
