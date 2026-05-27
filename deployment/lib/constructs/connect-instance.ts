/**
 * Connect Instance Construct
 *
 * Creates an Amazon Connect instance with:
 * - KMS-encrypted S3 bucket for call recordings, Contact Lens analysis, and chat transcripts
 * - InstanceStorageConfig associations for CALL_RECORDINGS, CONTACT_LENS, CHAT_TRANSCRIPTS
 * - Outbound + inbound calling, Contact Lens, early media, custom TTS voices enabled
 *
 * If `existingInstanceArn` is provided, the construct wraps an externally-managed
 * instance and skips resource creation — used for migration from manually-created instances.
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as connect from 'aws-cdk-lib/aws-connect';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { NagSuppressions } from 'cdk-nag';

export interface ConnectInstanceProps {
  /** If set, skip creating a new instance and use this ARN. For migration from manual setup. */
  existingInstanceArn?: string;
  /** Externally-managed recordings bucket name — required when `existingInstanceArn` is set */
  existingRecordingsBucket?: string;
  /** Instance alias prefix (a stack-id suffix is appended for uniqueness) */
  instanceAlias?: string;
}

export class ConnectInstanceConstruct extends Construct {
  public readonly instanceArn: string;
  public readonly instanceId: string;
  public readonly recordingsBucketName: string;
  public readonly recordingsBucket?: s3.Bucket;
  public readonly encryptionKey?: kms.Key;

  constructor(scope: Construct, id: string, props: ConnectInstanceProps = {}) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    if (props.existingInstanceArn) {
      if (!props.existingRecordingsBucket) {
        throw new Error('existingRecordingsBucket is required when existingInstanceArn is set');
      }
      this.instanceArn = props.existingInstanceArn;
      this.instanceId = cdk.Fn.select(1, cdk.Fn.split('instance/', props.existingInstanceArn));
      this.recordingsBucketName = props.existingRecordingsBucket;
      return;
    }

