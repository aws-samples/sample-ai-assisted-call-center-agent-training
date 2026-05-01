/**
 * Connect Stack - Amazon Connect Training Integration
 *
 * Fully provisions the Connect stack (either a greenfield instance or against
 * an existing one, controlled by `config.connect.manageInstance`):
 *   - Amazon Connect instance + KMS recordings bucket + storage configs
 *   - Wisdom AI Agent Assistant + AI Prompt + AI Agent (orchestration)
 *   - Lex V2 bot + LEX_BOT integration (Nova Sonic speech-to-speech still manual)
 *   - Toll-free phone number (TOLL_FREE, US)
 *   - Contact flows (voice + chat) with ARNs substituted at deploy time
 *   - Lambda integration for Session Setup
 *   - Admin API Lambda, API Gateway, Admin UI, post-call pipeline (unchanged)
 *
 * Depends on: CoreInfraStack (VPC, DynamoDB, recordings bucket, KMS key).
 * Does NOT depend on AgentRuntimeStack — Connect does not invoke the AgentCore runtime.
 */

import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import { Construct } from 'constructs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { NagSuppressions } from 'cdk-nag';

import { CoreInfraStack } from './core-infra-stack';
import { ConnectAudioBridgeConstruct } from './constructs/connect-audio-bridge';
import { ConnectAdminUIConstruct } from './constructs/connect-admin-ui';
import { ScoringLambdaConstruct } from './constructs/scoring-lambda';
import { AudioEmpathyLambdaConstruct } from './constructs/audio-empathy-lambda';
import { ConnectPostCallLambdaConstruct } from './constructs/connect-postcall-lambda';
import { AIAgentSessionSetupLambdaConstruct } from './constructs/ai-agent-session-setup-lambda';
import { ConnectInstanceConstruct } from './constructs/connect-instance';
import { ConnectAIAgentConstruct } from './constructs/connect-ai-agent';
import { ConnectLexBotConstruct } from './constructs/connect-lex-bot';
import { ConnectContactFlowConstruct } from './constructs/connect-contact-flow';
import { ConnectPhoneNumberConstruct } from './constructs/connect-phone-number';
import { ConnectLambdaIntegrationConstruct } from './constructs/connect-lambda-integration';
import { ConnectAgentUserConstruct } from './constructs/connect-agent-user';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const config = require('../config.json');

export interface ConnectStackProps extends cdk.StackProps {
  coreStack: CoreInfraStack;
}

export class ConnectStack extends cdk.Stack {
  public readonly audioBridge: ConnectAudioBridgeConstruct;
  public readonly adminUI: ConnectAdminUIConstruct;

