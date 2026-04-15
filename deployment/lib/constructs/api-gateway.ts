/**
 * HTTP API Gateway Construct
 *
 * Single API Gateway (v2 HTTP API) that fronts all web-facing Lambda functions.
 * Uses a Cognito JWT authorizer for authentication. Admin-vs-trainee authorization
 * is enforced inside the admin Lambda handler by inspecting the cognito:groups claim.
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';

export interface ApiGatewayConstructProps {
  userPool: cognito.IUserPool;
  userPoolClient: cognito.IUserPoolClient;
  adminLambdaFunction: lambda.IFunction;
  traineeLambdaFunction: lambda.IFunction;
  scoringLambdaFunction: lambda.IFunction;
  screenAnalysisLambdaFunction: lambda.IFunction;
  cloudFrontDomain: string;
}

export class ApiGatewayConstruct extends Construct {
  public readonly httpApi: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: ApiGatewayConstructProps) {
    super(scope, id);

    // JWT authorizer using Cognito User Pool
    const authorizer = new HttpUserPoolAuthorizer('CognitoAuthorizer', props.userPool, {
      userPoolClients: [props.userPoolClient],
      identitySource: ['$request.header.Authorization'],
    });

    // HTTP API with CORS and default JWT authorizer
    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: 'CallCenterTrainingApi',
      corsPreflight: {
        allowOrigins: [
          `https://${props.cloudFrontDomain}`,
          'http://localhost:5173',
        ],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['Authorization', 'Content-Type'],
        maxAge: cdk.Duration.hours(1),
      },
      defaultAuthorizer: authorizer,
    });

    // Access logging
    const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const defaultStage = this.httpApi.defaultStage?.node.defaultChild as apigwv2.CfnStage;
    defaultStage.accessLogSettings = {
      destinationArn: accessLogGroup.logGroupArn,
      format: JSON.stringify({
        requestId: '$context.requestId',
        ip: '$context.identity.sourceIp',
        requestTime: '$context.requestTime',
        httpMethod: '$context.httpMethod',
        path: '$context.path',
        status: '$context.status',
        protocol: '$context.protocol',
        responseLength: '$context.responseLength',
      }),
    };

    // Lambda integrations (one per function, reused across routes)
    const adminIntegration = new HttpLambdaIntegration('AdminIntegration', props.adminLambdaFunction);
    const traineeIntegration = new HttpLambdaIntegration('TraineeIntegration', props.traineeLambdaFunction);
    const scoringIntegration = new HttpLambdaIntegration('ScoringIntegration', props.scoringLambdaFunction);
    const screenAnalysisIntegration = new HttpLambdaIntegration('ScreenAnalysisIntegration', props.screenAnalysisLambdaFunction);

    // ========================================
    // Admin routes (admin Lambda)
    // ========================================

    // Trainee/session management
    this.httpApi.addRoutes({ path: '/admin/trainees', methods: [apigwv2.HttpMethod.GET], integration: adminIntegration });
    this.httpApi.addRoutes({ path: '/admin/trainees/{userId}/sessions', methods: [apigwv2.HttpMethod.GET], integration: adminIntegration });
    this.httpApi.addRoutes({ path: '/admin/trainees/{userId}/sessions/{sessionId}/scorecard', methods: [apigwv2.HttpMethod.GET], integration: adminIntegration });
    this.httpApi.addRoutes({ path: '/admin/trainees/{userId}/sessions/{sessionId}/transcript', methods: [apigwv2.HttpMethod.GET], integration: adminIntegration });
    this.httpApi.addRoutes({ path: '/admin/trainees/{userId}/sessions/{sessionId}/audio-url', methods: [apigwv2.HttpMethod.GET], integration: adminIntegration });
    this.httpApi.addRoutes({ path: '/admin/trainees/{userId}/sessions/{sessionId}/screen-recording-url', methods: [apigwv2.HttpMethod.GET], integration: adminIntegration });
    this.httpApi.addRoutes({ path: '/admin/trainees/{userId}/sessions/{sessionId}/comment', methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PUT], integration: adminIntegration });

    // Scenario CRUD — register /generate before /{scenarioId} to avoid parameter collision
    this.httpApi.addRoutes({ path: '/admin/scenarios', methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST], integration: adminIntegration });
    this.httpApi.addRoutes({ path: '/admin/scenarios/generate', methods: [apigwv2.HttpMethod.POST], integration: adminIntegration });
    this.httpApi.addRoutes({ path: '/admin/scenarios/{scenarioId}', methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PUT, apigwv2.HttpMethod.DELETE], integration: adminIntegration });

    // Criteria configuration
    this.httpApi.addRoutes({ path: '/admin/criteria', methods: [apigwv2.HttpMethod.GET], integration: adminIntegration });
    this.httpApi.addRoutes({ path: '/admin/criteria/config/{scenarioId}', methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PUT], integration: adminIntegration });

    // ========================================
    // Trainee routes (trainee Lambda)
    // ========================================
    this.httpApi.addRoutes({ path: '/scenarios', methods: [apigwv2.HttpMethod.GET], integration: traineeIntegration });
    this.httpApi.addRoutes({ path: '/scenarios/{scenarioId}', methods: [apigwv2.HttpMethod.GET], integration: traineeIntegration });
    this.httpApi.addRoutes({ path: '/sessions', methods: [apigwv2.HttpMethod.POST], integration: traineeIntegration });

    // ========================================
    // Scoring routes (scoring Lambda) — async pattern
    // ========================================
    this.httpApi.addRoutes({ path: '/scoring', methods: [apigwv2.HttpMethod.POST], integration: scoringIntegration });
    this.httpApi.addRoutes({ path: '/scoring/{sessionId}', methods: [apigwv2.HttpMethod.GET], integration: scoringIntegration });

    // ========================================
    // Screen analysis route (screen analysis Lambda)
    // ========================================
    this.httpApi.addRoutes({ path: '/screen-analysis', methods: [apigwv2.HttpMethod.POST], integration: screenAnalysisIntegration });

    // ========================================
    // Outputs
    // ========================================
    new cdk.CfnOutput(scope, 'ApiGatewayUrl', {
      value: this.httpApi.apiEndpoint,
      description: 'HTTP API Gateway endpoint URL',
    });
  }
}
