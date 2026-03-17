# 🦞 ClawOps — AI-Powered DevOps Monitoring

> Intelligent cloud infrastructure monitoring powered by OpenClaw, delivering real-time insights and actionable alerts directly to your Slack channel.

---

## Overview

ClawOps is an AI-driven DevOps monitoring system built on top of [OpenClaw](https://openclaw.ai) — an open-source personal AI agent runtime. It continuously watches your cloud infrastructure, understands what it sees, and communicates with your development team through Slack in plain, human language.

Rather than just forwarding raw metrics or threshold breach alerts, ClawOps uses AI to **correlate signals, reason about anomalies, and suggest — or take — appropriate action**. Think of it as giving your infrastructure a voice, and your team a way to talk back to it.

---

## Purpose

Modern DevOps teams are drowning in monitoring noise. Dashboards go unread, alerts get ignored, and by the time a real incident surfaces it's already causing damage. ClawOps exists to fix this by sitting between your cloud infrastructure and your team, acting as an intelligent intermediary that:

- Understands the *context* behind metrics, not just the numbers
- Knows the difference between a traffic spike and a memory leak
- Speaks to engineers in plain language through the tools they already use
- Can take low-risk remediation actions automatically, and ask for approval on high-risk ones

---

## Goals

**Short-term (Prototype)**
- Monitor one or more compute instances via your cloud provider's native metrics API
- Deliver periodic health summaries to a designated Slack channel
- Detect and immediately alert on anomalous behaviour (CPU spikes, memory pressure, network saturation, etc.)
- Allow basic remediation commands to be issued directly from Slack

**Medium-term**
- Support multiple instances and instance groups across providers
- Build memory of each instance's "normal" behaviour over time
- Enable natural language queries from Slack ("what happened to prod-server-2 last night?")
- Expand action coverage (scaling, log fetching, service restarts)

**Long-term**
- Multi-region and multi-account support across cloud providers
- Support for managed databases, containers, serverless functions, and other cloud-native services
- Customisable alerting profiles per team or environment
- Incident timeline generation and post-mortem assistance

---

## How It Works

The system is composed of three layers that work together continuously:

### 1. Data Collection — Cloud Provider SDK

A custom OpenClaw skill written in TypeScript uses your **cloud provider's SDK** to pull live metrics and instance state. This includes CPU utilisation, memory, disk I/O, network throughput, and instance health status.

ClawOps ships with adapters for major cloud providers out of the box, and the provider interface is designed to be extensible — so adding support for a new platform is straightforward.

The skill is invoked on a schedule (heartbeat) and also on-demand when commands arrive from Slack.

**Currently supported providers:**
- AWS (EC2 + CloudWatch)
- GCP (Compute Engine + Cloud Monitoring) *(planned)*
- Azure (Virtual Machines + Azure Monitor) *(planned)*

### 2. AI Analysis — OpenClaw Agent

OpenClaw acts as the brain of the system. It receives the raw metrics from the skill, reasons over them using its underlying AI model, and produces a human-readable diagnosis. Because OpenClaw has **persistent memory**, it builds context over time — it can recognise that a server behaves differently on weekends, or that a particular instance has been gradually degrading over several days.

OpenClaw decides whether the current state is:
- **Normal** → send a routine periodic summary to Slack
- **Unusual** → send an immediate alert with an explanation and suggested action
- **Critical** → send an urgent alert and either auto-remediate (low-risk) or request human approval (high-risk)

### 3. Action & Communication — Slack (Two-Way)

Slack serves as both the **notification surface and the command interface**. The team receives AI-generated updates in a dedicated channel and can respond directly:

- Approve or reject a proposed action via Slack buttons
- Issue commands in natural language ("restart the web server on prod-1")
- Ask questions about instance history or current state
- Configure monitoring preferences on the fly

**Low-risk actions** (e.g. restarting a non-critical service, fetching logs) are executed automatically by OpenClaw without human approval. **High-risk actions** (e.g. terminating an instance, scaling down a cluster) are always presented to the team first with a clear explanation before anything is executed.

---

## Architecture Diagram

```
┌─────────────────────────────────┐
│       Cloud Infrastructure       │
│  Compute · Managed Services      │
│  AWS · GCP · Azure · and more    │
└──────────────┬──────────────────┘
               │  Cloud Provider SDK (TypeScript)
               ▼
┌─────────────────────────────────┐
│       ClawOps Skill              │
│  Fetches metrics & instance data │
│  Detects threshold breaches      │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│         OpenClaw Agent           │
│  AI analysis & reasoning         │
│  Persistent memory per instance  │
│  Scheduled heartbeats            │
│  Action decision engine          │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│           Slack Channel          │
│  ← Periodic summaries            │
│  ← Anomaly alerts                │
│  ← Action approval requests      │
│  → Commands from dev team        │
│  → Approve / Reject buttons      │
└─────────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| AI Agent Runtime | [OpenClaw](https://openclaw.ai) |
| Cloud Metrics & Control | Cloud Provider SDK (pluggable) |
| Language | TypeScript |
| Communication | Slack (via OpenClaw's native Slack integration) |
| Infrastructure Setup | Terraform (IAM / permissions, metric alarms) |
| Package Manager | pnpm |

---

## Action Classification

| Action | Risk Level | Behaviour |
|---|---|---|
| Fetch logs | Low | Auto-execute |
| Restart a service | Low | Auto-execute |
| Reboot an instance | Medium | Auto-execute with notification |
| Scale up | High | Requires Slack approval |
| Scale down | High | Requires Slack approval |
| Terminate instance | Critical | Requires Slack approval + confirmation |

---

## Project Structure (Planned)

```
clawops/
├── README.md
├── skill/
│   ├── skill.md              # OpenClaw skill definition
│   ├── monitor.ts            # Metrics fetching (provider-agnostic interface)
│   ├── actions.ts            # Remediation action handlers
│   └── thresholds.json       # Configurable alert thresholds
├── providers/
│   ├── aws.ts                # AWS adapter (EC2 + CloudWatch)
│   ├── gcp.ts                # GCP adapter (Compute Engine + Cloud Monitoring)
│   └── azure.ts              # Azure adapter (VMs + Azure Monitor)
├── terraform/
│   ├── main.tf               # Permissions & metric alarm setup
│   └── variables.tf
└── config/
    └── instances.json        # Instances to monitor (with provider field)
```

---

## Status

🚧 **This project is currently in active early development.** The architecture is defined and the prototype is being built. Contributions and feedback welcome.
