/**
 * Connect Stack - Amazon Connect Training Integration
 *
 * This stack creates the supporting infrastructure for a manually-managed
 * Amazon Connect instance:
 * - Admin API Lambda (start call, list scenarios/agents/calls)
 * - AI Agent Session Setup Lambda (injects scenario data into AI Agent sessions)
 * - HTTP API Gateway (JWT auth) for Connect admin API
 * - Admin UI (CloudFront + S3 + Cognito)
 * - Post-call processing Lambda (Contact Lens analysis → scoring)
 *
 * Contact flow (manually imported in Connect Console):
 * - AI Agent flow — invokes Session Setup Lambda before AI Agent block
 *
 * Depends on: AgentCoreStack (for S3 storage, KMS key, DynamoDB)
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { NagSuppressions } from 'cdk-nag';

import { AgentCoreStack } from './agentcore-stack';
import { ConnectAudioBridgeConstruct } from './constructs/connect-audio-bridge';
import { ConnectAdminUIConstruct } from './constructs/connect-admin-ui';
import { ScoringLambdaConstruct } from './constructs/scoring-lambda';
import { AudioEmpathyLambdaConstruct } from './constructs/audio-empathy-lambda';
import { ConnectPostCallLambdaConstruct } from './constructs/connect-postcall-lambda';
import { AIAgentSessionSetupLambdaConstruct } from './constructs/ai-agent-session-setup-lambda';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const config = require('../config.json');

export interface ConnectStackProps extends cdk.StackProps {
  /** Reference to the shared AgentCore stack */
  agentCoreStack: AgentCoreStack;
}

export class ConnectStack extends cdk.Stack {
  public readonly audioBridge: ConnectAudioBridgeConstruct;
  public readonly adminUI: ConnectAdminUIConstruct;

