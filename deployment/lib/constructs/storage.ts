/**
 * S3 Storage Construct
 * Creates S3 bucket for training session recordings with encryption, access logging, and SSL enforcement
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NagSuppressions } from 'cdk-nag';

export class S3StorageConstruct extends Construct {
  public readonly recordingsBucket: s3.Bucket;
  public readonly scoringBucket: s3.Bucket;  // Reuses recordings bucket for simplicity
  public readonly encryptionKey: kms.Key;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // Create KMS key for S3 encryption
    this.encryptionKey = new kms.Key(this, 'RecordingsEncryptionKey', {
      description: 'KMS key for encrypting training session recordings',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // KMS key for access log encryption (all S3 buckets must use KMS)
    const accessLogsEncryptionKey = new kms.Key(this, 'AccessLogsEncryptionKey', {
      description: 'KMS key for encrypting S3 access logs',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Grant S3 logging service permission to use the KMS key
    accessLogsEncryptionKey.addToResourcePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('logging.s3.amazonaws.com')],
      actions: ['kms:GenerateDataKey*', 'kms:Encrypt', 'kms:Decrypt', 'kms:DescribeKey'],
      resources: ['*'],
    }));

    // Access logging bucket (cannot itself have access logging — would be recursive)
    const accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: accessLogsEncryptionKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(90),
        },
      ],
    });

    NagSuppressions.addResourceSuppressions(accessLogsBucket, [
      {
        id: 'AwsSolutions-S1',
        reason: 'This is the access logging destination bucket. Enabling access logging on it would create infinite recursion.',
      },
    ]);

    // Create S3 bucket for recordings and evaluations
    this.recordingsBucket = new s3.Bucket(this, 'RecordingsBucket', {
      bucketName: undefined,  // Auto-generate name
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: 'recordings-access-logs/',
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          // Transition recordings to Glacier after 90 days
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
          // Delete recordings after 365 days
          expiration: cdk.Duration.days(365),
        },
      ],
    });

    // Scoring results are stored in the same bucket (under scoring/ prefix) for simplicity
    this.scoringBucket = this.recordingsBucket;

    // Output bucket name
    new cdk.CfnOutput(scope, 'RecordingsBucketName', {
      value: this.recordingsBucket.bucketName,
      description: 'S3 bucket for training session recordings',
    });
  }
}