  constructor(scope: Construct, id: string, props: ConnectStackProps) {
    super(scope, id, props);

    const { coreStack } = props;
    // Alias for backward-compatible references below; maps to shared Core infra.
    const agentCoreStack = coreStack;

    // ========================================
    // Feature flags — toggle unreliable resources off while iterating
    // ========================================
    const manageInstance: boolean = config.connect?.manageInstance ?? true;
    const features = config.connect?.features ?? {};
    const enableLexBot: boolean = features.lexBot ?? true;
    const enableAIAgent: boolean = features.aiAgent ?? true;
    const enableContactFlows: boolean = features.contactFlows ?? true;
    const enablePhoneNumber: boolean = features.phoneNumber ?? manageInstance;
    const enableAgentUser: boolean = features.agentUser ?? manageInstance;

    console.log('Connect stack feature flags:', {
      manageInstance, enableLexBot, enableAIAgent, enableContactFlows,
      enablePhoneNumber, enableAgentUser,
    });

    // ========================================
    // Connect Instance — CDK-managed or wrap existing
    // ========================================
    const connectInstance = new ConnectInstanceConstruct(this, 'Instance', {
      existingInstanceArn: manageInstance ? undefined : config.connect?.instanceArn,
      existingRecordingsBucket: manageInstance ? undefined : config.connect?.recordingsBucket,
      instanceAlias: config.connect?.instanceAlias,
    });

    // ========================================
    // Wisdom Assistant + AI Prompt + AI Agent (via custom resource) (optional)
    // Created before the Lex bot so its assistant ARN can be wired into the
    // AMAZON.QInConnectIntent on the bot.
    // ========================================
    const aiAgent = enableAIAgent
      ? new ConnectAIAgentConstruct(this, 'AIAgent', {
          vpc: agentCoreStack.vpc,
          connectInstanceArn: connectInstance.instanceArn,
          connectInstanceId: connectInstance.instanceId,
        })
      : undefined;

    // ========================================
    // Lex V2 Bot + LEX_BOT integration association (optional)
    // Requires the Wisdom Assistant ARN for the QInConnectIntent bridge.
    // ========================================
    if (enableLexBot && !aiAgent) {
      throw new Error(
        'config.connect.features.lexBot requires features.aiAgent to be enabled too — ' +
        'the Lex bot wires the QInConnectIntent to the Wisdom Assistant.',
      );
    }
    const lexBot = enableLexBot && aiAgent
      ? new ConnectLexBotConstruct(this, 'LexBot', {
          connectInstanceArn: connectInstance.instanceArn,
          connectInstanceId: connectInstance.instanceId,
          wisdomAssistantArn: aiAgent.assistantArn,
        })
      : undefined;

    // ========================================
    // Admin API Lambda (start-call, list scenarios/agents/calls)
    // ========================================
    this.audioBridge = new ConnectAudioBridgeConstruct(this, 'AudioBridge', {
      connectInstanceArn: connectInstance.instanceArn,
      contactFlowId: '',  // filled below once contact flow exists (via env update)
      destinationPhoneNumber: '',
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
    // Skipped when AI Agent is disabled — it has nothing to update.
    // ========================================
    const sessionSetupLambda = aiAgent
      ? new AIAgentSessionSetupLambdaConstruct(this, 'AIAgentSessionSetup', {
          vpc: agentCoreStack.vpc,
          scenariosTableName: agentCoreStack.dynamoTables.scenariosTable.tableName,
          scenariosTableArn: agentCoreStack.dynamoTables.scenariosTable.tableArn,
          connectInstanceId: connectInstance.instanceId,
          assistantId: aiAgent.assistantId,
        })
      : undefined;

    if (sessionSetupLambda) {
      // Wire the Session Setup Lambda into the Connect instance
      new ConnectLambdaIntegrationConstruct(this, 'SessionSetupLambdaIntegration', {
        instanceArn: connectInstance.instanceArn,
        fn: sessionSetupLambda.function,
      });
    }

    // ========================================
    // Contact flows — voice + chat, with ARN substitution (optional)
    // Requires AI Agent + Lex Bot + Session Setup Lambda
    // ========================================
    const canBuildFlows = enableContactFlows && !!aiAgent && !!lexBot && !!sessionSetupLambda;
    const voiceFlow = canBuildFlows
      ? new ConnectContactFlowConstruct(this, 'VoiceFlow', {
          instanceArn: connectInstance.instanceArn,
          name: 'CallCenterTrainingVoice',
          description: 'Voice contact flow for call center training',
          type: 'CONTACT_FLOW',
          flowJsonPath: path.join(__dirname, '../../amazon-connect/AIAgentFlow.json'),
          substitutions: {
            WisdomAssistantArn: aiAgent!.assistantArn,
            AIAgentVersionArn: aiAgent!.publishedAIAgentVersionArn,
            LambdaArn: sessionSetupLambda!.function.functionArn,
            LexBotAliasArn: lexBot!.botAliasArn,
          },
        })
      : undefined;

    const chatFlow = canBuildFlows
      ? new ConnectContactFlowConstruct(this, 'ChatFlow', {
          instanceArn: connectInstance.instanceArn,
          name: 'CallCenterTrainingChat',
          description: 'Chat contact flow for call center training',
          type: 'CONTACT_FLOW',
          flowJsonPath: path.join(__dirname, '../../amazon-connect/AIAgentChatFlow.json'),
          substitutions: {
            WisdomAssistantArn: aiAgent!.assistantArn,
            AIAgentVersionArn: aiAgent!.publishedAIAgentVersionArn,
            LambdaArn: sessionSetupLambda!.function.functionArn,
            LexBotAliasArn: lexBot!.botAliasArn,
          },
        })
      : undefined;

    // ========================================
    // Toll-free phone number (optional)
    // ========================================
    let destinationPhoneNumber = '';
    if (enablePhoneNumber && manageInstance) {
      const phone = new ConnectPhoneNumberConstruct(this, 'PhoneNumber', {
        instanceArn: connectInstance.instanceArn,
        instanceId: connectInstance.instanceId,
        useDefaultSampleInboundFlow: true,
      });
      destinationPhoneNumber = phone.phoneNumber;
    } else if (!manageInstance) {
      destinationPhoneNumber = config.connect?.destinationPhoneNumber ?? '';
    }

    // Wire the contact flow ID + phone number into the Admin API Lambda env
    if (voiceFlow) {
      this.audioBridge.unifiedLambda.addEnvironment('CONTACT_FLOW_ID', voiceFlow.contactFlowId);
    }
    if (destinationPhoneNumber) {
      this.audioBridge.unifiedLambda.addEnvironment('DESTINATION_PHONE', destinationPhoneNumber);
    }

    // ========================================
    // Connect agent user (CCP login) (optional)
    // ========================================
    if (enableAgentUser && manageInstance) {
      new ConnectAgentUserConstruct(this, 'AgentUser', {
        vpc: agentCoreStack.vpc,
        connectInstanceArn: connectInstance.instanceArn,
        connectInstanceId: connectInstance.instanceId,
        username: config.connect?.agentUsername ?? 'trainee',
      });
    }

    // ========================================
    // Admin UI (Cognito + CloudFront + S3)
    // ========================================
    this.adminUI = new ConnectAdminUIConstruct(this, 'AdminUI', {
      connectInstanceArn: connectInstance.instanceArn,
    });

    // ========================================
    // Scoring + Audio Empathy Lambdas
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

    connectScoring.function.addEnvironment(
      'AUDIO_EMPATHY_FUNCTION_NAME',
      connectEmpathy.function.functionName,
    );
    connectEmpathy.function.grantInvoke(connectScoring.function);

    // ========================================
    // Post-Call Processing Lambda
    // ========================================
    new ConnectPostCallLambdaConstruct(this, 'PostCall', {
      vpc: agentCoreStack.vpc,
      recordingsBucket: agentCoreStack.storage.recordingsBucket,
      encryptionKey: agentCoreStack.storage.encryptionKey,
      sessionsTableName: agentCoreStack.dynamoTables.sessionsTable.tableName,
      sessionsTableArn: agentCoreStack.dynamoTables.sessionsTable.tableArn,
      scoringLambda: connectScoring.function,
      connectInstanceArn: connectInstance.instanceArn,
      connectRecordingsBucket: connectInstance.recordingsBucketName,
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
    // Stack-level CDK-internal suppressions
    // ========================================
    NagSuppressions.addStackSuppressions(
      this,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'CDK BucketDeployment, AwsCustomResource, and Custom Resource Provider use internally-managed Lambda functions with AWSLambdaBasicExecutionRole.',
          appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'CDK BucketDeployment Lambda requires broad S3 and KMS permissions to copy assets.',
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
          reason: 'CDK BucketDeployment and AwsCustomResource use internally-managed Lambda runtimes.',
        },
        {
          id: 'Prototype Security Nag Pack-LambdaInsideVPC',
          reason: 'CDK BucketDeployment and AwsCustomResource use internally-managed Lambda functions that cannot be deployed to VPC.',
        },
        {
          id: 'AwsSolutions-IAM4',
          reason: 'Custom Resource Provider framework Lambda uses AWSLambdaVPCAccessExecutionRole, managed by CDK internals.',
          appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole'],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Custom Resource Provider framework adds :* suffix on Lambda ARN for version/alias qualifiers. Scoped to the specific handler.',
          appliesTo: [{ regex: '/Resource::<.*Fn.*\\.Arn>:\\*$/g' } as any],
        },
      ],
    );

    // Post-call Lambda reads from the Connect recordings bucket we create here.
    // The construct scopes this to a specific bucket, but when we pass a managed
    // bucket the resource name is a CFN ref — suppress the generated /* rule.
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Connect recordings bucket object access requires /* suffix. Resource scoped to the specific bucket.',
        appliesTo: [{ regex: '/Resource::arn:aws:s3:::<Instance.*RecordingsBucket.*>\\/\\*$/g' } as any],
      },
    ]);

    // ========================================
    // Outputs
    // ========================================
    new cdk.CfnOutput(this, 'ConnectInstanceArn', {
      value: connectInstance.instanceArn,
      description: 'Amazon Connect Instance ARN',
    });

    if (voiceFlow) {
      new cdk.CfnOutput(this, 'ConnectContactFlowId', {
        value: voiceFlow.contactFlowId,
        description: 'Voice contact flow ID (target for outbound training calls)',
      });
    }

    if (chatFlow) {
      new cdk.CfnOutput(this, 'ConnectChatContactFlowId', {
        value: chatFlow.contactFlowId,
        description: 'Chat contact flow ID',
      });
    }

    new cdk.CfnOutput(this, 'ConnectAdminApiUrl', {
      value: connectApi.apiEndpoint,
      description: 'Connect Admin API Gateway endpoint URL',
    });
  }
}
