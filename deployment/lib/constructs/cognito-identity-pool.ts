/**
 * Cognito Identity Pool Construct
 * Provides temporary AWS credentials to authenticated users.
 * Used for S3 direct uploads (screen recordings) and AgentCore WebSocket presigning.
 * API calls are handled by API Gateway with JWT auth (no Lambda invoke permissions needed).
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import { NagSuppressions } from 'cdk-nag';

export interface CognitoIdentityPoolProps {
  userPool: cognito.IUserPool;
  userPoolClient: cognito.IUserPoolClient;
  agentRuntimeArn: string;
  /** S3 bucket for session recordings (used for screen recording uploads) */
  recordingsBucket: s3.IBucket;
  /** KMS encryption key for the recordings bucket */
  encryptionKey: kms.IKey;
}

export class CognitoIdentityPoolConstruct extends Construct {
  public readonly identityPool: cognito.CfnIdentityPool;
  public readonly authenticatedRole: iam.Role;
  public readonly adminAuthenticatedRole: iam.Role;

  constructor(scope: Construct, id: string, props: CognitoIdentityPoolProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    // Create Identity Pool
    this.identityPool = new cognito.CfnIdentityPool(this, 'IdentityPool', {
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [
        {
          clientId: props.userPoolClient.userPoolClientId,
          providerName: props.userPool.userPoolProviderName,
        },
      ],
    });

    // Shared trust policy for both roles
    const cognitoFederatedPrincipal = new iam.FederatedPrincipal(
      'cognito-identity.amazonaws.com',
      {
        StringEquals: {
          'cognito-identity.amazonaws.com:aud': this.identityPool.ref,
        },
        'ForAnyValue:StringLike': {
          'cognito-identity.amazonaws.com:amr': 'authenticated',
        },
      },
      'sts:AssumeRoleWithWebIdentity'
    );

    // Shared inline policies for all authenticated users (trainee + admin)
    // Only includes permissions that require AWS credentials (S3 uploads, AgentCore WebSocket).
    // Lambda API calls now go through API Gateway with JWT auth.
    const sharedInlinePolicies: Record<string, iam.PolicyDocument> = {
      BedrockAgentCoreAccess: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
              'bedrock-agentcore:InvokeAgentRuntime',
              'bedrock-agentcore:InvokeAgentRuntimeWithWebSocketStream',
            ],
            resources: [
              props.agentRuntimeArn,
              `${props.agentRuntimeArn}/*`,
            ],
          }),
        ],
      }),
      S3ScreenRecordingUpload: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['s3:PutObject'],
            resources: [
              `${props.recordingsBucket.bucketArn}/users/*`,
            ],
          }),
        ],
      }),
      KmsEncryptForUpload: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['kms:GenerateDataKey', 'kms:Encrypt'],
            resources: [props.encryptionKey.keyArn],
          }),
        ],
      }),
    };

    // Default authenticated role (trainees)
    this.authenticatedRole = new iam.Role(this, 'AuthenticatedRole', {
      assumedBy: cognitoFederatedPrincipal,
      description: 'IAM role for authenticated Cognito users (S3 uploads + AgentCore WebSocket)',
      inlinePolicies: { ...sharedInlinePolicies },
    });

    // Admin authenticated role — same permissions as trainee for AWS credential-based operations.
    // Admin-vs-trainee API authorization is now handled by API Gateway JWT + Lambda handler checks.
    this.adminAuthenticatedRole = new iam.Role(this, 'AdminAuthenticatedRole', {
      assumedBy: cognitoFederatedPrincipal,
      description: 'IAM role for admin Cognito users (S3 uploads + AgentCore WebSocket)',
      inlinePolicies: { ...sharedInlinePolicies },
    });

    // ========================================
    // IAM5 Suppressions
    // ========================================
    const suppressSharedPolicies = (role: iam.Role) => {
      NagSuppressions.addResourceSuppressions(
        role,
        [
          {
            id: 'AwsSolutions-IAM5',
            reason:
              'AgentCore runtime endpoint invocation requires /* suffix on runtime ARN (subresource for endpoints). ' +
              'Resource is scoped to a single specific runtime ARN.',
            appliesTo: [`Resource::${props.agentRuntimeArn}/*`],
          },
          {
            id: 'AwsSolutions-IAM5',
            reason:
              'S3 PutObject permission is scoped to users/* prefix only. ' +
              'Wildcard is required because session IDs and user IDs are dynamic.',
            appliesTo: [
              {
                regex: '/Resource::.*\\.Arn>\\/users\\/\\*$/g',
              } as any,
            ],
          },
        ],
        true,
      );
    };

    suppressSharedPolicies(this.authenticatedRole);
    suppressSharedPolicies(this.adminAuthenticatedRole);

    // Attach roles to Identity Pool with token-based role mapping.
    // When a user's Cognito group has a roleArn, the Identity Pool
    // issues credentials for that group's role instead of the default.
    new cognito.CfnIdentityPoolRoleAttachment(this, 'IdentityPoolRoleAttachment', {
      identityPoolId: this.identityPool.ref,
      roles: {
        authenticated: this.authenticatedRole.roleArn,
      },
      roleMappings: {
        cognitoProvider: {
          type: 'Token',
          ambiguousRoleResolution: 'AuthenticatedRole',
          identityProvider: `cognito-idp.${stack.region}.amazonaws.com/${props.userPool.userPoolId}:${props.userPoolClient.userPoolClientId}`,
        },
      },
    });

    // Outputs
    new cdk.CfnOutput(scope, 'IdentityPoolId', {
      value: this.identityPool.ref,
      description: 'Cognito Identity Pool ID',
    });
  }
}
