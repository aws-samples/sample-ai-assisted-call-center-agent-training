/**
 * Web UI Stack - Browser-Based Training Interface
 *
 * This stack contains resources specific to the browser-based training experience:
 * - Cognito User Pool + Identity Pool (authentication)
 * - CloudFront + S3 (React frontend hosting)
 * - Scoring Lambda
 * - Frontend deployment
 *
 * Depends on: AgentCoreStack (for S3 storage, KMS key, AgentCore Runtime ARN, VPC)
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as path from 'path';
import * as fs from 'fs';
import * as custom_resources from 'aws-cdk-lib/custom-resources';
import { NagSuppressions } from 'cdk-nag';

// Import modular constructs
import { CognitoIdentityPoolConstruct } from './constructs/cognito-identity-pool';
import { ScoringLambdaConstruct } from './constructs/scoring-lambda';
import { ScreenAnalysisLambdaConstruct } from './constructs/screen-analysis-lambda';
import { AdminLambdaConstruct } from './constructs/admin-lambda';
import { TraineeLambdaConstruct } from './constructs/trainee-lambda';
import { AudioEmpathyLambdaConstruct } from './constructs/audio-empathy-lambda';
import { ApiGatewayConstruct } from './constructs/api-gateway';
import { AgentCoreStack } from './agentcore-stack';

export interface WebUIStackProps extends cdk.StackProps {
  /** Reference to the shared AgentCore stack */
  agentCoreStack: AgentCoreStack;
}

export class WebUIStack extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: WebUIStackProps) {
    super(scope, id, props);

    const { agentCoreStack } = props;

