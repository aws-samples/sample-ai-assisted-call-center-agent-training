#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CoreInfraStack } from '../lib/core-infra-stack';
import { AgentRuntimeStack } from '../lib/agent-runtime-stack';
import { WebUIStack } from '../lib/webui-stack';
import { ConnectStack } from '../lib/connect-stack';
import { AwsSolutionsChecks } from 'cdk-nag';
import { PrototypeSecurityNagPack } from './prototype-security';

const app = new cdk.App();

// Get configuration from context or environment
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

const environment = app.node.tryGetContext('environment') || 'dev';
const commonTags = {
  Application: 'CallCenterTraining',
  Environment: environment,
  ManagedBy: 'CDK',
  'auto-delete': 'no',
};

// Deployment mode: 'agentcore' | 'webui' | 'connect' | 'all'
// - agentcore: Deploy shared Core infra + AgentCore runtime only
// - webui:     Deploy Core infra + AgentCore runtime + Web UI
// - connect:   Deploy Core infra + Connect (no AgentCore runtime — Connect doesn't use it)
// - all:       Deploy everything
const deployMode = app.node.tryGetContext('deployMode') || 'agentcore';

console.log(`Deploy mode: ${deployMode}`);

// Stack 1: Core shared infra (ALWAYS deployed)
const coreStack = new CoreInfraStack(app, 'CallCenterTraining-Core', {
  env,
  description: 'Shared backend infrastructure - VPC, S3, KMS, DynamoDB, VPC endpoints',
  tags: commonTags,
});

// Stack 2: AgentCore runtime (deployed for agentcore/webui/all — skipped for connect)
let agentRuntimeStack: AgentRuntimeStack | undefined;
if (deployMode === 'agentcore' || deployMode === 'webui' || deployMode === 'all') {
  agentRuntimeStack = new AgentRuntimeStack(app, 'CallCenterTraining-AgentRuntime', {
    env,
    description: 'Bedrock AgentCore runtime for Web UI - agent image, IAM role, runtime',
    tags: commonTags,
    vpc: coreStack.vpc,
    bedrockEndpointSg: coreStack.bedrockEndpointSg,
    recordingsBucket: coreStack.storage.recordingsBucket,
    encryptionKey: coreStack.storage.encryptionKey,
    scenariosTable: coreStack.dynamoTables.scenariosTable,
    vpcCidr: coreStack.vpcCidr,
    createBedrockAgentCoreEndpoint: coreStack.createBedrockAgentCoreEndpoint,
  });
}

// Stack 3: Web UI (optional)
if (deployMode === 'webui' || deployMode === 'all') {
  const webUIStack = new WebUIStack(app, 'CallCenterTraining-Web', {
    env,
    description: 'Browser-based training interface - CloudFront, Cognito, Scoring Lambda',
    tags: commonTags,
    coreStack,
    agentRuntimeStack: agentRuntimeStack!,
  });
}

// Stack 4: Amazon Connect (optional)
if (deployMode === 'connect' || deployMode === 'all') {
  const connectStack = new ConnectStack(app, 'CallCenterTraining-Connect', {
    env,
    description: 'Amazon Connect training integration - Connect instance, Bridge Lambda, Admin UI',
    tags: commonTags,
    coreStack,
  });
}

cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true, reports: true }));
cdk.Aspects.of(app).add(new PrototypeSecurityNagPack({ verbose: true, reports: true }));
