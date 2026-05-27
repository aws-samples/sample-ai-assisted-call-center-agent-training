import * as cdk from 'aws-cdk-lib';
import { IConstruct } from 'constructs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';

/**
 * Sets KmsKeyId on every CfnLogGroup in scope that doesn't already have one.
 * The key must already grant the CloudWatch Logs service principal the
 * Encrypt/Decrypt/ReEncrypt/GenerateDataKey/Describe actions
 * (see core-infra-stack.ts FlowLogsEncryptionKey for the canonical pattern).
 */
export class EncryptLogsAspect implements cdk.IAspect {
  constructor(private readonly key: kms.IKey) {}

  public visit(node: IConstruct): void {
    if (node instanceof logs.CfnLogGroup) {
      const resolved = cdk.Stack.of(node).resolve(node.kmsKeyId);
      if (resolved === undefined || resolved === null) {
        node.kmsKeyId = this.key.keyArn;
      }
    }
  }
}