    // KMS key for recordings + Contact Lens
    this.encryptionKey = new kms.Key(this, 'RecordingsKey', {
      description: 'KMS key for Connect call recordings and Contact Lens analysis',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Let Connect service encrypt/decrypt recordings + analysis under this key
    this.encryptionKey.addToResourcePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('connect.amazonaws.com')],
      actions: ['kms:GenerateDataKey*', 'kms:Encrypt', 'kms:Decrypt', 'kms:DescribeKey'],
      resources: ['*'],
    }));

    // Access log bucket for the recordings bucket
    const accessLogsKey = new kms.Key(this, 'AccessLogsKey', {
      description: 'KMS key for Connect recordings bucket access logs',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    accessLogsKey.addToResourcePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('logging.s3.amazonaws.com')],
      actions: ['kms:GenerateDataKey*', 'kms:Encrypt', 'kms:Decrypt', 'kms:DescribeKey'],
      resources: ['*'],
    }));

    const accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: accessLogsKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
    });
    NagSuppressions.addResourceSuppressions(accessLogsBucket, [
      { id: 'AwsSolutions-S1', reason: 'Access log destination bucket cannot log to itself.' },
    ]);

    // Recordings bucket for Connect-side artifacts (raw recordings, Contact Lens, chat transcripts)
    this.recordingsBucket = new s3.Bucket(this, 'RecordingsBucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: 'connect-recordings-access/',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      eventBridgeEnabled: true,
      lifecycleRules: [
        {
          transitions: [
            { storageClass: s3.StorageClass.GLACIER, transitionAfter: cdk.Duration.days(90) },
          ],
          expiration: cdk.Duration.days(365),
        },
      ],
    });

    this.recordingsBucketName = this.recordingsBucket.bucketName;

    // Allow Connect service to write call recordings / Contact Lens / chat transcripts
    this.recordingsBucket.addToResourcePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('connect.amazonaws.com')],
      actions: ['s3:PutObject', 's3:PutObjectAcl', 's3:GetBucketLocation', 's3:GetObject'],
      resources: [this.recordingsBucket.bucketArn, `${this.recordingsBucket.bucketArn}/*`],
    }));

    // Unique alias built from stack ID hash
    const uniqueSuffix = cdk.Fn.select(
      4,
      cdk.Fn.split('-', cdk.Fn.select(2, cdk.Fn.split('/', stack.stackId))),
    );
    const aliasPrefix = props.instanceAlias ?? 'call-center-training';
    const alias = cdk.Fn.join('-', [aliasPrefix, uniqueSuffix]);

    const instance = new connect.CfnInstance(this, 'Instance', {
      instanceAlias: alias,
      identityManagementType: 'CONNECT_MANAGED',
      attributes: {
        inboundCalls: true,
        outboundCalls: true,
        contactflowLogs: true,
        contactLens: true,
        earlyMedia: true,
        useCustomTtsVoices: true,
      },
    });

    this.instanceArn = instance.attrArn;
    this.instanceId = instance.attrId;

    // Storage associations — Contact Lens analysis lands under `Analysis/` prefix
    const callRecordingsStorage = new connect.CfnInstanceStorageConfig(this, 'CallRecordingsStorage', {
      instanceArn: instance.attrArn,
      resourceType: 'CALL_RECORDINGS',
      storageType: 'S3',
      s3Config: {
        bucketName: this.recordingsBucket.bucketName,
        bucketPrefix: 'connect/recordings',
        encryptionConfig: {
          encryptionType: 'KMS',
          keyId: this.encryptionKey.keyArn,
        },
      },
    });
    callRecordingsStorage.addDependency(instance);

    const contactLensStorage = new connect.CfnInstanceStorageConfig(this, 'ContactLensStorage', {
      instanceArn: instance.attrArn,
      resourceType: 'SCHEDULED_REPORTS',
      storageType: 'S3',
      s3Config: {
        bucketName: this.recordingsBucket.bucketName,
        bucketPrefix: 'connect/reports',
        encryptionConfig: {
          encryptionType: 'KMS',
          keyId: this.encryptionKey.keyArn,
        },
      },
    });
    contactLensStorage.addDependency(instance);

    const chatTranscriptsStorage = new connect.CfnInstanceStorageConfig(this, 'ChatTranscriptsStorage', {
      instanceArn: instance.attrArn,
      resourceType: 'CHAT_TRANSCRIPTS',
      storageType: 'S3',
      s3Config: {
        bucketName: this.recordingsBucket.bucketName,
        bucketPrefix: 'connect/chat',
        encryptionConfig: {
          encryptionType: 'KMS',
          keyId: this.encryptionKey.keyArn,
        },
      },
    });
    chatTranscriptsStorage.addDependency(instance);

    // Enable Lex Bot Management (required for configuring Lex bots in the Connect console).
    // Not exposed via CfnInstance.Attributes; toggle via connect:UpdateInstanceAttribute.
    const botManagementCr = new cr.AwsCustomResource(this, 'EnableBotManagement', {
      onCreate: {
        service: 'Connect',
        action: 'updateInstanceAttribute',
        parameters: {
          InstanceId: instance.attrId,
          AttributeType: 'BOT_MANAGEMENT',
          Value: 'true',
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${instance.attrId}-bot-management`),
      },
      onUpdate: {
        service: 'Connect',
        action: 'updateInstanceAttribute',
        parameters: {
          InstanceId: instance.attrId,
          AttributeType: 'BOT_MANAGEMENT',
          Value: 'true',
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${instance.attrId}-bot-management`),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['connect:UpdateInstanceAttribute'],
          resources: [instance.attrArn],
        }),
        // BOT_MANAGEMENT=true causes Connect to attach Lex permissions to its
        // service-linked role AWSServiceRoleForAmazonConnect_*. The caller must
        // be allowed to modify that role's inline policy.
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['iam:PutRolePolicy', 'iam:DeleteRolePolicy'],
          resources: [
            `arn:aws:iam::${stack.account}:role/aws-service-role/connect.amazonaws.com/AWSServiceRoleForAmazonConnect_*`,
          ],
        }),
      ]),
    });
    botManagementCr.node.addDependency(instance);

    NagSuppressions.addResourceSuppressions(
      botManagementCr,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Connect creates its service-linked role with a suffix per instance; wildcard on AWSServiceRoleForAmazonConnect_* is required and scoped to the service-role path.',
          appliesTo: [`Resource::arn:aws:iam::${stack.account}:role/aws-service-role/connect.amazonaws.com/AWSServiceRoleForAmazonConnect_*`],
        },
      ],
      true,
    );

    new cdk.CfnOutput(scope, 'ConnectInstanceAlias', {
      value: alias,
      description: 'Amazon Connect instance alias (CCP URL: https://<alias>.my.connect.aws/ccp-v2/)',
    });

    new cdk.CfnOutput(scope, 'ConnectRecordingsBucket', {
      value: this.recordingsBucket.bucketName,
      description: 'S3 bucket for Connect call recordings and Contact Lens analysis',
    });
  }
}
