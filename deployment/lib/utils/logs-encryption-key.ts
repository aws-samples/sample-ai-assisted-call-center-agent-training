import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';

/**
 * Creates a KMS key suitable for encrypting CloudWatch Logs in the current stack's
 * region. Grants the regional CloudWatch Logs service principal the actions it
 * needs to write log events. Pattern matches the FlowLogsEncryptionKey block in
 * core-infra-stack.ts.
 */
export function createLogsEncryptionKey(
  scope: Construct,
  id: string,
  description: string,
  removalPolicy: cdk.RemovalPolicy = cdk.RemovalPolicy.RETAIN,
): kms.Key {
  const stack = cdk.Stack.of(scope);
  const key = new kms.Key(scope, id, {
    description,
    enableKeyRotation: true,
    removalPolicy,
  });
  key.addToResourcePolicy(new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    principals: [new iam.ServicePrincipal(`logs.${stack.region}.amazonaws.com`)],
    actions: [
      'kms:Encrypt*',
      'kms:Decrypt*',
      'kms:ReEncrypt*',
      'kms:GenerateDataKey*',
      'kms:Describe*',
    ],
    resources: ['*'],
    conditions: {
      ArnLike: {
        'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${stack.region}:${stack.account}:log-group:*`,
      },
    },
  }));
  return key;
}
