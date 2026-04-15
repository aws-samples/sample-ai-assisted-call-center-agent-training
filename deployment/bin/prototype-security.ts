// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { App, CfnResource, Stack } from "aws-cdk-lib";
import { IConstruct } from "constructs";
import {
  NagPack,
  NagPackProps,
  NagMessageLevel,
  rules,
  NagRuleCompliance,
  NagRuleResult,
  NagRules,
} from "cdk-nag";
import { CfnVPC, CfnVPCEndpoint } from "aws-cdk-lib/aws-ec2";
import { CfnBucket } from "aws-cdk-lib/aws-s3";
import { CfnGuardrail } from "aws-cdk-lib/aws-bedrock";
import { CfnCodeInterpreterCustom, CfnGateway, CfnMemory, CfnRuntime } from "aws-cdk-lib/aws-bedrockagentcore";
import { CfnNotebookInstance } from "aws-cdk-lib/aws-sagemaker";

export class PrototypeSecurityNagPack extends NagPack {
  constructor(props?: NagPackProps) {
    super(props);
    this.packName = "Prototype Security Nag Pack";
  }
  public visit(node: IConstruct): void {
    if (node instanceof App) {
      this.bedrockGuardrailsExists(node);
    } else if (node instanceof CfnResource) {
      this.lambdaInVpc(node);
      [
        "s3",
        "dynamodb",
        "bedrock",
        "bedrock-agent",
        "bedrock-runtime",
        "bedrock-agent-runtime",
        "batch",
      ].forEach((serviceName) => this.serviceVpcEndpoint(node, serviceName));
      this.s3CMK(node);
      this.bedrockGuardrailsSensitiveInformation(node);
      this.notebookNoRootAccess(node);
      this.codeInterpreterNotPublic(node);
      this.runtimeInVpc(node);
      this.gatewayUsesCMK(node);
      this.memoryCMK(node);
    }
  }

  private lambdaInVpc(node: CfnResource): void {
    this.applyRule({
      info: "Lambda function is not VPC enabled.",
      explanation:
        "Resources that reside within an Amazon VPC have an extra layer of security when compared to resources that use public endpoints.",
      level: NagMessageLevel.ERROR,
      node,
      rule: rules.lambda.LambdaInsideVPC,
    });
  }

  private serviceVpcEndpoint(node: CfnResource, serviceName: string): void {
    this.applyRule({
      info: `VPC does not have an endpoint for ${serviceName}.`,
      explanation: "Protect your data using Amazon VPC and AWS Private link.",
      level: NagMessageLevel.WARN,
      node,
      ruleSuffixOverride: `VPC Endpoint for ${serviceName}`,
      rule: (node: CfnResource): NagRuleResult => {
        if (node instanceof CfnVPC) {
          //check if the vpc has a vpc endpoint for this service
          for (const child of Stack.of(node).node.findAll()) {
            if (
              child instanceof CfnVPCEndpoint &&
              child.serviceName?.indexOf(serviceName) !== -1
            ) {
              return NagRuleCompliance.COMPLIANT;
            }
          }
          return NagRuleCompliance.NON_COMPLIANT;
        } else {
          return NagRuleCompliance.NOT_APPLICABLE;
        }
      },
    });
  }

