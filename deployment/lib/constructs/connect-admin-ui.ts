/**
 * Connect Admin UI Construct
 *
 * Creates hosting infrastructure for the Connect admin UI:
 * - S3 bucket for static assets
 * - CloudFront distribution
 * - Cognito User Pool for admin authentication (JWT via API Gateway)
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';
import * as fs from 'fs';
import { NagSuppressions } from 'cdk-nag';

export interface ConnectAdminUIProps {
  /** Connect instance ARN */
  connectInstanceArn: string;
}

export class ConnectAdminUIConstruct extends Construct {
  public readonly distribution: cloudfront.Distribution;
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: ConnectAdminUIProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    // ========================================
    // Cognito User Pool for Admin Authentication
    // ========================================
    this.userPool = new cognito.UserPool(this, 'AdminUserPool', {
      userPoolName: 'connect-training-admin-users',
      selfSignUpEnabled: false,  // Admin-only, no self-signup
      signInAliases: {
        email: true,
        username: false,
      },
      autoVerify: {
        email: true,
      },
      standardAttributes: {
        email: {
          required: true,
          mutable: false,
        },
        fullname: {
          required: true,
          mutable: true,
        },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      featurePlan: cognito.FeaturePlan.PLUS,
      standardThreatProtectionMode: cognito.StandardThreatProtectionMode.FULL_FUNCTION,
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.userPoolClient = new cognito.UserPoolClient(this, 'AdminUserPoolClient', {
      userPool: this.userPool,
      userPoolClientName: 'connect-training-admin-client',
      authFlows: {
        userSrp: true,
        userPassword: true,
      },
      generateSecret: false,
      preventUserExistenceErrors: true,
    });

    const userPoolDomain = this.userPool.addDomain('AdminUserPoolDomain', {
      cognitoDomain: {
        domainPrefix: `call-center-training-admin-${stack.account}`.toLowerCase(),
      },
    });

    // ========================================
    // Frontend Hosting - S3 + CloudFront
    // ========================================
    const adminEncryptionKey = new kms.Key(this, 'AdminFrontendEncryptionKey', {
      description: 'KMS key for encrypting admin frontend assets',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Log bucket for S3 server access logs
    const logBucket = new s3.Bucket(this, 'AdminAccessLogBucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: adminEncryptionKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const adminBucket = new s3.Bucket(this, 'AdminFrontendBucket', {
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: adminEncryptionKey,
      enforceSSL: true,
      serverAccessLogsBucket: logBucket,
      serverAccessLogsPrefix: 's3-access-logs/',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // CloudFront access logging bucket (CFR3 fix)
    // CloudFront standard logging does NOT support KMS-encrypted buckets — requires SSE-S3
    const cloudFrontLogsBucket = new s3.Bucket(this, 'AdminCloudFrontLogsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(90),
        },
      ],
    });

    this.distribution = new cloudfront.Distribution(this, 'AdminDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(adminBucket, {
          originAccessControl: new cloudfront.S3OriginAccessControl(this, 'AdminOAC', {
            originAccessControlName: `CallCenterTraining-AdminOAC-${cdk.Stack.of(this).region}`,
            description: `Admin OAC ${cdk.Stack.of(this).region}`,
          }),
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: 'index.html',
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      enableLogging: true,
      logBucket: cloudFrontLogsBucket,
      logFilePrefix: 'cloudfront-logs/',
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],
    });

    // Deploy admin UI if dist exists
    const skipAdminUI = scope.node.tryGetContext('skipAdminUI') === 'true';
    const adminDistPath = path.join(__dirname, '../../../connect-admin/app/dist');

    if (!skipAdminUI && fs.existsSync(adminDistPath)) {
      new s3deploy.BucketDeployment(this, 'DeployAdminUI', {
        sources: [s3deploy.Source.asset(adminDistPath)],
        destinationBucket: adminBucket,
        distribution: this.distribution,
        distributionPaths: ['/*'],
      });
      console.log('Connect Admin UI deployment configured');
    } else if (skipAdminUI) {
      console.log('Skipping admin UI deployment (skipAdminUI context set)');
    } else {
      console.log(`Admin UI dist folder not found at ${adminDistPath} - skipping deployment`);
    }

    // ========================================
    // Nag Suppressions
    // ========================================

    // Log bucket doesn't need its own access logs (would create infinite recursion)
    NagSuppressions.addResourceSuppressions(
      logBucket,
      [
        {
          id: 'AwsSolutions-S1',
          reason: 'This IS the access log bucket. Enabling access logs on the log bucket would create an infinite loop.',
        },
      ],
    );

    // CloudFront logs bucket suppressions
    NagSuppressions.addResourceSuppressions(cloudFrontLogsBucket, [
      {
        id: 'AwsSolutions-S1',
        reason: 'This is the CloudFront logging destination bucket. Enabling access logging on it would create infinite recursion.',
      },
      {
        id: 'Prototype Security Nag Pack-CMK for S3 buckets',
        reason: 'CloudFront standard logging does not support KMS-encrypted S3 buckets. SSE-S3 (AES256) is the only supported encryption for CloudFront log delivery.',
      },
    ]);

    // CFR4: Default CloudFront viewer certificate (*.cloudfront.net) enforces TLSv1 as minimum
    // regardless of MinimumProtocolVersion setting. A custom domain with ACM certificate is required
    // to enforce TLSv1.2+ but is not configured for this internal admin tool.
    NagSuppressions.addResourceSuppressions(
      this.distribution,
      [
        {
          id: 'AwsSolutions-CFR4',
          reason: 'Default CloudFront certificate (*.cloudfront.net) enforces TLSv1 minimum regardless of MinimumProtocolVersion. Custom domain with ACM certificate required to fix, which is not configured for this internal admin UI.',
        },
      ],
    );

    // ========================================
    // Outputs
    // ========================================
    new cdk.CfnOutput(scope, 'AdminUIUrl', {
      value: `https://${this.distribution.distributionDomainName}`,
      description: 'Admin UI CloudFront URL',
    });

    new cdk.CfnOutput(scope, 'AdminUserPoolId', {
      value: this.userPool.userPoolId,
      description: 'Admin Cognito User Pool ID',
    });

    new cdk.CfnOutput(scope, 'AdminUserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      description: 'Admin Cognito User Pool Client ID',
    });

    new cdk.CfnOutput(scope, 'AdminBucketName', {
      value: adminBucket.bucketName,
      description: 'Admin UI S3 bucket',
    });

    new cdk.CfnOutput(scope, 'AdminDistributionId', {
      value: this.distribution.distributionId,
      description: 'Admin UI CloudFront distribution ID',
    });
  }
}
