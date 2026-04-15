#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AgentCoreStack } from '../lib/agentcore-stack';
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
};

// Deployment mode: 'agentcore' | 'webui' | 'connect' | 'all'
// - agentcore: Deploy only the shared AgentCore backend
// - webui: Deploy AgentCore + Web UI stacks
// - connect: Deploy AgentCore + Connect stacks
// - all: Deploy AgentCore + Web UI + Connect stacks
const deployMode = app.node.tryGetContext('deployMode') || 'agentcore';

console.log(`Deploy mode: ${deployMode}`);

// Stack 1: AgentCore (ALWAYS deployed)
const agentCoreStack = new AgentCoreStack(app, 'CallCenterTraining-Core', {
  env,
  description: 'Shared backend infrastructure - AgentCore Runtime, VPC, S3, IAM',
  tags: commonTags,
});

// Stack 2: Web UI (optional)
if (deployMode === 'webui' || deployMode === 'all') {
  const webUIStack = new WebUIStack(app, 'CallCenterTraining-Web', {
    env,
    description: 'Browser-based training interface - CloudFront, Cognito, Scoring Lambda',
    tags: commonTags,
    agentCoreStack,
  });
}

// Stack 3: Amazon Connect (optional)
if (deployMode === 'connect' || deployMode === 'all') {
  const connectStack = new ConnectStack(app, 'CallCenterTraining-Connect', {
    env,
    description: 'Amazon Connect training integration - Connect instance, Bridge Lambda, Admin UI',
    tags: commonTags,
    agentCoreStack,
  });
}

cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true, reports: true }));
cdk.Aspects.of(app).add(new PrototypeSecurityNagPack({ verbose: true, reports: true }));
