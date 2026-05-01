/**
 * Connect Contact Flow Construct
 *
 * Reads a tokenized contact flow JSON file from disk and creates a
 * CfnContactFlow with ARN placeholders substituted at deploy time.
 *
 * Template placeholders (in JSON file):
 *   ${WisdomAssistantArn}     — e.g., arn:aws:wisdom:...:assistant/<id>
 *   ${AIAgentVersionArn}      — published AI Agent version ARN
 *   ${LambdaArn}              — Session Setup Lambda ARN
 *   ${LexBotAliasArn}         — Lex V2 bot alias ARN
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as connect from 'aws-cdk-lib/aws-connect';
import * as fs from 'fs';

export interface ConnectContactFlowProps {
  instanceArn: string;
  name: string;
  description?: string;
  /** One of Connect's flow types, e.g. CONTACT_FLOW, CONTACT_FLOW_CHAT */
  type?: string;
  /** Absolute path to the tokenized JSON file */
  flowJsonPath: string;
  /** ARN substitutions */
  substitutions: {
    WisdomAssistantArn: string;
    AIAgentVersionArn: string;
    LambdaArn: string;
    LexBotAliasArn?: string;
  };
}

export class ConnectContactFlowConstruct extends Construct {
  public readonly contactFlow: connect.CfnContactFlow;
  public readonly contactFlowId: string;
  public readonly contactFlowArn: string;

  constructor(scope: Construct, id: string, props: ConnectContactFlowProps) {
    super(scope, id);

    let raw = fs.readFileSync(props.flowJsonPath, 'utf-8');

    // Keep `Metadata` (it holds block positions + console-dropdown hints), but
    // strip the volatile `hash` and `status` fields that can cause import errors.
    const parsed = JSON.parse(raw);
    if (parsed.Metadata) {
      delete parsed.Metadata.hash;
      delete parsed.Metadata.status;
    }
    raw = JSON.stringify(parsed);

    const content = cdk.Fn.sub(raw, {
      WisdomAssistantArn: props.substitutions.WisdomAssistantArn,
      AIAgentVersionArn: props.substitutions.AIAgentVersionArn,
      LambdaArn: props.substitutions.LambdaArn,
      LexBotAliasArn: props.substitutions.LexBotAliasArn ?? '',
    });

    this.contactFlow = new connect.CfnContactFlow(this, 'Flow', {
      instanceArn: props.instanceArn,
      name: props.name,
      description: props.description,
      type: props.type ?? 'CONTACT_FLOW',
      content,
    });

    this.contactFlowArn = this.contactFlow.attrContactFlowArn;
    this.contactFlowId = cdk.Fn.select(3, cdk.Fn.split('/', this.contactFlow.attrContactFlowArn));
  }
}
