/**
 * Connect AI Agent Construct
 *
 * Provisions the Q Connect (Wisdom) resources needed by the training contact flow:
 *   - Wisdom Assistant (AI Agent domain)
 *   - Connect Security Profile with AI-Agent permissions
 *   - AI Prompt + AI Agent + published versions (via Lambda-backed custom resource)
 *   - WISDOM_ASSISTANT integration association to the Connect instance
 *
 * The AI Prompt/Agent APIs are not natively supported by CloudFormation — we use a
 * Python Lambda custom resource that calls qconnect / connect boto3 APIs directly.
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as wisdom from 'aws-cdk-lib/aws-wisdom';
import * as connect from 'aws-cdk-lib/aws-connect';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { NagSuppressions } from 'cdk-nag';
import { solutionUserAgent } from '../utils/solution';

export interface ConnectAIAgentProps {
  /** VPC for custom resource Lambda */
  vpc: ec2.IVpc;
  /** Connect instance ARN */
  connectInstanceArn: string;
  /** Connect instance ID */
  connectInstanceId: string;
  /** Friendly name for the Wisdom Assistant */
  assistantName?: string;
  /** Friendly name for the AI Prompt */
  promptName?: string;
  /** Friendly name for the AI Agent */
  agentName?: string;
  /** Bedrock model ID for the orchestration prompt */
  modelId?: string;
  /** Locale for the AI Agent, e.g., en_US */
  locale?: string;
  /** Path to the prompt YAML template (defaults to amazon-connect/ai-agent-prompt-template.txt) */
  promptTemplatePath?: string;
}

export class ConnectAIAgentConstruct extends Construct {
  public readonly assistantArn: string;
  public readonly assistantId: string;
  public readonly publishedAIAgentVersionArn: string;
  public readonly aiAgentId: string;
  public readonly securityProfileArn: string;
  public readonly securityProfileId: string;

