import {
  EC2Client,
  DescribeInstancesCommand,
  DescribeInstanceStatusCommand,
  RebootInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
} from "@aws-sdk/client-ec2";

import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from "@aws-sdk/client-cloudwatch";

import type { InstanceMetrics, MonitorReport, HealthCheck } from "../types";
import type { ScopedCredentials } from "./sts";

// ── Config ────────────────────────────────────────────────────────────────────

const REGION = process.env.AWS_REGION || "ap-south-1";

// Static limits are a placeholder. They are replaced by per-instance baselines
// once `baselines` has enough history — see src/monitor/baseline.ts.
const CPU_LIMITS = { warning: 85, critical: 95 }; // percent

const ec2 = new EC2Client({ region: REGION });
const cloudwatch = new CloudWatchClient({ region: REGION });

// ── Helpers ───────────────────────────────────────────────────────────────────

function cpuSeverity(value: number | null): "ok" | "warning" | "critical" {
  if (value === null) return "ok";
  if (value >= CPU_LIMITS.critical) return "critical";
  if (value >= CPU_LIMITS.warning) return "warning";
  return "ok";
}

async function getCpuUtilization(instanceId: string): Promise<number | null> {
  const now = new Date();
  const start = new Date(now.getTime() - 10 * 60 * 1000); // last 10 minutes

  const response = await cloudwatch.send(
    new GetMetricStatisticsCommand({
      Namespace: "AWS/EC2",
      MetricName: "CPUUtilization",
      Dimensions: [{ Name: "InstanceId", Value: instanceId }],
      StartTime: start,
      EndTime: now,
      Period: 300, // 5-minute intervals
      Statistics: ["Average"],
    }),
  );

  const datapoints = response.Datapoints ?? [];
  if (datapoints.length === 0) return null;

  const sorted = datapoints.sort(
    (a, b) => (b.Timestamp?.getTime() ?? 0) - (a.Timestamp?.getTime() ?? 0),
  );
  return sorted[0].Average ?? null;
}

// ── Core: discover + monitor all instances ────────────────────────────────────

export async function monitorInstances(): Promise<MonitorReport> {
  // 1. Discover every instance in the region (paginated — a single call caps out).
  const reservations = [];
  let nextToken: string | undefined;
  do {
    const page = await ec2.send(new DescribeInstancesCommand({ NextToken: nextToken }));
    reservations.push(...(page.Reservations ?? []));
    nextToken = page.NextToken;
  } while (nextToken);

  // 2. Status checks. Absent entries stay `unknown` — never assume healthy.
  const statusResponse = await ec2.send(
    new DescribeInstanceStatusCommand({ IncludeAllInstances: true }),
  );
  const statusMap = new Map<string, HealthCheck>(
    (statusResponse.InstanceStatuses ?? []).map((s) => [
      s.InstanceId!,
      s.InstanceStatus?.Status === "ok" && s.SystemStatus?.Status === "ok"
        ? "ok"
        : "failed",
    ]),
  );

  // 3. Collect metrics for every running instance, in parallel.
  const discovered = reservations.flatMap((r) => r.Instances ?? []);

  const instances: InstanceMetrics[] = await Promise.all(
    discovered.map(async (instance): Promise<InstanceMetrics> => {
      const instanceId = instance.InstanceId!;
      const state = instance.State?.Name ?? "unknown";
      const name =
        instance.Tags?.find((t) => t.Key === "Name")?.Value ?? instanceId;

      const cpu = state === "running" ? await getCpuUtilization(instanceId) : null;
      const severity = cpuSeverity(cpu);
      const health: HealthCheck = statusMap.get(instanceId) ?? "unknown";

      const anomalies: string[] = [];
      if (severity === "critical") anomalies.push(`CPU critical: ${cpu?.toFixed(1)}%`);
      else if (severity === "warning") anomalies.push(`CPU warning: ${cpu?.toFixed(1)}%`);
      if (health === "failed") anomalies.push("Instance or system status check failed");
      if (health === "unknown" && state === "running")
        anomalies.push("Status check result unavailable — health is unconfirmed");
      if (state !== "running" && state !== "stopped")
        anomalies.push(`Unexpected instance state: ${state}`);

      return {
        instanceId,
        name,
        state,
        type: instance.InstanceType ?? "unknown",
        az: instance.Placement?.AvailabilityZone ?? "unknown",
        health,
        managedByClawOps:
          instance.Tags?.some((t) => t.Key === "ManagedBy" && t.Value === "ClawOps") ?? false,
        expiresAt:
          instance.Tags?.find((t) => t.Key === "ExpiresAt")?.Value ?? null,
        cpu: { average: cpu, severity },
        anomalies,
      };
    }),
  );

  const hasAnomalies = instances.some((i) => i.anomalies.length > 0);
  const runningCount = instances.filter((i) => i.state === "running").length;
  const anomalyCount = instances.filter((i) => i.anomalies.length > 0).length;

  const summary = hasAnomalies
    ? `${anomalyCount} of ${instances.length} instances have anomalies. ${runningCount} running in ${REGION}.`
    : `All ${instances.length} instances healthy. ${runningCount} running in ${REGION}.`;

  return {
    region: REGION,
    timestamp: new Date().toISOString(),
    instanceCount: instances.length,
    instances,
    hasAnomalies,
    summary,
  };
}

// ── Actions ───────────────────────────────────────────────────────────────────
//
// Every action takes the credentials it must run under. There is no default:
// the agent's own role is read-only, so passing nothing here gets an
// AccessDenied from AWS. Working credentials only exist after a human has
// approved the request and the broker has minted a session for it.

/** An EC2 client bound to one approved action's short-lived session. */
function elevatedClient(credentials: ScopedCredentials): EC2Client {
  return new EC2Client({
    region: REGION,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
  });
}

export async function rebootInstance(
  instanceId: string,
  credentials: ScopedCredentials,
): Promise<string> {
  await elevatedClient(credentials).send(new RebootInstancesCommand({ InstanceIds: [instanceId] }));
  return `Reboot initiated for ${instanceId}`;
}

export async function startInstance(
  instanceId: string,
  credentials: ScopedCredentials,
): Promise<string> {
  await elevatedClient(credentials).send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
  return `Start initiated for ${instanceId}`;
}

export async function stopInstance(
  instanceId: string,
  credentials: ScopedCredentials,
): Promise<string> {
  await elevatedClient(credentials).send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
  return `Stop initiated for ${instanceId}`;
}