    // ========================================
    // Cognito User Pool for Authentication
    // ========================================
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${id}-users`,
      selfSignUpEnabled: false,
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

    // Suppress COG2 — MFA not desired for this training application
    NagSuppressions.addResourceSuppressions(this.userPool, [
      {
        id: 'AwsSolutions-COG2',
        reason: 'MFA is not required for this internal training application. Users authenticate via email/password.',
      },
    ]);

    // User Pool Client for frontend
    this.userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool: this.userPool,
      userPoolClientName: `${id}-client`,
      authFlows: {
        userSrp: true,
        userPassword: true,
      },
      generateSecret: false,  // Public client (browser)
      preventUserExistenceErrors: true,
    });

    // User Pool Domain for hosted UI
    const userPoolDomain = this.userPool.addDomain('UserPoolDomain', {
      cognitoDomain: {
        domainPrefix: `call-center-training-web-${this.account}`.toLowerCase(),
      },
    });

    // ========================================
    // Cognito User Groups (trainee / admin)
    // ========================================
    new cognito.CfnUserPoolGroup(this, 'TraineeGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'trainee',
      description: 'Trainees who take training calls',
    });

    // ========================================
    // Lambda for Admin Dashboard (created before Identity Pool so we can grant invoke)
    // ========================================
    const adminLambda = new AdminLambdaConstruct(this, 'AdminLambda', {
      recordingsBucket: agentCoreStack.storage.recordingsBucket,
      encryptionKey: agentCoreStack.storage.encryptionKey,
      vpc: agentCoreStack.vpc,
      scenariosTableName: agentCoreStack.dynamoTables.scenariosTable.tableName,
      scenariosTableArn: agentCoreStack.dynamoTables.scenariosTable.tableArn,
      criteriaConfigTableName: agentCoreStack.dynamoTables.criteriaConfigTable.tableName,
      criteriaConfigTableArn: agentCoreStack.dynamoTables.criteriaConfigTable.tableArn,
      sessionsTableName: agentCoreStack.dynamoTables.sessionsTable.tableName,
      sessionsTableArn: agentCoreStack.dynamoTables.sessionsTable.tableArn,
    });

    // ========================================
    // Lambda for Trainee Scenario Access (read-only)
    // ========================================
    const traineeLambda = new TraineeLambdaConstruct(this, 'TraineeLambda', {
      vpc: agentCoreStack.vpc,
      scenariosTableName: agentCoreStack.dynamoTables.scenariosTable.tableName,
      scenariosTableArn: agentCoreStack.dynamoTables.scenariosTable.tableArn,
      sessionsTableName: agentCoreStack.dynamoTables.sessionsTable.tableName,
      sessionsTableArn: agentCoreStack.dynamoTables.sessionsTable.tableArn,
    });

    // Outputs for frontend configuration
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID',
    });

    new cdk.CfnOutput(this, 'UserPoolDomain', {
      value: userPoolDomain.domainName,
      description: 'Cognito User Pool Domain',
    });

    // ========================================
    // Cognito Identity Pool (Provides AWS Credentials)
    // ========================================
    const identityPool = new CognitoIdentityPoolConstruct(this, 'IdentityPool', {
      userPool: this.userPool,
      userPoolClient: this.userPoolClient,
      agentRuntimeArn: agentCoreStack.agentRuntime.agentRuntime.attrAgentRuntimeArn,
      recordingsBucket: agentCoreStack.storage.recordingsBucket,
      encryptionKey: agentCoreStack.storage.encryptionKey,
    });

    // Admin group gets the admin IAM role via token-based role mapping
    new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'admin',
      description: 'Admins who view all trainees scoring results, transcripts, and recordings',
      roleArn: identityPool.adminAuthenticatedRole.roleArn,
    });

    // ========================================
    // Frontend - S3 + CloudFront
    // ========================================

    // KMS key for frontend assets
    const frontendEncryptionKey = new kms.Key(this, 'FrontendEncryptionKey', {
      description: 'KMS key for encrypting frontend assets',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Access logging for frontend bucket (S1 fix)
    const frontendAccessLogsKey = new kms.Key(this, 'FrontendAccessLogsEncryptionKey', {
      description: 'KMS key for encrypting frontend S3 access logs',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    frontendAccessLogsKey.addToResourcePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('logging.s3.amazonaws.com')],
      actions: ['kms:GenerateDataKey*', 'kms:Encrypt', 'kms:Decrypt', 'kms:DescribeKey'],
      resources: ['*'],
    }));

    const frontendAccessLogsBucket = new s3.Bucket(this, 'FrontendAccessLogsBucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: frontendAccessLogsKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(90),
        },
      ],
    });

    NagSuppressions.addResourceSuppressions(frontendAccessLogsBucket, [
      {
        id: 'AwsSolutions-S1',
        reason: 'This is the access logging destination bucket. Enabling access logging on it would create infinite recursion.',
      },
    ]);

    // Frontend bucket
    const frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: frontendEncryptionKey,
      enforceSSL: true,
      serverAccessLogsBucket: frontendAccessLogsBucket,
      serverAccessLogsPrefix: 'frontend-access-logs/',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // CloudFront access logging bucket (CFR4 fix)
    // CloudFront standard logging does NOT support KMS-encrypted buckets — requires SSE-S3
    const cloudFrontLogsBucket = new s3.Bucket(this, 'CloudFrontLogsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(90),
        },
      ],
    });

    NagSuppressions.addResourceSuppressions(cloudFrontLogsBucket, [
      {
        id: 'AwsSolutions-S1',
        reason: 'This is a logging destination bucket. Enabling access logging on it would create infinite recursion.',
      },
      {
        id: 'Prototype Security Nag Pack-CMK for S3 buckets',
        reason: 'CloudFront standard logging does not support KMS-encrypted S3 buckets. SSE-S3 (AES256) is the only supported encryption for CloudFront log delivery.',
      },
    ]);

    // CloudFront distribution
    this.distribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(frontendBucket, {
          originAccessControl: new cloudfront.S3OriginAccessControl(this, 'FrontendOAC', {
            originAccessControlName: `CallCenterTraining-FrontendOAC-${cdk.Stack.of(this).region}`,
            description: `Frontend OAC ${cdk.Stack.of(this).region}`,
          }),
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: 'index.html',
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

    // Suppress CFR4 — default CloudFront viewer certificate only supports TLSv1 minimum.
    // Setting a higher minimum (TLSv1.2) requires a custom domain with ACM certificate, which is
    // not configured for this training prototype.
    NagSuppressions.addResourceSuppressions(this.distribution, [
      {
        id: 'AwsSolutions-CFR4',
        reason: 'Default CloudFront viewer certificate (*.cloudfront.net) does not support setting minimum TLS version above TLSv1. A custom domain with ACM certificate would be required for TLSv1.2 enforcement.',
      },
    ]);

    // ========================================
    // S3 CORS for browser-based screen recording uploads
    // Uses AwsCustomResource (runtime API call) instead of addCorsRule()
    // to avoid circular dependency between Core and Web stacks.
    // ========================================
    new custom_resources.AwsCustomResource(this, 'RecordingsBucketCors', {
      onUpdate: {
        service: 'S3',
        action: 'putBucketCors',
        parameters: {
          Bucket: agentCoreStack.storage.recordingsBucket.bucketName,
          CORSConfiguration: {
            CORSRules: [
              {
                AllowedOrigins: [
                  `https://${this.distribution.distributionDomainName}`,
                  'http://localhost:5173',
                ],
                AllowedMethods: ['GET', 'PUT'],
                AllowedHeaders: ['*'],
                ExposeHeaders: ['ETag'],
                MaxAgeSeconds: 3600,
              },
            ],
          },
        },
        physicalResourceId: custom_resources.PhysicalResourceId.of(
          `${agentCoreStack.storage.recordingsBucket.bucketName}-cors`,
        ),
      },
      policy: custom_resources.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['s3:PutBucketCors', 's3:GetBucketCors'],
          resources: [agentCoreStack.storage.recordingsBucket.bucketArn],
        }),
      ]),
    });

    // ========================================
    // Lambda for Session Scoring
    // ========================================
    const scoringLambda = new ScoringLambdaConstruct(this, 'ScoringLambda', {
      recordingsBucket: agentCoreStack.storage.recordingsBucket,
      scoringBucket: agentCoreStack.storage.scoringBucket,
      encryptionKey: agentCoreStack.storage.encryptionKey,
      vpc: agentCoreStack.vpc,
      criteriaConfigTableName: agentCoreStack.dynamoTables.criteriaConfigTable.tableName,
      criteriaConfigTableArn: agentCoreStack.dynamoTables.criteriaConfigTable.tableArn,
      sessionsTableName: agentCoreStack.dynamoTables.sessionsTable.tableName,
      sessionsTableArn: agentCoreStack.dynamoTables.sessionsTable.tableArn,
    });

    // ========================================
    // Lambda for Audio Empathy Analysis
    // ========================================
    const audioEmpathyLambda = new AudioEmpathyLambdaConstruct(this, 'AudioEmpathyLambda', {
      recordingsBucket: agentCoreStack.storage.recordingsBucket,
      encryptionKey: agentCoreStack.storage.encryptionKey,
      vpc: agentCoreStack.vpc,
    });

    // Wire empathy Lambda to scoring Lambda so it can invoke it
    scoringLambda.function.addEnvironment(
      'AUDIO_EMPATHY_FUNCTION_NAME',
      audioEmpathyLambda.function.functionName,
    );
    audioEmpathyLambda.function.grantInvoke(scoringLambda.function);

    // ========================================
    // Lambda for Screen Capture Analysis
    // ========================================
    const screenAnalysisLambda = new ScreenAnalysisLambdaConstruct(this, 'ScreenAnalysisLambda', {
      recordingsBucket: agentCoreStack.storage.recordingsBucket,
      encryptionKey: agentCoreStack.storage.encryptionKey,
      vpc: agentCoreStack.vpc,
    });

    // ========================================
    // HTTP API Gateway (replaces direct Lambda SDK invocation)
    // ========================================
    new ApiGatewayConstruct(this, 'ApiGateway', {
      userPool: this.userPool,
      userPoolClient: this.userPoolClient,
      adminLambdaFunction: adminLambda.function,
      traineeLambdaFunction: traineeLambda.function,
      scoringLambdaFunction: scoringLambda.function,
      screenAnalysisLambdaFunction: screenAnalysisLambda.function,
      cloudFrontDomain: this.distribution.distributionDomainName,
    });

    // ========================================
    // Frontend Deployment (AUTOMATED)
    // ========================================
    const skipFrontend = this.node.tryGetContext('skipFrontend') === 'true';
    const frontendDistPath = path.join(__dirname, '../../frontend/app/dist');

    if (!skipFrontend && fs.existsSync(frontendDistPath)) {
      new s3deploy.BucketDeployment(this, 'DeployFrontend', {
        sources: [s3deploy.Source.asset(frontendDistPath)],
        destinationBucket: frontendBucket,
        distribution: this.distribution,
        distributionPaths: ['/*'],
      });
      console.log('Frontend deployment configured');
    } else if (skipFrontend) {
      console.log('Skipping frontend deployment (skipFrontend context set)');
    } else {
      console.log(`Frontend dist folder not found at ${frontendDistPath} - skipping deployment`);
    }

    // ========================================
    // CDK-Internal Custom Resource Suppressions
    // ========================================
    // BucketDeployment and autoDeleteObjects create internal Lambdas with
    // managed policies that are framework-managed and cannot be customized.
    NagSuppressions.addResourceSuppressions(
      this,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'CDK custom resource Lambdas (BucketDeployment, AutoDeleteObjects) use AWS managed policies by framework design.',
          appliesTo: [
            'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
          ],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'CDK custom resource Lambdas (BucketDeployment, AutoDeleteObjects) use wildcard resources by framework design.',
        },
        {
          id: 'AwsSolutions-L1',
          reason: 'CDK custom resource Lambda runtimes are managed by the CDK framework.',
        },
      ],
      true,
    );

    // Suppress Lambda VPC requirement for CDK custom resource Lambdas
    NagSuppressions.addResourceSuppressions(
      this,
      [
        {
          id: 'Prototype Security Nag Pack-LambdaInsideVPC',
          reason: 'CDK custom resource Lambdas (BucketDeployment, AutoDeleteObjects) run outside VPC by framework design. They only manage S3 objects and CloudFront invalidations.',
        },
      ],
      true,
    );

    // Suppress VPC endpoint warnings for services not used by this stack
    NagSuppressions.addResourceSuppressions(
      this,
      [
        {
          id: 'Prototype Security Nag Pack-VPC Endpoint for bedrock-agent-runtime',
          reason: 'This application uses bedrock-agentcore endpoint (in Core stack), not bedrock-agent-runtime.',
        },
        {
          id: 'Prototype Security Nag Pack-VPC Endpoint for batch',
          reason: 'AWS Batch is not used by this application.',
        },
      ],
      true,
    );

    // ========================================
    // Outputs
    // ========================================
    new cdk.CfnOutput(this, 'CloudFrontUrl', {
      value: `https://${this.distribution.distributionDomainName}`,
      description: 'CloudFront URL for frontend',
    });

    new cdk.CfnOutput(this, 'FrontendBucketName', {
      value: frontendBucket.bucketName,
      description: 'S3 bucket for frontend assets',
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: this.distribution.distributionId,
      description: 'CloudFront distribution ID for frontend',
    });

    // Cross-stack references for deploy script
    new cdk.CfnOutput(this, 'AgentRuntimeArn', {
      value: agentCoreStack.agentRuntime.agentRuntime.attrAgentRuntimeArn,
      description: 'ARN of the training agent runtime (from AgentCoreStack)',
    });

    new cdk.CfnOutput(this, 'RecordingsBucketName', {
      value: agentCoreStack.storage.recordingsBucket.bucketName,
      description: 'S3 bucket for session recordings (used by frontend for screen recording uploads)',
    });

    // Note: IdentityPoolId output is already created by CognitoIdentityPoolConstruct
  }
}
