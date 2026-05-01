/**
 * Connect Lambda Integration Construct
 *
 * Associates a Lambda function with a Connect instance (registers it in the
 * Console's "AWS Lambda" section) and grants Connect permission to invoke it.
 */

import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as connect from 'aws-cdk-lib/aws-connect';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';

export interface ConnectLambdaIntegrationProps {
  instanceArn: string;
  fn: lambda.IFunction;
}

export class ConnectLambdaIntegrationConstruct extends Construct {
  public readonly integrationAssociationId: string;

  constructor(scope: Construct, id: string, props: ConnectLambdaIntegrationProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    const integration = new connect.CfnIntegrationAssociation(this, 'Association', {
      instanceId: props.instanceArn,
      integrationType: 'LAMBDA_FUNCTION',
      integrationArn: props.fn.functionArn,
    });
    this.integrationAssociationId = integration.attrIntegrationAssociationId;

    props.fn.addPermission('ConnectInvoke', {
      principal: new iam.ServicePrincipal('connect.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceAccount: stack.account,
      sourceArn: props.instanceArn,
    });
  }
}
