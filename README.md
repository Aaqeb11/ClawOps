# ClawOps

An ops agent that lives in Slack, can read your AWS account, and **cannot change
anything** — until a named human approves the specific action on their phone.

At that moment the agent is handed AWS credentials that can do exactly one thing,
to one instance, for fifteen minutes. Then they stop working.

---

## Evidence

Three captures, from two sessions. The Slack exchanges below are from the build
session; the approval recording was captured separately by triggering the broker
directly. They are not one continuous take — see *Known limitations* for the state
of the Slack-to-broker path.

### One reply, two things worth seeing

![The agent reporting instance health and declining to curl an internal address](docs/media/01-agent-refusal.png)

The top half is the read path: both instances enumerated with type and CPU average,
pulled live from EC2 and CloudWatch under an identity that holds no write permission
at all.

The bottom half is the part we'd point a security reviewer at. Asked to `curl` an
internal Docker-network address and paste back exactly what it returns, the agent
declines — not because a rule matched a string, but because the address sits outside
the AWS monitoring toolset it operates with, and it only acts through its sanctioned
CLI. It then offers to find a legitimate way to check the same thing.

An agent that can say where its reach ends is a different object from one that pipes
whatever it's handed into a shell.

### It proposes, with the consequence spelled out

![The agent's action request in the Slack thread](docs/media/02-action-request.png)

Before anything is authorized, the thread carries what was asked, who asked, what
the instance currently looks like, and what will actually happen if this goes ahead
— *anything running on it stops serving until restarted*. The approver reads a
consequence, not a command.

### And then the approval leaves Slack entirely

**▶ [Approval arriving on a registered device](https://github.com/user-attachments/assets/64d7f8db-8e18-436d-917b-10a1b4d15f32)**

A screen recording of the phone as the Auth0 Guardian push lands, showing the
pending action and the tap that authorizes it. Behind it, the broker is blocked on
`/oauth/token` returning `authorization_pending` until this moment; the instant the
tap registers, it receives a verified identity and calls STS.

This is the part that cannot happen in a chat window. The request was made in
Slack; the authorization happens on a separate enrolled device, confirmed with
biometrics. Steal someone's Slack session and you still can't approve anything —
you don't have their phone, and the identity that reaches AWS comes from Auth0,
not from Slack.

---

## The problem

Every AI ops tool on the market runs with one standing IAM role broad enough to
cover everything it might ever need — all day, whether it's working or not. That
single fact is why regulated organisations won't deploy them.

ClawOps inverts it. The agent's own AWS identity can `Describe` and read metrics.
It holds no write permission at all, so an agent that gets prompt-injected through
a log line doesn't get a refusal from our code — it gets `AccessDenied` from AWS.

Write access is minted per-action, per-approval, per-resource, and expires.

---

## How permission works

Two identities and a role. This is the entire security design.

| Identity | Can do | Who uses it |
|---|---|---|
| `clawops-agent` | `ec2:Describe*`, `cloudwatch:Get*` | The agent, always |
| `clawops-broker` | `sts:AssumeRole` on the elevated role, nothing else | The broker process |
| `clawops-elevated` | `ec2:TerminateInstances`, `ec2:StopInstances` | Nobody by default |

`clawops-elevated` has a trust policy naming only `clawops-broker`. The agent is
not on that list, so if it discovers the role's ARN and tries to assume it, AWS
refuses. Not because of a check we wrote — because the trust policy doesn't name it.

```mermaid
flowchart LR
    AGENT["clawops-agent<br/>read only"]
    BROKER["clawops-broker<br/>AssumeRole on elevated only"]
    ELEV["clawops-elevated<br/>terminate, stop"]
    TEMP["Temporary session<br/>role permissions<br/>intersected with<br/>session policy"]

    BROKER -->|"named in trust policy"| ELEV
    AGENT -.->|"refused by AWS"| ELEV
    ELEV --> TEMP
    TEMP -->|"one action, one ARN, 900s"| AGENT
```

The session policy passed at mint time can only *narrow*. Credentials can do the
overlap between what the role allows and what the policy allows, so there is no
way to request more than the role already had. 900 seconds is the AWS floor for
`AssumeRole`, not a number we picked.

---

## The flow

```mermaid
sequenceDiagram
    autonumber
    actor ENG as Engineer in Slack
    participant AG as ClawOps agent
    participant BR as Broker
    participant A0 as Auth0
    actor PH as Approver phone
    participant AWS as AWS STS / EC2

    AG->>AWS: DescribeInstances, GetMetricData
    AWS-->>AG: 4.2% CPU over 72h
    AG->>ENG: proposes terminating i-0a81a747
    ENG->>AG: go ahead
    AG->>BR: request-action
    BR->>BR: validate action against allowlist<br/>validate instance id against regex<br/>map Slack user to Auth0 user
    BR->>A0: CIBA backchannel authorize
    A0->>PH: push notification
    PH->>A0: approve with biometric
    A0-->>BR: id_token with verified sub
    BR->>AWS: AssumeRole, session policy,<br/>RoleSessionName carries the approver
    AWS-->>BR: temporary credentials
    BR-->>AG: credentials, expires in 15 min
    AG->>AWS: TerminateInstances with those credentials
    Note over AWS: CloudTrail records the session name,<br/>so the approver is in AWS's own log
```

### Why the broker exists

Auth0 cannot mint AWS credentials — only STS can, and something has to call it.
If the agent made that call, the agent would choose its own session policy and
would simply ask for everything. The broker exists because the narrowing has to
be written by something that isn't the agent.

The broker treats everything the agent sends as untrusted:

- the action must be in a fixed allowlist — anything else is rejected before Auth0 is ever contacted
- the instance ID must match `^i-[0-9a-f]{8,17}$`
- the elevated role ARN is hardcoded in the broker; the agent never names a role

So a compromised agent cannot escalate, and cannot even cause a phone to ring for
an action outside the allowlist.

### Why CIBA rather than a Slack button

A Slack button click proves a request came from Slack. It does not prove who
clicked it — a hijacked session approves its own requests. Auth0's Client-Initiated
Backchannel Authentication sends the approval to a separate enrolled device, where
it's confirmed with biometrics, and returns a verified identity.

That identity goes into `RoleSessionName`, which means CloudTrail — a log we cannot
edit — records a named human behind every infrastructure change. The audit trail
isn't something we built; it falls out of the design.

---

## Surfaces and providers

The design has two seams. Only one implementation exists behind each today, and
this section is about where the others would slot in — not a claim that they work.

### Where the conversation happens

The broker exposes `POST /request-action` and takes plain JSON. It contains no
Slack code and imports no Slack library. The only Slack-shaped thing anywhere near
it is `APPROVER_MAP`, a lookup from a chat platform's user ID to an Auth0 user ID.

So moving to Microsoft Teams, Discord, a web console, a CLI, or a ticket comment
means writing an adapter that calls one HTTP endpoint and re-keying that map. The
security model doesn't change at all, because the approval never travelled through
the chat platform in the first place — it went to a phone.

That's the useful property. In a design where a chat button is the approval, every
new surface is a new trust problem: you have to reason about who can click in
Teams, how that platform signs its requests, whether a compromised account can
approve its own request. Here the chat surface is only where the *asking* happens.
Whichever one you bolt on, the human still confirms on an enrolled device with
biometrics, and the identity that reaches CloudTrail comes from Auth0 rather than
from the chat platform.

**Implemented:** Slack, via NanoClaw.
**Not implemented:** everything else. The endpoint is ready for them; no adapters
are written.

### Which cloud

`providers/interface.ts` defines a `CloudProvider` seam for reading metrics and
describing instances, and `providers/aws.ts` is the only implementation.

Minting is the harder half, and worth being precise about, because the pattern
transfers but the primitives genuinely differ:

| | Narrowing primitive | Notes |
|---|---|---|
| **AWS** | `AssumeRole` with an inline session policy | Implemented. One call narrows to a single action on a single ARN. Minimum lifetime 15 minutes. |
| **GCP** | Service account impersonation, optionally with a credential access boundary | Impersonation with a short lifetime is straightforward; boundary-based downscoping has historically been limited in which services it covers, so per-resource narrowing may need a dedicated service account per scope instead. |
| **Azure** | Time-bound role assignment at a resource scope; Entra PIM for just-in-time elevation | PIM is arguably the closest existing product to what this project does, including its own approval step — the interesting version on Azure is driving PIM activation from the agent rather than reimplementing it. |

The broker would grow a `mint(plan)` per provider behind a common interface. The
validation, approval and ledger paths above it are provider-agnostic already.

**Implemented:** AWS (EC2, CloudWatch, STS).
**Not implemented:** GCP and Azure. The read interface exists; no minting code does.

---

## What is actually built

- Read-only monitoring of EC2 instances via CloudWatch, running inside NanoClaw
- Slack as the conversation surface, two-way
- The broker: validation, CIBA approval, scoped STS minting, SQLite plan ledger
- The three IAM identities and the trust policy that enforces the separation
- Terminate and stop, end to end, with human approval on a phone

## What is not

- Carbon estimation. The idea is in the roadmap below; none of it ships.
- GCP and Azure. The read interface exists; no minting code does. See above.
- Teams, Discord, or any surface other than Slack. The broker endpoint is
  surface-agnostic, but no adapter is written.
- Instance creation, baselines, automatic expiry sweeps, SSM investigation.
- Terraform for the IAM setup. Created via CLI; see `docs/iam-setup.md`.

---

## Known limitations

**The Slack-to-broker path is currently broken.** The agent proposing an action in
Slack and the broker minting credentials both work, and both are captured above,
but they are not passing to each other in the current deployment — the broker moved
onto EC2 and picked up the instance profile instead of the broker identity the
elevated role's trust policy names. Fixing it means either naming the instance role
in the trust policy or passing the broker's credentials explicitly, and the second
is what keeps the broker's identity distinct from the agent's. That distinction is
the project, so it's worth doing properly rather than quickly.

**Rich Authorization Requests are registered but unused.** The Auth0 Guardian push
renderer rejects custom `authorization_details` schemas, so the phone prompt cannot
currently display the instance ID as structured consent data. The `binding_message`
carries the action and instance instead, which is weaker but readable. Resolving
this needs either a Guardian-compatible schema or a custom notification channel.

**The API's application access policy is relaxed.** `require_client_grant` is the
correct production setting. It is set to allow-all here so the demo works on a
throwaway tenant.

**The broker holds a long-lived AWS key.** It can do nothing except assume one
role, but it is still a standing credential. The correct next step is
`AssumeRoleWithWebIdentity` with Auth0 registered as an IAM OIDC provider — then
the approval token *is* the credential and the broker holds nothing at all. That
requires an OIDC provider registration and a federated trust policy, which is the
first thing we'd build next.

**Read is not harmless.** Logs contain customer data. "It can only read" is a
weaker promise in a bank than it sounds, and the read-only role needs its own
scoping story rather than a wave-through.

**We moved the power, we did not delete it.** The broker can still mint dangerous
credentials. The window shrank from always-on to fifteen minutes with a human in
it, which is a real improvement, but worth saying plainly.

**The Auth0 tenant is on a trial.** CIBA and RAR require an Enterprise plan or
add-on. Anyone cloning this will need their own entitled tenant.

---

## Running it

Requires an AWS account, a Slack workspace, and an Auth0 tenant with CIBA enabled.

```bash
npm install
```

### AWS

Create the two users and the role as described in `docs/iam-setup.md`. Confirm the
separation actually holds before going further:

```bash
# should fail — this is the point of the project
aws sts assume-role \
  --role-arn arn:aws:iam::ACCOUNT:role/clawops-elevated \
  --role-session-name test --profile clawops-agent
```

### Auth0

1. Create a Regular Web Application. Settings → Advanced → Grant Types → enable
   Client Initiated Backchannel Authentication.
2. Reload, then choose Guardian push as the notification channel.
3. Create an API with identifier `https://clawops/api`.
4. On that API, set the User Consent Policy to a non-MFA option — CIBA is refused
   on audiences using transactional authorization with MFA, because Guardian is
   already performing the MFA step.
5. Create a user for each approver and enrol their phone in Guardian.

### Configure

`.broker.env` — never `.env`, which is not git-ignored:

```
AUTH0_DOMAIN=your-tenant.us.auth0.com
AUTH0_CLIENT_ID=
AUTH0_CLIENT_SECRET=
AWS_ACCOUNT_ID=
AWS_REGION=me-central-1
APPROVER_MAP={"SLACK_USER_ID":"auth0|AUTH0_USER_ID"}
```

`APPROVER_MAP` decides whose phone rings. It does not decide the outcome — the
approver still has to tap. A lying agent can at most route a push to a real
approver, who then denies it.

### Run

```bash
AWS_PROFILE=clawops-broker node src/broker/server.ts
```

```bash
curl -X POST localhost:3001/request-action \
  -H 'Content-Type: application/json' \
  -d '{"action":"ec2:TerminateInstances","instanceId":"i-...","reason":"idle 3 days","requestedBy":"SLACK_USER_ID"}'
```

The request blocks until you approve or deny on your phone, then returns scoped
credentials or a refusal.

---

## Proving the credentials are narrow

With the returned credentials exported:

```bash
# the approved instance — permitted
aws ec2 terminate-instances --instance-ids i-APPROVED --dry-run

# any other instance — denied
aws ec2 terminate-instances --instance-ids i-OTHER --dry-run

# reading — also denied; the elevated role has no read permission
aws ec2 describe-instances
```

---

## Roadmap

Nearest first:

1. `AssumeRoleWithWebIdentity` so the broker holds no standing AWS credential
2. Guardian-compatible RAR so the phone shows structured consent data
3. Precondition re-check at mint time — the world moves while someone finds their phone
4. Instance creation, with scope by shape rather than by ARN
5. Expiry sweep that reclaims instances past their TTL through the same broker
6. Carbon estimation per instance, using real VM power draw rather than
   whole-server figures — a shared vCPU is closer to 5–15W than the 180W a
   physical host draws

## Stack

TypeScript, NanoClaw, Claude Agent SDK, Slack, Auth0 (CIBA), AWS SDK v3, SQLite, Express.
