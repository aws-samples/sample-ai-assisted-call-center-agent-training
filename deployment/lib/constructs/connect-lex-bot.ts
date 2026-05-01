/**
 * Connect Lex Bot Construct
 *
 * Creates a Lex V2 bot with a minimal en-US locale and associates it with the
 * Connect instance via LEX_BOT IntegrationAssociation.
 *
 * Known limitation: Amazon Connect's "Conversational AI" bot with Nova Sonic
 * speech-to-speech + AI Agent Intent is a Connect-console-native concept that
 * layers additional configuration on top of the Lex bot. CloudFormation / CFN
 * primitives do not expose those settings directly. After deploy, the operator
 * must open the bot in the Connect console → Conversational AI tab → set
 * Model type = Speech-to-speech, Voice provider = Amazon Nova Sonic, then
 * Build Language again.
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lex from 'aws-cdk-lib/aws-lex';
import * as connect from 'aws-cdk-lib/aws-connect';

export interface ConnectLexBotProps {
  connectInstanceArn: string;
  connectInstanceId: string;
  /** Wisdom Assistant ARN to wire into the AMAZON.QInConnectIntent */
  wisdomAssistantArn: string;
  botName?: string;
}

export class ConnectLexBotConstruct extends Construct {
  public readonly botId: string;
  public readonly botArn: string;
  public readonly botAliasId: string;
  public readonly botAliasArn: string;