  constructor(scope: Construct, id: string, props: ConnectStackProps) {
    super(scope, id, props);

    const { agentCoreStack } = props;

    // ========================================
    // Connect Instance (manually managed)
    // ========================================
    const connectInstanceArn: string = config.connect.instanceArn;
    if (!connectInstanceArn) {
      throw new Error('config.json: connect.instanceArn is required');
    }

    const connectRecordingsBucket: string = config.connect.recordingsBucket;
    if (!connectRecordingsBucket) {
      throw new Error('config.json: connect.recordingsBucket is required (S3 bucket where Connect stores recordings and Contact Lens analysis)');
    }

    // ========================================
    // Admin API Lambda (start-call, list scenarios/agents/calls)
    // ========================================
    this.audioBridge = new ConnectAudioBridgeConstruct(this, 'AudioBridge', {
      connectInstanceArn,
      contactFlowId: config.connect.contactFlowId,
      destinationPhoneNumber: config.connect.destinationPhoneNumber,
      recordingsBucket: agentCoreStack.storage.recordingsBucket,
      encryptionKey: agentCoreStack.storage.encryptionKey,
      vpc: agentCoreStack.vpc,
      scenariosTableName: agentCoreStack.dynamoTables.scenariosTable.tableName,
      scenariosTableArn: agentCoreStack.dynamoTables.scenariosTable.tableArn,
      sessionsTableName: agentCoreStack.dynamoTables.sessionsTable.tableName,
      sessionsTableArn: agentCoreStack.dynamoTables.sessionsTable.tableArn,
    });


    // ========================================
    // AI Agent Session Setup Lambda (Q Connect UpdateSessionData)
    // ========================================
    const connectInstanceId = cdk.Fn.select(1, cdk.Fn.split('instance/', connectInstanceArn));
    const assistantId = config.connect.AIAgentAssistantId || '516638f6-277b-489b-9681-503353132073';

    const sessionSetupLambda = new AIAgentSessionSetupLambdaConstruct(this, 'AIAgentSessionSetup', {
      vpc: agentCoreStack.vpc,
      scenariosTableName: agentCoreStack.dynamoTables.scenariosTable.tableName,
      scenariosTableArn: agentCoreStack.dynamoTables.scenariosTable.tableArn,
      connectInstanceId,
      assistantId,
    });

    // Grant Connect permission to invoke Session Setup Lambda
    sessionSetupLambda.function.addPermission('ConnectInvoke', {
      principal: new iam.ServicePrincipal('connect.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceAccount: this.account,
      sourceArn: connectInstanceArn,
    });

    // ========================================
    // AI Agent Manual Setup (Future Enhancement)
    // ========================================
    // NOTE: AI Agent and AI Prompt creation to be done manually in Q Connect console
    // due to strict prompt format requirements for orchestration AI Agents.
    // The Session Setup Lambda above can be used with manually-created AI Agents.
    //
    // To create manually:
    // 1. Create AI Prompt in Q Connect console with MESSAGES format
    // 2. Create AI Agent in Q Connect console with ORCHESTRATION type
    // 3. Update contact flow to invoke Session Setup Lambda, then AI Agent

    // ========================================
    // Admin UI (Cognito + CloudFront + S3)
    // ========================================
    this.adminUI = new ConnectAdminUIConstruct(this, 'AdminUI', {
      connectInstanceArn,
    });

    // ========================================
    // Scoring + Audio Empathy Lambdas (reuse constructs from Web stack)
    // ========================================
    const connectScoring = new ScoringLambdaConstruct(this, 'ConnectScoring', {
      recordingsBucket: agentCoreStack.storage.recordingsBucket,
      scoringBucket: agentCoreStack.storage.recordingsBucket,
      encryptionKey: agentCoreStack.storage.encryptionKey,
      vpc: agentCoreStack.vpc,
      criteriaConfigTableName: agentCoreStack.dynamoTables.criteriaConfigTable.tableName,
      criteriaConfigTableArn: agentCoreStack.dynamoTables.criteriaConfigTable.tableArn,
      sessionsTableName: agentCoreStack.dynamoTables.sessionsTable.tableName,
      sessionsTableArn: agentCoreStack.dynamoTables.sessionsTable.tableArn,
    });

    const connectEmpathy = new AudioEmpathyLambdaConstruct(this, 'ConnectEmpathy', {
      recordingsBucket: agentCoreStack.storage.recordingsBucket,
      encryptionKey: agentCoreStack.storage.encryptionKey,
      vpc: agentCoreStack.vpc,
    });

    // Wire empathy analysis into scoring pipeline
    connectScoring.function.addEnvironment(
      'AUDIO_EMPATHY_FUNCTION_NAME',
      connectEmpathy.function.functionName,
    );
    connectEmpathy.function.grantInvoke(connectScoring.function);

    // ========================================
    // Post-Call Processing Lambda (EventBridge → Contact Lens → Scoring)
    // ========================================
    const postCallLambda = new ConnectPostCallLambdaConstruct(this, 'PostCall', {
      vpc: agentCoreStack.vpc,
      recordingsBucket: agentCoreStack.storage.recordingsBucket,
      encryptionKey: agentCoreStack.storage.encryptionKey,
      sessionsTableName: agentCoreStack.dynamoTables.sessionsTable.tableName,
      sessionsTableArn: agentCoreStack.dynamoTables.sessionsTable.tableArn,
      scoringLambda: connectScoring.function,
      connectInstanceArn,
      connectRecordingsBucket,
    });

    // ========================================
    // HTTP API Gateway (JWT auth for Connect admin API)
    // ========================================
    const authorizer = new HttpUserPoolAuthorizer('ConnectAdminAuthorizer', this.adminUI.userPool, {
      userPoolClients: [this.adminUI.userPoolClient],
      identitySource: ['$request.header.Authorization'],
    });

    const connectApi = new apigwv2.HttpApi(this, 'ConnectAdminApi', {
      apiName: 'ConnectTrainingAdminApi',
      corsPreflight: {
        allowOrigins: [
          `https://${this.adminUI.distribution.distributionDomainName}`,
          'http://localhost:5174',
        ],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['Authorization', 'Content-Type'],
        maxAge: cdk.Duration.hours(1),
      },
      defaultAuthorizer: authorizer,
    });

    // Access logging
    const apiAccessLogGroup = new logs.LogGroup(this, 'ConnectApiAccessLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const apiDefaultStage = connectApi.defaultStage?.node.defaultChild as apigwv2.CfnStage;
    apiDefaultStage.accessLogSettings = {
      destinationArn: apiAccessLogGroup.logGroupArn,
      format: JSON.stringify({
        requestId: '$context.requestId',
        ip: '$context.identity.sourceIp',
        requestTime: '$context.requestTime',
        httpMethod: '$context.httpMethod',
        path: '$context.path',
        status: '$context.status',
        protocol: '$context.protocol',
        responseLength: '$context.responseLength',
      }),
    };

    const connectIntegration = new HttpLambdaIntegration('ConnectLambdaIntegration', this.audioBridge.unifiedLambda);

    connectApi.addRoutes({ path: '/scenarios', methods: [apigwv2.HttpMethod.GET], integration: connectIntegration });
    connectApi.addRoutes({ path: '/agents', methods: [apigwv2.HttpMethod.GET], integration: connectIntegration });
    connectApi.addRoutes({ path: '/calls', methods: [apigwv2.HttpMethod.GET], integration: connectIntegration });
    connectApi.addRoutes({ path: '/calls/{sessionId}', methods: [apigwv2.HttpMethod.GET], integration: connectIntegration });
    connectApi.addRoutes({ path: '/calls/{sessionId}/audio', methods: [apigwv2.HttpMethod.GET], integration: connectIntegration });
    connectApi.addRoutes({ path: '/start-call', methods: [apigwv2.HttpMethod.POST], integration: connectIntegration });

    // ========================================
    // Stack-level suppressions for CDK-internal constructs
    // (BucketDeployment, AwsCustomResource, and Custom Resource Provider Lambda)
    // ========================================
    NagSuppressions.addStackSuppressions(
      this,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'CDK BucketDeployment, AwsCustomResource, and Custom Resource Provider use internally-managed Lambda functions with AWSLambdaBasicExecutionRole. Cannot modify CDK-internal constructs.',
          appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'CDK BucketDeployment Lambda requires broad S3 and KMS permissions to copy assets. These are CDK-internal constructs.',
          appliesTo: [
            'Action::s3:GetBucket*',
            'Action::s3:GetObject*',
            'Action::s3:List*',
            'Action::s3:Abort*',
            'Action::s3:DeleteObject*',
            'Action::kms:GenerateDataKey*',
            'Action::kms:ReEncrypt*',
            'Resource::*',
          ],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'CDK BucketDeployment requires S3 object-level access with /* suffix.',
          appliesTo: [
            { regex: '/Resource::.*\\.Arn>\\/\\*$/g' } as any,
            { regex: '/Resource::arn:aws:s3:::cdk-.*\\*$/g' } as any,
          ],
        },
        {
          id: 'AwsSolutions-L1',
          reason: 'CDK BucketDeployment and AwsCustomResource use internally-managed Lambda runtimes. Cannot control their runtime version.',
        },
        {
          id: 'Prototype Security Nag Pack-LambdaInsideVPC',
          reason: 'CDK BucketDeployment and AwsCustomResource use internally-managed Lambda functions that cannot be deployed to VPC.',
        },
      ],
    );

    // ========================================
    // Outputs
    // ========================================
    new cdk.CfnOutput(this, 'ConnectInstanceArn', {
      value: connectInstanceArn,
      description: 'Amazon Connect Instance ARN (manually managed)',
    });

    new cdk.CfnOutput(this, 'ConnectAdminApiUrl', {
      value: connectApi.apiEndpoint,
      description: 'Connect Admin API Gateway endpoint URL',
    });

    // Note: AIAgentSessionSetupLambdaArn and AIAgentSessionSetupLambdaName outputs
    // are created by AIAgentSessionSetupLambdaConstruct
  }
}
