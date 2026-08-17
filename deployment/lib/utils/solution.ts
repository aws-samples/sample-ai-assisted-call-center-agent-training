/**
 * Solution Identity
 * Single source of truth for the solution ID, version, and the custom User-Agent
 * string used to collect service API usage. The version tracks
 * deployment/package.json so a release only needs one version bump.
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

const { version } = require('../../package.json');

export const SOLUTION_ID = 'SO0349';
/** Secondary solution ID. Reported in stack descriptions only, not in the User-Agent. */
export const SECONDARY_SOLUTION_ID = 'SO9706';
export const SOLUTION_VERSION = `v${version}`;
export const SOLUTION_NAME = 'AI-Assisted Call Center Representative Training';

/**
 * Appended to the boto3 User-Agent header so AWS can attribute service API
 * usage to this solution. Format is fixed: AWSSOLUTION/$solutionId/$solutionVersion
 */
export const SOLUTION_USER_AGENT = `AWSSOLUTION/${SOLUTION_ID}/${SOLUTION_VERSION}`;

/** CloudFormation stack description carrying the solution IDs and version. */
export function stackDescription(component: string): string {
  return `(${SOLUTION_ID}) (${SECONDARY_SOLUTION_ID}) - ${SOLUTION_NAME} ${component}. Version ${SOLUTION_VERSION}`;
}

/**
 * Returns a Fn::FindInMap reference to the custom User-Agent string, creating the
 * `Solution` mapping in the enclosing stack on first use. Pass the result as the
 * USER_AGENT_STRING environment variable of any function that calls AWS SDKs.
 */
export function solutionUserAgent(scope: Construct): string {
  const stack = cdk.Stack.of(scope);
  const existing = stack.node.tryFindChild('Solution') as cdk.CfnMapping | undefined;
  const mapping = existing ?? new cdk.CfnMapping(stack, 'Solution', {
    mapping: {
      Metadata: { CustomUserAgent: SOLUTION_USER_AGENT },
    },
  });
  return mapping.findInMap('Metadata', 'CustomUserAgent');
}
