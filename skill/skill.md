---
name: clawops
description: AWS infrastructure monitoring skill for EC2 and CloudWatch. Discovers running instances in me-central-1, collects CPU and health metrics, detects anomalies, and reports to the #cloud-updates Slack channel. Supports low-risk remediation actions (reboot, start) and flags high-risk actions (stop) for explicit user approval before execution.
metadata: {"openclaw":{"emoji":"🦞","requires":{"bins":["node"],"env":["AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY","AWS_REGION"]},"primaryEnv":"AWS_ACCESS_KEY_ID"}}
user-invocable: true
---

# ClawOps — AWS Monitoring Skill

You have access to an AWS monitoring skill located at `~/ClawOps/skill`.

## What this skill does

This skill gives you eyes and hands on the AWS infrastructure in the `me-central-1` region. Use it to:

- **Discover** all EC2 instances and their current state
- **Collect** CloudWatch metrics (CPU utilisation, status checks) for running instances
- **Detect** anomalies and unhealthy instances
- **Report** health summaries and alerts to the `#cloud-updates` Slack channel
- **Take action** on instances when needed (with the correct approval level)

---

## How to run the monitor

To fetch current infrastructure health, run:

```bash
cd ~/ClawOps/skill && yarn ts-node monitor.ts
```

This returns a JSON report with:
- `summary` — a plain-English one-line status you should always include in Slack messages
- `instances` — per-instance metrics including CPU, state, and anomalies
- `hasAnomalies` — boolean flag; if `true`, send an immediate Slack alert
- `region` and `timestamp` — always include these in reports

---

## Reporting to Slack

Always send reports to the **#cloud-updates** channel.

### Routine health summary (scheduled)
Use this format for periodic updates:

```
[ClawOps] Health Summary — me-central-1
🕐 <timestamp>

<summary line from report>

Instance breakdown:
• <name> (<instanceId>) — <state> | CPU: <value>% | Status: ✅/❌
• ...
```

### Anomaly alert (immediate)
When `hasAnomalies` is `true`, send an urgent alert immediately:

```
[CRITICAL/WARNING] AWS Anomaly Detected — me-central-1
🕐 <timestamp>

Affected instances:
• <name> (<instanceId>): <anomaly description>

Recommended action: <your reasoning>
```

---

## Remediation actions

### ⚡ Low-risk — confirm then auto-execute
You may execute these after briefly confirming in Slack:
- Reboot an instance → calls `rebootInstance(instanceId)`
- Start a stopped instance → calls `startInstance(instanceId)`

To execute, run:
```bash
cd ~/ClawOps/skill && yarn ts-node -e "
const { rebootInstance } = require('./monitor');
rebootInstance('INSTANCE_ID').then(console.log);
"
```

### 🔴 High-risk — always request explicit approval
**Never execute these without the user typing an explicit confirmation in Slack.** Send an approval request message first:

```
[ACTION REQUIRED] High-Risk Action Pending
Instance: <name> (<instanceId>)
Action: Stop instance
Reason: <your reasoning>

Reply APPROVE to confirm or DENY to cancel.
```

Only proceed after the user replies with explicit approval.

High-risk actions include:
- Stopping an instance → calls `stopInstance(instanceId)`
- Any action affecting more than one instance at a time
- Any irreversible operation

---

## Monitoring schedule

Run `monitor.ts` on a regular heartbeat. Suggested cadence:
- **Every 30 minutes** → routine health summary to Slack
- **Immediately** → if `hasAnomalies: true` is detected in any run

To configure a heartbeat, add this to your `~/.openclaw/openclaw.json`:
```json
{
  "agents": {
    "defaults": {
      "heartbeat": {
        "enabled": true,
        "intervalMinutes": 30,
        "message": "Run the clawops monitor and report to #cloud-updates"
      }
    }
  }
}
```

---

## Anomaly thresholds

| Metric | Warning | Critical |
|---|---|---|
| CPU Utilisation | ≥ 85% | ≥ 95% |
| Status Check | — | Any failure = critical |
| Instance State | — | Any state other than `running` or `stopped` |

---

## Environment variables required

| Variable | Purpose |
|---|---|
| `AWS_ACCESS_KEY_ID` | IAM user access key |
| `AWS_SECRET_ACCESS_KEY` | IAM user secret key |
| `AWS_REGION` | Set to `me-central-1` |

These must be present in your environment or in the `env` block of `~/.openclaw/openclaw.json` before this skill will load.

---

## Important notes

- **Never hardcode credentials** in any output, Slack messages, or logs
- **Always include the instance ID** alongside the instance name in messages so engineers can act directly
- **Reason about anomalies** — don't just forward raw numbers. Explain what you think is happening and why it matters
- **Remember patterns** — if an instance has been flagged multiple times, mention that history in your alert