  private s3CMK(node: CfnResource): void {
    this.applyRule({
      info: "S3 bucket does not use AWS KMS Customer Managed Key.",
      explanation:
        "Customer managed keys provide customers full control including lifecycle management, and access control.",
      level: NagMessageLevel.ERROR,
      node,
      ruleSuffixOverride: "CMK for S3 buckets",
      rule: (node: CfnResource): NagRuleResult => {
        if (node instanceof CfnBucket) {
          if (node.bucketEncryption === undefined) {
            return NagRuleCompliance.NON_COMPLIANT;
          }
          const encryption = Stack.of(node).resolve(node.bucketEncryption);
          if (encryption.serverSideEncryptionConfiguration === undefined) {
            return NagRuleCompliance.NON_COMPLIANT;
          }
          const sse = Stack.of(node).resolve(
            encryption.serverSideEncryptionConfiguration
          );
          for (const rule of sse) {
            const defaultEncryption = Stack.of(node).resolve(
              rule.serverSideEncryptionByDefault
            );
            if (defaultEncryption === undefined) {
              return NagRuleCompliance.NON_COMPLIANT;
            }
            let key: any
            try {
              key = NagRules.resolveIfPrimitive(
                node,
                defaultEncryption.kmsMasterKeyId
              );
            } catch (error) {
              try {
                key = NagRules.resolveResourceFromInstrinsic(node, defaultEncryption.kmsMasterKeyId)
              } catch (error) {
                console.error("[PrototypeSecurityPack]", "Unable to resolve KMS key id to verify S3 encryption configuration")
              }
            }
            if (key === undefined) {
              return NagRuleCompliance.NON_COMPLIANT;
            }
          }
          return NagRuleCompliance.COMPLIANT;
        } else {
          return NagRuleCompliance.NOT_APPLICABLE;
        }
      },
    });
  }

  private bedrockGuardrailsExists(node: App | Stack): void {
    //find the first CfnResource node to apply the annotations on
    const resourceNode = node.node
      .findAll()
      .find((node) => node instanceof CfnResource);
    if (resourceNode) {
      this.applyRule({
        info: "Missing Bedrock Guardrails.",
        explanation:
          "Create guardrails to safeguard your generative AI applications.",
        level: NagMessageLevel.WARN,
        node: resourceNode as CfnResource,
        ruleSuffixOverride: "Bedrock Guardrails Exists",
        rule: (_node: CfnResource): NagRuleResult => {
          //get all resources under the app or stack to check for CfnGuardrail presence of
          if (
            node.node.findAll().some((node) => node instanceof CfnGuardrail)
          ) {
            return NagRuleCompliance.COMPLIANT;
          }
          return NagRuleCompliance.NON_COMPLIANT;
        },
      });
    }
  }

  private bedrockGuardrailsSensitiveInformation(node: CfnResource): void {
    this.applyRule({
      info: "Missing Bedrock Guardrails sensitive information policy configuration.",
      explanation:
        "Create guardrails to block sensitive information and to implement safeguards for your generative AI applications.",
      level: NagMessageLevel.ERROR,
      node,
      ruleSuffixOverride: "Bedrock Guardrails Sensitive Information",
      rule: (node: CfnResource): NagRuleResult => {
        //check if CfnGuardrail has Sensitive information config
        if (node instanceof CfnGuardrail) {
          const config = Stack.of(node).resolve(
            node.sensitiveInformationPolicyConfig
          );
          if (config === undefined) {
            return NagRuleCompliance.NON_COMPLIANT;
          }
          const piiConfig = Stack.of(node).resolve(config.piiEntitiesConfig);
          if (piiConfig === undefined) {
            return NagRuleCompliance.NON_COMPLIANT;
          }
          return NagRuleCompliance.COMPLIANT;
        } else {
          return NagRuleCompliance.NOT_APPLICABLE;
        }
      },
    });
  }

  private notebookNoRootAccess(node: CfnResource): void {
    this.applyRule({
      info: "Root access on notebook.",
      explanation: "Disable root access on notebook.",
      level: NagMessageLevel.ERROR,
      node,
      ruleSuffixOverride: "Noteboook Root access",
      rule: (node: CfnResource): NagRuleResult => {
        if (node instanceof CfnNotebookInstance) {
          const rootAccess = NagRules.resolveIfPrimitive(node, node.rootAccess);
          if (rootAccess === "Disabled") {
            return NagRuleCompliance.COMPLIANT;
          }
          return NagRuleCompliance.NON_COMPLIANT;
        } else {
          return NagRuleCompliance.NOT_APPLICABLE;
        }
      },
    });
  }

