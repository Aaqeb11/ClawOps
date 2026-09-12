// Credential minting. This module runs inside the broker process only — the
// agent never imports it, and never holds the role ARN or the external id it
// needs. That separation is what makes the approval gate real rather than
// advisory: a compromised agent has nothing to assume the role with.

import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";

import type { Action } from "../broker/store";

export interface ScopedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: string;
}

const REGION = process.env.AWS_REGION || "ap-south-1";

/** Shortest session AWS allows. The agent needs seconds, not an hour. */
const SESSION_DURATION_SECONDS = 900;

const sts = new STSClient({ region: REGION });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(
      `${name} is not set. The broker cannot mint credentials without it.`,
    );
  return value;
}

/**
 * Assume the elevated role for one approved action.
 *
 * The session name carries the approver and the request id, so CloudTrail
 * shows *who* authorised the change and which approval it came from — the
 * audit trail is a property of the credential, not of our own logging.
 */
export async function mintScopedCredentials(
  action: Action,
  instanceId: string,
  requestId: string,
  approver: string,
): Promise<ScopedCredentials> {
  const roleArn = requireEnv("CLAWOPS_ELEVATED_ROLE_ARN");
  const externalId = requireEnv("CLAWOPS_EXTERNAL_ID");

  const response = await sts.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      // Session names allow [\w+=,.@-]{2,64}; approver ids and uuids can carry
      // characters outside that, so sanitise rather than let AWS reject it.
      RoleSessionName: sessionName(approver, requestId),
      ExternalId: externalId,
      DurationSeconds: SESSION_DURATION_SECONDS,
      // Second, independent narrowing: even if the role's own policy were
      // loosened, this session can only ever touch the approved instance.
      Policy: JSON.stringify(singleInstancePolicy(action, instanceId)),
    }),
  );

  const credentials = response.Credentials;
  if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken)
    throw new Error("STS returned an incomplete credential set.");

  return {
    accessKeyId: credentials.AccessKeyId,
    secretAccessKey: credentials.SecretAccessKey,
    sessionToken: credentials.SessionToken,
    expiration: (credentials.Expiration ?? new Date()).toISOString(),
  };
}

export function sessionName(approver: string, requestId: string): string {
  const clean = (value: string) => value.replace(/[^\w+=,.@-]/g, "-");
  // Approver first so the truncation eats the request id, not the name — an
  // auditor scanning CloudTrail looks for who authorised it before anything else.
  return `clawops-${clean(approver)}-${clean(requestId)}`.slice(0, 64);
}

const ACTION_TO_EC2: Record<Action, string> = {
  reboot: "ec2:RebootInstances",
  start: "ec2:StartInstances",
  stop: "ec2:StopInstances",
};

/** Session policy: exactly one verb, exactly one instance. */
export function singleInstancePolicy(action: Action, instanceId: string) {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "ThisOneApprovedAction",
        Effect: "Allow",
        Action: ACTION_TO_EC2[action],
        Resource: `arn:aws:ec2:*:*:instance/${instanceId}`,
      },
      {
        Sid: "ConfirmItsOwnWork",
        Effect: "Allow",
        Action: "ec2:DescribeInstances",
        Resource: "*",
      },
    ],
  };
}
