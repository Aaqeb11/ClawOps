export type HealthCheck = "ok" | "failed" | "unknown";

export interface InstanceMetrics {
  instanceId: string;
  name: string;
  state: string;
  type: string;
  az: string;
  /** "unknown" means AWS returned no status for it — not that it is fine. */
  health: HealthCheck;
  managedByClawOps: boolean;
  expiresAt: string | null;
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