  constructor(scope: Construct, id: string, props: ConnectAIAgentProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const assistantName = props.assistantName ?? 'call-center-training-assistant';
    const promptName = props.promptName ?? 'CallCenterTrainingPrompt';
    const agentName = props.agentName ?? 'call-center-training';
    const modelId = props.modelId ?? 'global.anthropic.claude-sonnet-4-5-20250929-v1:0';
    const locale = props.locale ?? 'en_US';
    const templatePath = props.promptTemplatePath
      ?? path.join(__dirname, '../../../amazon-connect/ai-agent-prompt-template.txt');

    // Load the orchestration prompt at synth time
    const promptContent = fs.readFileSync(templatePath, 'utf-8');

    // Wisdom Assistant
    const assistant = new wisdom.CfnAssistant(this, 'Assistant', {
      name: assistantName,
      type: 'AGENT',
      description: 'AI agent domain for call center training',
      tags: [{ key: 'AmazonConnectEnabled', value: 'True' }],
    });
    this.assistantArn = assistant.attrAssistantArn;
    this.assistantId = assistant.attrAssistantId;

    // Security Profile (Connect) for AI-Agent association
    const securityProfile = new connect.CfnSecurityProfile(this, 'AIAgentSecurityProfile', {
      instanceArn: props.connectInstanceArn,
      securityProfileName: 'CallCenterTrainingAIAgent',
      description: 'Security profile for Call Center Training AI Agents',
      permissions: [
        'BasicAgentAccess',
        'Wisdom.View',
      ],
    });
    this.securityProfileArn = securityProfile.attrSecurityProfileArn;
    this.securityProfileId = cdk.Fn.select(3, cdk.Fn.split('/', securityProfile.attrSecurityProfileArn));

    // Custom resource Lambda
    const lambdaDir = path.join(__dirname, '../../../src/lambda/connect_ai_agent_setup');

    const sg = new ec2.SecurityGroup(this, 'CRSg', {
      vpc: props.vpc,
      description: 'AI Agent setup custom resource Lambda',
      allowAllOutbound: true,
    });

    const logGroup = new logs.LogGroup(this, 'CRLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const role = new iam.Role(this, 'CRRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for AI Agent setup custom resource',
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
        QConnectAIPrompts: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'qconnect:CreateAIPrompt',
                'qconnect:CreateAIPromptVersion',
                'qconnect:DeleteAIPrompt',
                'qconnect:ListAIPrompts',
                'qconnect:ListAIPromptVersions',
                'qconnect:GetAIPrompt',
                'qconnect:UpdateAIPrompt',
                'wisdom:CreateAIPrompt',
                'wisdom:CreateAIPromptVersion',
                'wisdom:DeleteAIPrompt',
                'wisdom:ListAIPrompts',
                'wisdom:ListAIPromptVersions',
                'wisdom:GetAIPrompt',
                'wisdom:UpdateAIPrompt',
              ],
              resources: [
                `arn:aws:wisdom:${stack.region}:${stack.account}:assistant/*`,
                `arn:aws:wisdom:${stack.region}:${stack.account}:assistant/*/*`,
                `arn:aws:wisdom:${stack.region}:${stack.account}:ai-prompt/*/*`,
                `arn:aws:qconnect:${stack.region}:${stack.account}:assistant/*`,
                `arn:aws:qconnect:${stack.region}:${stack.account}:assistant/*/*`,
                `arn:aws:qconnect:${stack.region}:${stack.account}:ai-prompt/*/*`,
              ],
            }),
          ],
        }),
        QConnectAIAgents: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'qconnect:CreateAIAgent',
                'qconnect:CreateAIAgentVersion',
                'qconnect:DeleteAIAgent',
                'qconnect:ListAIAgents',
                'qconnect:ListAIAgentVersions',
                'qconnect:GetAIAgent',
                'qconnect:UpdateAIAgent',
                'wisdom:CreateAIAgent',
                'wisdom:CreateAIAgentVersion',
                'wisdom:DeleteAIAgent',
                'wisdom:ListAIAgents',
                'wisdom:ListAIAgentVersions',
                'wisdom:GetAIAgent',
                'wisdom:UpdateAIAgent',
              ],
              resources: [
                `arn:aws:wisdom:${stack.region}:${stack.account}:assistant/*`,
                `arn:aws:wisdom:${stack.region}:${stack.account}:assistant/*/*`,
                `arn:aws:wisdom:${stack.region}:${stack.account}:ai-agent/*/*`,
                `arn:aws:qconnect:${stack.region}:${stack.account}:assistant/*`,
                `arn:aws:qconnect:${stack.region}:${stack.account}:assistant/*/*`,
                `arn:aws:qconnect:${stack.region}:${stack.account}:ai-agent/*/*`,
              ],
            }),
          ],
        }),
        ConnectIntegrationAndSecurity: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'connect:CreateIntegrationAssociation',
                'connect:DeleteIntegrationAssociation',
                'connect:ListIntegrationAssociations',
                'connect:AssociateSecurityProfiles',
                'connect:DisassociateSecurityProfiles',
                'connect:ListEntitySecurityProfiles',
                'connect:ListSecurityProfiles',
                'connect:DescribeInstance',
              ],
              resources: [
                props.connectInstanceArn,
                `${props.connectInstanceArn}/*`,
              ],
            }),
          ],
        }),
        WisdomAssistantManagement: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'wisdom:GetAssistant',
                'wisdom:TagResource',
                'wisdom:UntagResource',
                'qconnect:GetAssistant',
                'qconnect:TagResource',
                'qconnect:UntagResource',
              ],
              resources: [
                `arn:aws:wisdom:${stack.region}:${stack.account}:assistant/*`,
                `arn:aws:qconnect:${stack.region}:${stack.account}:assistant/*`,
              ],
            }),
          ],
        }),
      },
    });

    const setupFn = new lambda.Function(this, 'SetupFn', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(lambdaDir, {
        bundling: {
          // Docker image never used — local bundler short-circuits first
          image: lambda.Runtime.PYTHON_3_13.bundlingImage,
          local: {
            tryBundle(outputDir: string) {
              try {
                execSync('python3 --version', { stdio: 'ignore' });
              } catch {
                return false;
              }
              execSync(
                `python3 -m pip install --no-cache-dir -r ${lambdaDir}/requirements.txt -t ${outputDir}`,
                { stdio: 'inherit' },
              );
              execSync(`cp -r ${lambdaDir}/. ${outputDir}/`, { stdio: 'inherit' });
              return true;
            },
          },
          command: ['bash', '-c', 'echo "local bundling should have handled this"'],
        },
      }),
      role,
      architecture: lambda.Architecture.X86_64,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [sg],
      logGroup,
      environment: {
        USER_AGENT_STRING: solutionUserAgent(this),
      },
      description: 'Provisions Q Connect AI Prompt + AI Agent for call center training',
    });

    const provider = new cr.Provider(this, 'Provider', {
      onEventHandler: setupFn,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    const customResource = new cdk.CustomResource(this, 'AIAgentSetup', {
      serviceToken: provider.serviceToken,
      properties: {
        AssistantId: this.assistantId,
        ConnectInstanceId: props.connectInstanceId,
        Region: stack.region,
        AccountId: stack.account,
        PromptContent: promptContent,
        PromptName: promptName,
        AgentName: agentName,
        ModelId: modelId,
        Locale: locale,
        SecurityProfileId: this.securityProfileId,
        IntegrationAssociate: 'true',
        // Forces re-invocation on template hash change so prompt edits take effect
        PromptHash: hashString(promptContent),
      },
    });
    customResource.node.addDependency(assistant);
    customResource.node.addDependency(securityProfile);

    this.publishedAIAgentVersionArn = customResource.getAttString('PublishedAIAgentVersionArn');
    this.aiAgentId = customResource.getAttString('AIAgentId');

    // Outputs
    new cdk.CfnOutput(scope, 'AIAgentAssistantId', {
      value: this.assistantId,
      description: 'Q Connect AI Agent Assistant ID',
    });
    new cdk.CfnOutput(scope, 'AIAgentAssistantArn', {
      value: this.assistantArn,
      description: 'Q Connect AI Agent Assistant ARN',
    });
    new cdk.CfnOutput(scope, 'AIAgentPublishedVersionArn', {
      value: this.publishedAIAgentVersionArn,
      description: 'Published AI Agent version ARN (used by contact flow)',
    });

    // Nag suppressions
    NagSuppressions.addResourceSuppressions(
      role,
      [
        { id: 'AwsSolutions-IAM5', reason: 'VPC ENI actions do not support resource ARNs.', appliesTo: ['Resource::*'] },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Log stream names within the specific log group are dynamic. Scoped to the CR log group only.',
          appliesTo: [{ regex: '/Resource::.*\\.Arn>:\\*$/g' } as any],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Wisdom/qconnect resource IDs (assistant, prompt, agent) are generated at runtime. Wildcards scoped to account+region.',
          appliesTo: [
            { regex: '/Resource::arn:aws:(wisdom|qconnect):.*\\*$/g' } as any,
          ],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Connect sub-resource IDs (integration-association, security-profile, ai-agent) are dynamic. Wildcard scoped to specific Connect instance.',
          appliesTo: [{ regex: '/Resource::arn:aws:connect:.*\\/\\*$/g' } as any],
        },
      ],
      true,
    );
  }
}

function hashString(s: string): string {
  // Simple deterministic hash so template changes redeploy the custom resource
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h.toString(16);
}
