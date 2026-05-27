/**
 * Trainee Lambda — Read-Only Scenario Access
 *
 * Provides trainees with minimal API surface:
 * - listScenarios: DynamoDB Scan (summary fields)
 * - getScenario: DynamoDB GetItem (full scenario)
 *
 * No S3, KMS, Bedrock, or write permissions.
 * Admin operations remain in the admin Lambda (separate IAM boundary).
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';
import { NagSuppressions } from 'cdk-nag';

export interface TraineeLambdaProps {
  vpc: ec2.IVpc;
  scenariosTableName: string;
  scenariosTableArn: string;
  sessionsTableName: string;
  sessionsTableArn: string;
  /** KMS CMK protecting the DynamoDB tables. Required for read+write access. */
  dynamoEncryptionKey: kms.IKey;
}

export class TraineeLambdaConstruct extends Construct {
  public readonly function: lambda.Function;
  public readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: TraineeLambdaProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    // Security group for trainee Lambda
    this.securityGroup = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc: props.vpc,
      description: 'Security group for trainee Lambda function (read-only scenarios)',
      allowAllOutbound: true,
    });

    // Explicit log group (replaces deprecated logRetention property)
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Execution role with minimal inline policies (no managed policies per CLAUDE.md)
    const lambdaRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for trainee Lambda - read-only DynamoDB access',
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
        DynamoDBScenariosReadOnly: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['dynamodb:Scan', 'dynamodb:GetItem'],
              resources: [props.scenariosTableArn],
            }),
          ],
        }),
        DynamoDBSessionsWrite: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['dynamodb:PutItem'],
              resources: [props.sessionsTableArn],
            }),
          ],
        }),
      },
    });

    // Create Lambda function (zip deployment — only dependency is boto3 provided by runtime)
    this.function = new lambda.Function(this, 'Function', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../../src/lambda/trainee')),
      role: lambdaRole,
      architecture: lambda.Architecture.X86_64,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.securityGroup],
      environment: {
        SCENARIOS_TABLE: props.scenariosTableName,
        SESSIONS_TABLE: props.sessionsTableName,
        LOG_LEVEL: 'INFO',
      },
      logGroup,
      description: 'Trainee scenario access and session creation',
    });

    // DynamoDB tables use a customer-managed KMS CMK. Without explicit grants
    // here, scan/get/put calls fail with KMSAccessDeniedException.
    props.dynamoEncryptionKey.grantEncryptDecrypt(this.function);

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
        {
          id: 'AwsSolutions-IAM5',
          reason: 'KMS grantEncryptDecrypt generates standard CDK wildcard action patterns scoped to the DynamoDB CMK.',
          appliesTo: [
            'Action::kms:GenerateDataKey*',
            'Action::kms:ReEncrypt*',
          ],
        },
      ],
      true,
    );

    // Outputs
    new cdk.CfnOutput(scope, 'TraineeLambdaName', {
      value: this.function.functionName,
      description: 'Trainee Lambda function name (read-only scenarios)',
    });
  }
}