  private codeInterpreterNotPublic(node: CfnResource): void {
    this.applyRule({
      info: "Bedrock AgentCore Code Interpreter is configured with PUBLIC network mode.",
      explanation:
        "Bedrock AgentCore Code Interpreter with PUBLIC network access allows agent-generated code to access the internet, which poses security risks including data exfiltration and uncontrolled outbound connections. Use SANDBOX or VPC network mode instead.",
      level: NagMessageLevel.ERROR,
      node,
      ruleSuffixOverride: "Bedrock AgentCore Code Interpreter Network Mode",
      rule: (node: CfnResource): NagRuleResult => {
        if (node instanceof CfnCodeInterpreterCustom) {
          const networkConfig = Stack.of(node).resolve(
            node.networkConfiguration
          );
          if (networkConfig === undefined) {
            return NagRuleCompliance.NOT_APPLICABLE;
          }
          const networkMode = NagRules.resolveIfPrimitive(
            node,
            networkConfig.networkMode
          );
          if (networkMode === "PUBLIC") {
            return NagRuleCompliance.NON_COMPLIANT;
          }
          return NagRuleCompliance.COMPLIANT;
        } else {
          return NagRuleCompliance.NOT_APPLICABLE;
        }
      },
    });
  }

  private runtimeInVpc(node: CfnResource): void {
    this.applyRule({
      info: "Bedrock AgentCore Runtime is not configured with VPC network mode.",
      explanation:
        "Bedrock AgentCore Runtime resources should use VPC network mode to ensure network isolation and enhanced security. VPC mode provides an extra layer of security by keeping traffic within your private network.",
      level: NagMessageLevel.ERROR,
      node,
      ruleSuffixOverride: "Bedrock AgentCore Runtime VPC Network Mode",
      rule: (node: CfnResource): NagRuleResult => {
        if (node instanceof CfnRuntime) {
          const networkConfig = Stack.of(node).resolve(
            node.networkConfiguration
          );
          if (networkConfig === undefined) {
            return NagRuleCompliance.NON_COMPLIANT;
          }
          const networkMode = NagRules.resolveIfPrimitive(
            node,
            networkConfig.networkMode
          );
          if (networkMode !== "VPC") {
            return NagRuleCompliance.NON_COMPLIANT;
          }
          return NagRuleCompliance.COMPLIANT;
        } else {
          return NagRuleCompliance.NOT_APPLICABLE;
        }
      },
    });
  }

  private gatewayUsesCMK(node: CfnResource): void {
    this.applyRule({
      info: "Bedrock AgentCore Gateway does not use AWS KMS Customer Managed Key.",
      explanation:
        "Customer managed keys provide customers full control including lifecycle management, and access control for Bedrock AgentCore Gateway encryption.",
      level: NagMessageLevel.ERROR,
      node,
      ruleSuffixOverride: "CMK for Bedrock AgentCore Gateway",
      rule: (node: CfnResource): NagRuleResult => {
        if (node instanceof CfnGateway) {
          const kmsKeyArn = NagRules.resolveIfPrimitive(node, node.kmsKeyArn);
          if (kmsKeyArn === undefined) {
            return NagRuleCompliance.NON_COMPLIANT;
          }
          return NagRuleCompliance.COMPLIANT;
        } else {
          return NagRuleCompliance.NOT_APPLICABLE;
        }
      },
    });
  }

  private memoryCMK(node: CfnResource): void {
    this.applyRule({
      info: "Bedrock AgentCore Memory does not use AWS KMS Customer Managed Key.",
      explanation:
        "Customer managed keys provide customers full control including lifecycle management, and access control for Bedrock AgentCore Memory encryption.",
      level: NagMessageLevel.ERROR,
      node,
      ruleSuffixOverride: "CMK for Bedrock AgentCore Memory",
      rule: (node: CfnResource): NagRuleResult => {
        if (node instanceof CfnMemory) {
          const encryptionKeyArn = NagRules.resolveIfPrimitive(node, node.encryptionKeyArn);
          if (encryptionKeyArn === undefined) {
            return NagRuleCompliance.NON_COMPLIANT;
          }
          return NagRuleCompliance.COMPLIANT;
        } else {
          return NagRuleCompliance.NOT_APPLICABLE;
        }
      },
    });
  }
}