  constructor(scope: Construct, id: string, props: ConnectLexBotProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const botName = props.botName ?? 'call-center-training-agent-bot';

    // Lex V2 requires the Amazon-Connect-specific service-linked role for
    // AMAZON.QInConnectIntent to access Q Connect. A custom role is rejected
    // with "Amazon Lex could not access your Q In Connect Assistant". The SLR
    // is auto-created the first time a bot is built via the Connect console;
    // its inline policies (AmazonLexV2QinConnectPolicy<instanceId>) are managed
    // by Connect when bots are attached via Conversational AI.
    const botRoleArn = `arn:aws:iam::${stack.account}:role/aws-service-role/lexv2.amazonaws.com/AWSServiceRoleForLexV2Bots_AmazonConnect_${stack.account}`;

    // Minimal bot with a single fallback intent. The "real" conversational logic
    // comes from the Q Connect AI Agent invoked through Connect's AI Agent Intent.
    const bot = new lex.CfnBot(this, 'Bot', {
      name: botName,
      description: 'Conversational AI bot for call center training',
      roleArn: botRoleArn,
      dataPrivacy: { ChildDirected: false },
      idleSessionTtlInSeconds: 600,
      autoBuildBotLocales: true,
      // Required for access via the Connect Conversational AI console UI
      botTags: [
        { key: 'AmazonConnectEnabled', value: 'True' },
      ],
      testBotAliasTags: [
        { key: 'AmazonConnectEnabled', value: 'True' },
      ],
      botLocales: [
        {
          localeId: 'en_US',
          nluConfidenceThreshold: 0.4,
          // `voiceSettings` (Polly) is mutually exclusive with
          // `unifiedSpeechSettings` (Nova Sonic speech-to-speech). Providing
          // both causes the CFN import to fail with a generic "Importing ...
          // failed" error. Nova Sonic is preferred for training calls.
          unifiedSpeechSettings: {
            speechFoundationModel: {
              modelArn: `arn:aws:bedrock:${stack.region}::foundation-model/amazon.nova-2-sonic-v1:0`,
            },
          },
          intents: [
            {
              // Built-in Q in Connect intent — bridges Lex into the Q Connect
              // AI Agent. Without this intent the Lex bot cannot invoke the AI
              // Agent and all input falls through to FallbackIntent.
              name: 'AmazonQinConnect',
              description: 'Leverages Amazon Q in Connect to fulfill requests or tasks.',
              parentIntentSignature: 'AMAZON.QInConnectIntent',
              qInConnectIntentConfiguration: {
                qInConnectAssistantConfiguration: {
                  assistantArn: props.wisdomAssistantArn,
                },
              },
              fulfillmentCodeHook: {
                enabled: false,
                isActive: true,
                postFulfillmentStatusSpecification: {
                  successResponse: {
                    messageGroupsList: [
                      {
                        message: {
                          plainTextMessage: { value: '((x-amz-lex:q-in-connect-response))' },
                        },
                      },
                    ],
                    allowInterrupt: true,
                  },
                  successNextStep: { dialogAction: { type: 'EndConversation' } },
                  failureNextStep: { dialogAction: { type: 'EndConversation' } },
                  timeoutNextStep: { dialogAction: { type: 'EndConversation' } },
                },
              },
            },
            {
              name: 'FallbackIntent',
              description: 'Default fallback',
              parentIntentSignature: 'AMAZON.FallbackIntent',
            },
          ],
        },
      ],
    });
    this.botId = bot.attrId;
    this.botArn = bot.attrArn;

    // Publish DRAFT as a numeric version. Lex V2 does NOT allow aliases to
    // point at DRAFT (user-created aliases must reference a numeric version),
    // so we publish. A content-hash logical ID makes CFN create a new numeric
    // version only when the intent/locale config actually changes, avoiding
    // churn on no-op deploys.
    //
    // Connect's Conversational AI settings (Nova Sonic, AI Agent Intent) are
    // keyed by the alias ARN — not the version ID. Since CfnBotAlias's alias
    // ID (HAVUSYA9DC) stays constant across deploys (only botVersion changes,
    // which is mutable), those console-set Connect settings persist even when
    // the numeric version bumps.
    const versionHash = hashString(JSON.stringify(bot.botLocales));
    const botVersion = new lex.CfnBotVersion(this, `BotVersion-${versionHash}`, {
      botId: bot.attrId,
      botVersionLocaleSpecification: [
        {
          localeId: 'en_US',
          botVersionLocaleDetails: { sourceBotVersion: 'DRAFT' },
        },
      ],
    });

    const botAlias = new lex.CfnBotAlias(this, 'BotAlias', {
      botId: bot.attrId,
      botAliasName: 'Live',
      botVersion: botVersion.attrBotVersion,
      sentimentAnalysisSettings: { DetectSentiment: false },
      botAliasLocaleSettings: [
        {
          localeId: 'en_US',
          botAliasLocaleSetting: { enabled: true },
        },
      ],
    });
    this.botAliasId = botAlias.attrBotAliasId;
    this.botAliasArn = botAlias.attrArn;

    // Required for the Connect Conversational AI console UI to surface this alias
    cdk.Tags.of(botAlias).add('AmazonConnectEnabled', 'True');

    // Allow Connect to invoke the bot alias
    new lex.CfnResourcePolicy(this, 'BotAliasPolicy', {
      resourceArn: botAlias.attrArn,
      policy: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'AllowConnectToInvoke',
            Effect: 'Allow',
            Principal: { Service: 'connect.amazonaws.com' },
            Action: ['lex:RecognizeText', 'lex:RecognizeUtterance', 'lex:StartConversation'],
            Resource: botAlias.attrArn,
            Condition: {
              StringEquals: { 'AWS:SourceAccount': stack.account },
              ArnEquals: { 'AWS:SourceArn': props.connectInstanceArn },
            },
          },
        ],
      },
    });

    // Wire bot alias to Connect instance
    const integration = new connect.CfnIntegrationAssociation(this, 'LexIntegration', {
      instanceId: props.connectInstanceArn,
      integrationType: 'LEX_BOT',
      integrationArn: botAlias.attrArn,
    });
    integration.addDependency(botAlias);

    new cdk.CfnOutput(scope, 'LexBotAliasArn', {
      value: botAlias.attrArn,
      description: 'Lex V2 bot alias ARN used by the contact flow',
    });
  }
}

function hashString(s: string): string {
  // Deterministic short hash for CFN logical ID suffixes. Non-crypto; only used
  // to produce a stable string that changes when the input changes.
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36).slice(0, 8);
}
