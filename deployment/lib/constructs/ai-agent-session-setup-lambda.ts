/**
 * AI Agent Session Setup Lambda Construct
 *
 * Creates a Lambda that injects scenario data into Q Connect AI Agent sessions:
 * - Receives contactId and scenario_id from Connect contact flow
 * - Retrieves session ID from Connect DescribeContact API (WisdomInfo.SessionArn)
 * - Loads scenario from DynamoDB Scenarios table
 * - Calls Q Connect UpdateSessionData to inject scenario fields as custom session data
 * - AI Agent prompt can reference {{$.Custom.scenarioId}}, {{$.Custom.name}}, etc.
 *
 * Deployed in VPC per project coding standards.
 * Implements exponential backoff retry logic for eventual consistency.
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';
import { NagSuppressions } from 'cdk-nag';

export interface AIAgentSessionSetupLambdaProps {
  /** VPC for Lambda deployment */
  vpc: ec2.IVpc;
  /** DynamoDB Scenarios table name */
  scenariosTableName: string;
  /** DynamoDB Scenarios table ARN */
  scenariosTableArn: string;
  /** Connect instance ID (not ARN) */
  connectInstanceId: string;
  /** Q Connect Assistant ID */
  assistantId: string;
}

export class AIAgentSessionSetupLambdaConstruct extends Construct {
  public readonly function: lambda.Function;
  public readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: AIAgentSessionSetupLambdaProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    // Source path
    const lambdaDir = path.join(__dirname, '../../../src/lambda/ai_agent_session_setup');

    // Security group
    this.securityGroup = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc: props.vpc,
      description: 'Security group for AI Agent session setup Lambda',
      allowAllOutbound: true,
    });

    // Explicit log group (created before role so ARN can be referenced in policy)
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Execution role with inline policies (no managed policies per CLAUDE.md)
    const lambdaRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for AI Agent session setup Lambda - Connect + Q Connect + DynamoDB',
      inlinePolicies: {
        CloudWatchLogs: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['logs:CreateLogGroup'],
              resources: [logGroup.logGroupArn],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
              resources: [`${logGroup.logGroupArn}:*`],
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
        DynamoDBScenariosRead: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['dynamodb:GetItem', 'dynamodb:Scan'],
              resources: [props.scenariosTableArn],
            }),
          ],
        }),
        ConnectDescribeContact: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['connect:DescribeContact'],
              resources: [
                `arn:aws:connect:${stack.region}:${stack.account}:instance/${props.connectInstanceId}/contact/*`,
              ],
            }),
          ],
        }),
        QConnectUpdateSession: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['qconnect:UpdateSessionData', 'wisdom:UpdateSessionData'],
              resources: [
                `arn:aws:wisdom:${stack.region}:${stack.account}:session/${props.assistantId}/*`,
              ],
            }),
          ],
        }),
      },
    });

    // Lambda function
    this.function = new lambda.Function(this, 'Function', {
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(lambdaDir),
      role: lambdaRole,
      architecture: lambda.Architecture.X86_64,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.securityGroup],
      environment: {
        SCENARIOS_TABLE: props.scenariosTableName,
        ASSISTANT_ID: props.assistantId,
        CONNECT_INSTANCE_ID: props.connectInstanceId,
        LOG_LEVEL: 'INFO',
      },
      logGroup,
      description: 'Injects scenario data into AI Agent sessions via Q Connect UpdateSessionData API',
    });

    // NagSuppressions
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
          reason: 'Log stream names within the specific log group are dynamic. Wildcard scoped to the exact log group.',
          appliesTo: [{ regex: '/Resource::.*LogGroup.*:\\*$/g' } as any],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Connect contact IDs are dynamic. Resource scoped to specific Connect instance.',
          appliesTo: [{ regex: '/Resource::.*instance\\/.*\\/contact\\/\\*$/g' } as any],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Q Connect session IDs are dynamic. Resource scoped to specific Assistant.',
          appliesTo: [{ regex: '/Resource::.*session\\/.*\\/\\*$/g' } as any],
        },
      ],
      true,
    );

    // Outputs
    new cdk.CfnOutput(scope, 'AIAgentSessionSetupLambdaName', {
      value: this.function.functionName,
      description: 'AI Agent Session Setup Lambda function name',
    });

    new cdk.CfnOutput(scope, 'AIAgentSessionSetupLambdaArn', {
      value: this.function.functionArn,
      description: 'AI Agent Session Setup Lambda ARN (use in Connect contact flow)',
    });
  }
}
