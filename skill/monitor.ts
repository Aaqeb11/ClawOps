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

// ── Config ────────────────────────────────────────────────────────────────────

const REGION = process.env.AWS_REGION || "me-central-1";

const THRESHOLDS = {
  cpu: { warning: 85, critical: 95 }, // percent
  disk: { warning: 80, critical: 90 }, // percent
  statusCheckFailed: true, // always alert if status check fails
};

const ec2 = new EC2Client({ region: REGION });
const cloudwatch = new CloudWatchClient({ region: REGION });

// ── Types ─────────────────────────────────────────────────────────────────────

export interface InstanceMetrics {
  instanceId: string;
  name: string;
  state: string;
  type: string;
  az: string;
  statusCheckPassed: boolean;
  cpu: {
    average: number | null;
    severity: "ok" | "warning" | "critical";
  };
  anomalies: string[];
}

export interface MonitorReport {
  region: string;
  timestamp: string;
  instanceCount: number;
  instances: InstanceMetrics[];
  hasAnomalies: boolean;
  summary: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function cpuSeverity(value: number | null): "ok" | "warning" | "critical" {
  if (value === null) return "ok";
  if (value >= THRESHOLDS.cpu.critical) return "critical";
  if (value >= THRESHOLDS.cpu.warning) return "warning";
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

  // Return the most recent datapoint
  const sorted = datapoints.sort(
    (a, b) => (b.Timestamp?.getTime() ?? 0) - (a.Timestamp?.getTime() ?? 0),
  );
  return sorted[0].Average ?? null;
}

// ── Core: Discover + Monitor All Instances ────────────────────────────────────

export async function monitorInstances(): Promise<MonitorReport> {
  // 1. Discover all instances in the region
  const describeResponse = await ec2.send(new DescribeInstancesCommand({}));
  const reservations = describeResponse.Reservations ?? [];

  // 2. Get instance status checks
  const statusResponse = await ec2.send(
    new DescribeInstanceStatusCommand({ IncludeAllInstances: true }),
  );
  const statusMap = new Map(
    (statusResponse.InstanceStatuses ?? []).map((s) => [
      s.InstanceId,
      s.InstanceStatus?.Status === "ok" && s.SystemStatus?.Status === "ok",
    ]),
  );

  // 3. Collect metrics per instance
  const instances: InstanceMetrics[] = [];

  for (const reservation of reservations) {
    for (const instance of reservation.Instances ?? []) {
      const instanceId = instance.InstanceId!;
      const state = instance.State?.Name ?? "unknown";
      const name =
        instance.Tags?.find((t) => t.Key === "Name")?.Value ?? instanceId;

      // Only fetch metrics for running instances
      const cpu =
        state === "running" ? await getCpuUtilization(instanceId) : null;
      const severity = cpuSeverity(cpu);
      const statusCheckPassed = statusMap.get(instanceId) ?? true;

      // Build anomaly list
      const anomalies: string[] = [];
      if (severity === "critical")
        anomalies.push(`CPU critical: ${cpu?.toFixed(1)}%`);
      else if (severity === "warning")
        anomalies.push(`CPU warning: ${cpu?.toFixed(1)}%`);
      if (!statusCheckPassed)
        anomalies.push("Instance or system status check failed");
      if (state !== "running" && state !== "stopped")
        anomalies.push(`Unexpected instance state: ${state}`);

      instances.push({
        instanceId,
        name,
        state,
        type: instance.InstanceType ?? "unknown",
        az: instance.Placement?.AvailabilityZone ?? "unknown",
        statusCheckPassed,
        cpu: { average: cpu, severity },
        anomalies,
      });
    }
  }

  const hasAnomalies = instances.some((i) => i.anomalies.length > 0);

  // 4. Build a plain-English summary for OpenClaw to reason over
  const runningCount = instances.filter((i) => i.state === "running").length;
  const anomalyCount = instances.filter((i) => i.anomalies.length > 0).length;

  const summary = hasAnomalies
    ? `⚠️ ${anomalyCount} of ${instances.length} instances have anomalies. ${runningCount} running in ${REGION}.`
    : `✅ All ${instances.length} instances healthy. ${runningCount} running in ${REGION}.`;

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

// LOW RISK — auto-execute
export async function rebootInstance(instanceId: string): Promise<string> {
  await ec2.send(new RebootInstancesCommand({ InstanceIds: [instanceId] }));
  return `✅ Reboot initiated for ${instanceId}`;
}

export async function startInstance(instanceId: string): Promise<string> {
  await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
  return `✅ Start initiated for ${instanceId}`;
}

// HIGH RISK — only called after explicit Slack approval
export async function stopInstance(instanceId: string): Promise<string> {
  await ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
  return `🛑 Stop initiated for ${instanceId}`;
}

// ── Entrypoint (for direct CLI testing) ──────────────────────────────────────

if (require.main === module) {
  monitorInstances()
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((err) => {
      console.error("Monitor error:", err.message);
      process.exit(1);
    });
}
