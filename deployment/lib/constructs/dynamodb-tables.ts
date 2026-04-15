/**
 * DynamoDB Tables for Scenario, Criteria Configuration, and Sessions
 *
 * Three tables:
 * 1. Scenarios — stores training scenario definitions (replaces static JSON files)
 * 2. CriteriaConfig — stores per-scenario evaluation criteria overrides
 * 3. Sessions — stores session metadata (user, scenario, score, admin comments)
 *
 * Placed in AgentCore stack (shared infrastructure) since both Web and Connect stacks need access.
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

export class DynamoDBTablesConstruct extends Construct {
  public readonly scenariosTable: dynamodb.Table;
  public readonly criteriaConfigTable: dynamodb.Table;
  public readonly sessionsTable: dynamodb.Table;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // ========================================
    // Scenarios Table
    // ========================================
    this.scenariosTable = new dynamodb.Table(this, 'ScenariosTable', {
      tableName: 'CallCenterTraining-Scenarios',
      partitionKey: { name: 'scenarioId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ========================================
    // Criteria Config Table
    // ========================================
    this.criteriaConfigTable = new dynamodb.Table(this, 'CriteriaConfigTable', {
      tableName: 'CallCenterTraining-CriteriaConfig',
      partitionKey: { name: 'scenarioId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ========================================
    // Sessions Table
    // ========================================
    this.sessionsTable = new dynamodb.Table(this, 'SessionsTable', {
      tableName: 'CallCenterTraining-Sessions',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.sessionsTable.addGlobalSecondaryIndex({
      indexName: 'TimestampIndex',
      partitionKey: { name: 'gsiPk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ContactIdIndex — enables O(1) lookup of sessionId from Connect contactId
    // Used by the Connect post-call Lambda when EventBridge fires with contactId
    this.sessionsTable.addGlobalSecondaryIndex({
      indexName: 'ContactIdIndex',
      partitionKey: { name: 'contactId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ========================================
    // Outputs
    // ========================================
    new cdk.CfnOutput(scope, 'ScenariosTableName', {
      value: this.scenariosTable.tableName,
      description: 'DynamoDB Scenarios table name',
    });

    new cdk.CfnOutput(scope, 'CriteriaConfigTableName', {
      value: this.criteriaConfigTable.tableName,
      description: 'DynamoDB Criteria Config table name',
    });

    new cdk.CfnOutput(scope, 'SessionsTableName', {
      value: this.sessionsTable.tableName,
      description: 'DynamoDB Sessions table name',
    });
  }
}
