/**
 * Connect Phone Number Construct
 *
 * Claims a toll-free US phone number and associates it with the Connect instance.
 * RemovalPolicy is RETAIN: toll-free numbers have a 30-day release quarantine,
 * so accidental destroy/recreate can leave the account locked out of the number.
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as connect from 'aws-cdk-lib/aws-connect';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as path from 'path';
import { NagSuppressions } from 'cdk-nag';

export interface ConnectPhoneNumberProps {
  instanceArn: string;
  instanceId: string;
  /** Country code, default US */
  countryCode?: string;
  /** Phone number type, default TOLL_FREE */
  type?: string;
  description?: string;
  /** If set, associates the phone number with this inbound contact flow ID. */
  inboundContactFlowId?: string;
  /** If true (and no explicit flow ID provided), looks up the built-in
   *  "Sample inbound flow (first contact experience)" by name and associates it
   *  so that dialing the number routes to CCP via the default sample queue. */
  useDefaultSampleInboundFlow?: boolean;
}

export class ConnectPhoneNumberConstruct extends Construct {
  public readonly phoneNumber: string;
  public readonly phoneNumberArn: string;

  constructor(scope: Construct, id: string, props: ConnectPhoneNumberProps) {
    super(scope, id);

    const number = new connect.CfnPhoneNumber(this, 'Number', {
      targetArn: props.instanceArn,
      countryCode: props.countryCode ?? 'US',
      type: props.type ?? 'TOLL_FREE',
      description: props.description ?? 'Call center training outbound number',
    });
    number.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    this.phoneNumber = number.attrAddress;
    this.phoneNumberArn = number.attrPhoneNumberArn;

    // Associate the phone number with an inbound contact flow so dialing the
    // number routes calls through the flow to a queue/CCP. Connect doesn't
    // expose this via AWS::Connect::PhoneNumber.
    const phoneNumberId = cdk.Fn.select(1, cdk.Fn.split('phone-number/', number.attrPhoneNumberArn));

    if (props.inboundContactFlowId) {
      const associate = new cr.AwsCustomResource(this, 'AssociateFlow', {
        onCreate: {
          service: 'Connect',
          action: 'associatePhoneNumberContactFlow',
          parameters: {
            PhoneNumberId: phoneNumberId,
            InstanceId: props.instanceId,
            ContactFlowId: props.inboundContactFlowId,
          },
          physicalResourceId: cr.PhysicalResourceId.of(`${phoneNumberId}-flow-assoc`),
        },
        onUpdate: {
          service: 'Connect',
          action: 'associatePhoneNumberContactFlow',
          parameters: {
            PhoneNumberId: phoneNumberId,
            InstanceId: props.instanceId,
            ContactFlowId: props.inboundContactFlowId,
          },
          physicalResourceId: cr.PhysicalResourceId.of(`${phoneNumberId}-flow-assoc`),
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['connect:AssociatePhoneNumberContactFlow'],
            resources: [
              number.attrPhoneNumberArn,
              `${props.instanceArn}/contact-flow/*`,
            ],
          }),
        ]),
      });
      associate.node.addDependency(number);
    } else if (props.useDefaultSampleInboundFlow) {
      // Lambda-backed CR: lists contact flows, finds "Sample inbound flow
      // (first contact experience)" by name, and associates it with the phone
      // number. Lambda-backed so we can filter server-side and avoid CFN's
      // 4KB custom-resource response limit.
      const stack = cdk.Stack.of(this);
      const lambdaDir = path.join(__dirname, '../../../src/lambda/connect_phone_flow_setup');

      const crLogGroup = new logs.LogGroup(this, 'PhoneFlowCRLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

      const crRole = new iam.Role(this, 'PhoneFlowCRRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        inlinePolicies: {
          CloudWatchLogs: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['logs:CreateLogGroup'],
                resources: [crLogGroup.logGroupArn],
              }),
              new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
                resources: [`${crLogGroup.logGroupArn}:*`],
              }),
            ],
          }),
          ConnectFlowAssociation: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                  'connect:ListContactFlows',
                  'connect:AssociatePhoneNumberContactFlow',
                  'connect:DisassociatePhoneNumberContactFlow',
                ],
                resources: [
                  props.instanceArn,
                  `${props.instanceArn}/contact-flow/*`,
                  number.attrPhoneNumberArn,
                ],
              }),
            ],
          }),
        },
      });

      const crFn = new lambda.Function(this, 'PhoneFlowCRFn', {
        runtime: lambda.Runtime.PYTHON_3_13,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(lambdaDir),
        role: crRole,
        timeout: cdk.Duration.minutes(2),
        memorySize: 256,
        logGroup: crLogGroup,
        description: 'Associates a Connect phone number with the built-in sample inbound flow',
      });

      const crProvider = new cr.Provider(this, 'PhoneFlowProvider', {
        onEventHandler: crFn,
      });

      const associateFlow = new cdk.CustomResource(this, 'AssociateSampleFlow', {
        serviceToken: crProvider.serviceToken,
        properties: {
          InstanceId: props.instanceId,
          PhoneNumberId: phoneNumberId,
          FlowName: 'Sample queue customer',
        },
      });
      associateFlow.node.addDependency(number);

      NagSuppressions.addResourceSuppressions(
        crRole,
        [
          {
            id: 'AwsSolutions-IAM5',
            reason: 'Contact flow IDs are dynamic. Wildcard scoped to the specific Connect instance sub-resources.',
            appliesTo: [{ regex: '/Resource::<Instance.*\\.Arn>\\/contact-flow\\/\\*$/g' } as any],
          },
          {
            id: 'AwsSolutions-IAM5',
            reason: 'Log streams within the CR log group are dynamic.',
            appliesTo: [{ regex: '/Resource::.*PhoneFlowCRLogs.*\\.Arn>:\\*$/g' } as any],
          },
        ],
        true,
      );
    }

    new cdk.CfnOutput(scope, 'ConnectPhoneNumber', {
      value: number.attrAddress,
      description: 'Claimed toll-free phone number (destination for outbound training calls)',
    });
  }
}
