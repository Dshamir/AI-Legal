# SMS Scaling Options — From 1 SIM to 10,000 Numbers

## Current Setup

- **Hardware:** Sierra MC7700 LTE Mini PCI-E modem
- **SIM:** +1 438 829 9035 (dedicated internet/SMS line)
- **Software:** gammu-smsd on MARS server
- **Capacity:** 1 number, send + receive, your own apps only
- **Cost:** $0/mo (existing SIM plan)

---

## Why 1 SIM = 1 Number (No 10:1 on Physical SIMs)

A SIM card is a 1:1 binding to a phone number at the carrier level. The carrier will not route SMS destined for number #2 to SIM #1. This is hardcoded in the mobile network (HLR/VLR lookup).

128 SIMs = 128 numbers. Always. No exceptions with physical hardware.

To get more numbers than physical lines, you must use virtual numbers (DIDs) or carrier-level number blocks.

---

## Scaling Tiers

### Tier 0: Current (Your Apps Only)

```
Sierra MC7700 + 1 SIM
├── Send OTP to your users
├── Receive/intercept OTP from Facebook, Instagram, Google, etc.
└── All Nexless apps share this one number
```

| Metric         | Value                                 |
| -------------- | ------------------------------------- |
| Numbers        | 1                                     |
| Clients served | You (all your apps)                   |
| Monthly cost   | $0                                    |
| Hardware       | Sierra MC7700 (already owned)         |
| Reliability    | Single modem, single point of failure |

---

### Tier 1: SIM Bank (10-128 Clients)

Physical device holding multiple SIM cards, each with its own number. REST API for send/receive.

**Hardware options:**

| Device                 | SIM Slots | Price        | API                   | SMS Throughput        |
| ---------------------- | --------- | ------------ | --------------------- | --------------------- |
| SMSEagle NXS-9750-4G   | 2 modems  | ~$400        | REST + SMTP + webhook | ~120 SMS/hr per modem |
| SMSEagle MHD-8100-4G   | 8 modems  | ~$1,200      | REST + SMTP + webhook | ~960 SMS/hr total     |
| Dinstar UC2000-VE      | 4-32 SIMs | $300-1,200   | SIP + HTTP            | ~240-1,920 SMS/hr     |
| GoIP-32                | 32 SIMs   | $500-800     | SIP + HTTP            | ~1,920 SMS/hr         |
| Dinstar UC2000-VF-128G | 128 SIMs  | $1,500-2,000 | SIP + HTTP            | ~7,680 SMS/hr         |

**How it works:**

```
SIM Bank (e.g., Dinstar 32-slot)
├── SIM 1:  +1-438-XXX-0001 → assigned to Client A
├── SIM 2:  +1-438-XXX-0002 → assigned to Client B
├── SIM 3:  +1-438-XXX-0003 → assigned to Client C
├── ...
├── SIM 32: +1-438-XXX-0032 → assigned to Client AF
└── All incoming SMS → SIM Bank API → MARS OTP interceptor → route to client
```

**Per-client SIM cost (Canada):**

- Prepaid data+SMS SIM: $10-15/mo per SIM (Fido, Koodo, Public Mobile)
- 128 SIMs × $10/mo = $1,280/mo in carrier fees alone
- Alternative: IoT/M2M SIM plans from carriers — $2-5/mo per SIM for SMS-only

| Metric         | Value                                    |
| -------------- | ---------------------------------------- |
| Numbers        | 4-128 (one per SIM)                      |
| Clients served | 4-128 (1:1 assignment)                   |
| Monthly cost   | $40-640 (SIM plans) + hardware amortized |
| Setup cost     | $300-2,000 (hardware)                    |
| Reliability    | Multiple modems, redundant               |
| Scaling limit  | Hardware slot count                      |

**Pros:** Full carrier-native numbers, no cloud dependency, works in remote areas, you own everything
**Cons:** Linear cost scaling (1 SIM per client), hardware maintenance, SIM management overhead, carrier contracts

---

### Tier 2: Number Pooling on SIM Bank (128 SIMs → ~1,280 Clients)

Use time-multiplexing to serve more clients than you have SIMs. OTP codes expire in 5 minutes — a number only needs to be "assigned" during the interception window.

**How it works:**

```
128 SIM numbers in a pool (all active, all receiving SMS)

Client A needs Facebook OTP:
  1. MARS assigns number #37 to Client A (5-min lease)
  2. Client A's Facebook 2FA is set to number #37
  3. Facebook sends OTP → SIM #37 receives it
  4. MARS intercepts → delivers to Client A
  5. Lease expires → number #37 returns to pool

Concurrency math:
  128 numbers × (60 min ÷ 5 min lease) = 1,536 OTP slots/hour
  At 10% peak concurrency = ~1,280 clients on 128 numbers
```

**Critical limitation:** Client must update their 2FA phone number to the assigned pool number. This works IF:

- The 2FA service allows programmatic number changes (APIs)
- The client pre-registers multiple numbers
- The assignment is sticky (same client always gets same number)

**In practice:** Sticky assignment is more realistic — each client gets a semi-permanent number, reassigned only when they churn. True time-multiplexing is fragile.

| Metric         | Value                                    |
| -------------- | ---------------------------------------- |
| Numbers        | 128 physical                             |
| Clients served | ~500-1,280 (with churn-based reuse)      |
| Monthly cost   | $640-1,280 (SIM plans)                   |
| Complexity     | High (pool management, assignment logic) |

**Verdict:** Theoretically possible but operationally complex. Better to go cloud at this scale.

---

### Tier 3: Cloud SMS API (50-5,000 Clients)

No hardware. Provision virtual phone numbers via API. All SMS received via webhook.

**Provider comparison:**

| Provider           | Number Cost | Inbound SMS | Outbound SMS | Webhook | Best For                                 |
| ------------------ | ----------- | ----------- | ------------ | ------- | ---------------------------------------- |
| **Telnyx**         | $1.00/mo    | $0.004/msg  | $0.004/msg   | Yes     | Best price, developer-friendly           |
| **Twilio**         | $1.15/mo    | $0.0079/msg | $0.0079/msg  | Yes     | Most documentation, largest ecosystem    |
| **Bandwidth**      | $1.00/mo    | $0.004/msg  | $0.004/msg   | Yes     | Own carrier network (US), lowest latency |
| **SignalWire**     | $1.00/mo    | $0.005/msg  | $0.005/msg   | Yes     | Twilio-compatible API, cheaper           |
| **Vonage (Nexmo)** | $1.00/mo    | $0.005/msg  | $0.005/msg   | Yes     | Strong international coverage            |
| **Plivo**          | $0.80/mo    | $0.005/msg  | $0.005/msg   | Yes     | Cheapest numbers                         |
| **Sinch**          | Varies      | $0.005/msg  | $0.005/msg   | Yes     | Own carrier in some regions              |

**How it works:**

```
Client signs up
  → MARS calls Telnyx API: provision new number
  → Telnyx assigns +1-438-XXX-XXXX (Canadian number)
  → Webhook configured: all SMS to this number → POST https://mars.tcp.ngrok.io/webhook/sms
  → Client uses this number for their 2FA services

Incoming SMS arrives
  → Telnyx receives at carrier level
  → Telnyx POSTs to your webhook: { from: "FACEBK", to: "+14385551234", text: "Code: 847291" }
  → MARS OTP interceptor parses and stores
  → Client queries: mars.otp.getInterceptedCode({ source: "facebook" })
```

**Provisioning code (Telnyx example):**

```typescript
import telnyx from "telnyx";

// Search for available Canadian numbers
const available = await telnyx.availablePhoneNumbers.list({
  filter: { country_code: "CA", state: "QC", features: ["sms"] },
  page: { size: 10 },
});

// Buy a number
const ordered = await telnyx.numberOrders.create({
  phone_numbers: [{ phone_number: available.data[0].phone_number }],
  messaging_profile_id: MESSAGING_PROFILE_ID,
});

// Messaging profile has webhook URL pre-configured:
// POST https://mars.tcp.ngrok.io/webhook/telnyx
// All incoming SMS to any number in this profile → your webhook
```

**Cost at scale:**

| Clients | Numbers | Number Cost | SMS Cost (~50 SMS/client/mo) | Total/mo |
| ------- | ------- | ----------- | ---------------------------- | -------- |
| 50      | 50      | $50         | $10                          | ~$60     |
| 100     | 100     | $100        | $20                          | ~$120    |
| 500     | 500     | $500        | $100                         | ~$600    |
| 1,000   | 1,000   | $1,000      | $200                         | ~$1,200  |
| 5,000   | 5,000   | $5,000      | $1,000                       | ~$6,000  |

| Metric         | Value                                    |
| -------------- | ---------------------------------------- |
| Numbers        | Unlimited (API-provisioned)              |
| Clients served | Unlimited                                |
| Monthly cost   | $1/number + $0.004-0.008/SMS             |
| Setup cost     | $0 (no hardware)                         |
| Reliability    | Carrier-grade (Telnyx/Twilio SLA 99.95%) |
| Scaling limit  | Budget only                              |

**Pros:** Instant provisioning, no hardware, carrier-grade reliability, global coverage, API-first
**Cons:** Recurring per-number cost, dependent on cloud provider, SMS costs add up at volume

---

### Tier 4: Carrier Number Blocks / Micro-MVNO (1,000-100,000 Numbers)

Buy number blocks directly from carriers or wholesale aggregators. No per-number provisioning — you get a block and manage routing yourself.

**Providers that sell number blocks:**

| Provider      | Type                          | Min Block   | Cost/Number   | Notes                                |
| ------------- | ----------------------------- | ----------- | ------------- | ------------------------------------ |
| **Bandwidth** | Owns network (US)             | 100 numbers | $0.35-0.50/mo | Direct carrier, lowest cost at scale |
| **Telnyx**    | Reseller + own network        | 50 numbers  | $0.50-0.75/mo | Volume discounts available           |
| **Sinch**     | Owns network (Sweden, others) | 100 numbers | Negotiated    | Strong in Europe                     |
| **Commio**    | Wholesale aggregator          | 100 numbers | $0.25-0.40/mo | White-label ready                    |
| **QuestBlue** | Wholesale                     | 100 numbers | $0.30-0.50/mo | US/Canada focus                      |

**How it works:**

```
Buy block: +1-438-800-0000 through +1-438-800-0999 (1,000 numbers)
  → All SMS to this range routes to your SMPP/HTTP endpoint
  → You manage assignment: Client A → +1-438-800-0042
  → No per-number provisioning API calls
  → Routing is at the carrier switching level (SS7/SMPP)
```

**SMPP (Short Message Peer-to-Peer) connection:**

```
Your Server (MARS)
  ↕ SMPP connection (persistent TCP session)
Carrier SMSC (Short Message Service Center)
  → All inbound SMS for your number block delivered via SMPP
  → Outbound SMS submitted via SMPP
  → No HTTP/webhook — raw telecom protocol
```

Node.js SMPP library: `smpp` npm package

```typescript
import smpp from "smpp";

const session = smpp.connect({ url: "smpp://smsc.carrier.com:2775" });
session.bind_transceiver({
  system_id: "YOUR_ID",
  password: "YOUR_PASS",
});

// Receive incoming SMS
session.on("deliver_sm", (pdu) => {
  const from = pdu.source_addr; // "FACEBK"
  const to = pdu.destination_addr; // "+14388000042"
  const text = pdu.short_message.message; // "Your code is 847291"

  // Route to the client who owns +14388000042
  interceptOTP(from, to, text);
});
```

| Metric         | Value                          |
| -------------- | ------------------------------ |
| Numbers        | 1,000-100,000 (block purchase) |
| Clients served | Same as numbers                |
| Monthly cost   | $0.25-0.50/number (volume)     |
| Setup cost     | SMPP integration (~2 days dev) |
| Reliability    | Carrier-grade                  |
| Scaling limit  | Carrier capacity               |

**Pros:** Cheapest per-number at scale, direct carrier relationship, full control
**Cons:** SMPP integration complexity, minimum block sizes, carrier contracts, setup time

---

### Tier 5: Full MVNO (Enterprise/Telco Scale)

Become a Mobile Virtual Network Operator. You lease network capacity from a carrier (Bell, Rogers, Telus in Canada) and issue your own SIMs.

**Not relevant for your use case.** This is for companies like Twilio themselves. Requires regulatory licensing, millions in capital, and carrier agreements. Mentioned only for completeness.

---

## MARS Integration — All Tiers Feed the Same Pipe

Regardless of which tier you use, the architecture is identical:

```
                    ┌─────────────────────────┐
                    │   MARS OTP Interceptor   │
                    │                         │
                    │  otp.intercepted_codes   │
                    │  table (same for all)    │
                    └────────┬────────────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
         gammu-smsd     Telnyx webhook   SMPP listener
         (Sierra        (cloud DIDs)    (number blocks)
          MC7700)
              │              │              │
         Tier 0-1        Tier 3          Tier 4
         (your SIM)      (cloud API)     (carrier block)
```

Adding a new tier = adding a new inbound route. The interceptor, code parser, client API, and MCP tools stay identical.

**Client code never changes:**

```typescript
// Same call whether SMS came from Sierra MC7700, Telnyx webhook, or SMPP
const code = await mars.otp.getInterceptedCode({ source: "facebook" });
```

---

## Recommended Scaling Path

```
NOW         You only (Tier 0)
            Sierra MC7700 + 1 SIM
            $0/mo
                │
                ▼
FIRST 50    Cloud API (Tier 3)
CLIENTS     Add Telnyx alongside Sierra MC7700
            $50-60/mo
            Half a day to integrate webhook
                │
                ▼
500+        Volume numbers (Tier 3 bulk)
CLIENTS     Telnyx volume pricing
            $300-500/mo
            No code changes
                │
                ▼
2,000+      Number blocks (Tier 4)
CLIENTS     Bandwidth/Commio SMPP
            $500-1,000/mo
            ~2 days SMPP integration
                │
                ▼
10,000+     Multiple carriers (Tier 4 multi)
CLIENTS     Redundant SMPP connections
            Negotiate volume rates
            $2,500-5,000/mo
```

**Key principle:** Start with what you have (Sierra MC7700). Add Telnyx when the first paying client shows up. The MARS architecture doesn't need to change — just add webhook handlers.

---

## Hardware You Already Own

| Device                          | Best Use                                | Use It?                                  |
| ------------------------------- | --------------------------------------- | ---------------------------------------- |
| **Sierra MC7700 (Mini PCI-E)**  | MARS server SMS gateway — your own apps | YES — install on MARS, Tier 0            |
| **EM7455/DW5811e (NGFF/M.2)**   | Spare/backup modem                      | KEEP as backup for Sierra                |
| **Waveshare ESP32-S3 SIM7670G** | IoT prototyping, field SMS relay        | SKIP for now — wrong tool for server use |

---

## Cost Comparison Summary

| Tier             | Numbers      | Setup Cost   | Monthly Cost      | Clients    | Complexity |
| ---------------- | ------------ | ------------ | ----------------- | ---------- | ---------- |
| 0: Sierra MC7700 | 1            | $0 (owned)   | $0                | Your apps  | None       |
| 1: SIM Bank      | 4-128        | $300-2,000   | $40-1,280         | 4-128      | Low        |
| 2: Number Pool   | 128 physical | $1,500-2,000 | $640-1,280        | ~500-1,280 | High       |
| 3: Cloud API     | Unlimited    | $0           | $1/number         | Unlimited  | Low        |
| 4: Number Blocks | 1,000+       | $0           | $0.25-0.50/number | 1,000+     | Medium     |
| 5: MVNO          | Unlimited    | $$$$         | Negotiated        | Unlimited  | Extreme    |

**The sweet spot for a bootstrapped service:** Tier 0 (now) → Tier 3 Telnyx (first clients) → Tier 4 Bandwidth (at scale). Skip the SIM bank entirely unless you need carrier-native numbers in regions where cloud providers don't operate.

---

## SMS Termination — SIP SMS to SIM SMS

### The Concept

SMS Termination is the act of taking an SMS from the IP realm (your apps, APIs, SIP trunks) and delivering it through a physical SIM card into the carrier/cellular network as a **real carrier-native message**.

The recipient's phone — and critically, the recipient's carrier and any fraud/VoIP detection systems — sees a genuine P2P (person-to-person) carrier-originated SMS, not a cloud/A2P (application-to-person) message.

```
IP REALM                              CELLULAR REALM
(apps, APIs, SIP trunks)              (carrier networks, real phones)

App/Client sends SMS                  Recipient receives REAL carrier SMS
via API or SIP MESSAGE                (indistinguishable from a normal text)
        │                                         ▲
        ▼                                         │
   ┌──────────────────────┐                 Carrier network
   │  SMS TERMINATION     │                 (Bell, Rogers, Telus)
   │  GATEWAY             │                       ▲
   │                      │                       │
   │  Input:  HTTP API    │                 Physical SIM sends
   │          SIP MESSAGE │                 real GSM SMS via
   │          MCP tool    │                 AT commands
   │                      │                       ▲
   │  Output: SIM card ───┼───────────────────────┘
   │          → carrier   │
   └──────────────────────┘
```

### Why Terminate Through SIMs Instead of Cloud APIs

|                           | Cloud SMS (Telnyx/Twilio A2P)       | SIM-Terminated SMS (P2P)                            |
| ------------------------- | ----------------------------------- | --------------------------------------------------- |
| **Route type**            | Application-to-Person (A2P)         | Person-to-Person (P2P)                              |
| **Sender identity**       | Cloud/VoIP number (flagged as A2P)  | Real carrier number (looks like a normal person)    |
| **Deliverability**        | 95-98% (A2P filters can block)      | 99%+ (carrier-native, trusted path)                 |
| **VoIP detection**        | Detectable by Facebook, banks, etc. | Undetectable — it IS a real SIM                     |
| **Cost per SMS**          | $0.004-0.008 (API pricing)          | ~$0.01-0.03 (SIM plan SMS allowance)                |
| **Throughput per number** | Unlimited (API)                     | ~60 SMS/hr per SIM (carrier throttling)             |
| **Trust level**           | Medium (A2P reputation systems)     | High (no reputation needed, P2P trusted by default) |
| **2FA acceptance**        | Some services block VoIP numbers    | All services accept carrier SIMs                    |
| **Regulatory**            | Registered A2P, compliant           | Gray area in some jurisdictions for bulk            |

### When You NEED SIM Termination

1. **Services that block VoIP numbers** — Facebook, Instagram, WhatsApp, banks reject A2P/cloud numbers for 2FA
2. **High deliverability requirements** — carrier-native P2P SMS has ~99%+ delivery vs 95-98% for A2P
3. **Markets without cloud SMS coverage** — regions where Telnyx/Twilio don't have carrier agreements
4. **Cost arbitrage** — in some markets, SIM plan SMS is cheaper than API pricing at volume
5. **Anti-fingerprinting** — the message must appear to originate from a real person's phone

### SMS Termination Gateway Hardware

These devices accept SMS via HTTP API or SIP MESSAGE protocol and send it out through physical SIM cards:

| Device                     | SIMs | Input Protocol          | Output        | Throughput | Price      |
| -------------------------- | ---- | ----------------------- | ------------- | ---------- | ---------- |
| **Sierra MC7700** (yours)  | 1    | gammu CLI / AT commands | SIM → carrier | ~60/hr     | $0 (owned) |
| **SMSEagle NXS-9750**      | 2    | HTTP REST API           | SIM → carrier | ~120/hr    | ~$400      |
| **SMSEagle MHD-8100**      | 8    | HTTP REST API           | SIM → carrier | ~480/hr    | ~$1,200    |
| **Ejoin ACOM-532**         | 32   | HTTP API                | SIM → carrier | ~1,920/hr  | ~$600      |
| **GoIP-32**                | 32   | SIP MESSAGE + HTTP      | SIM → carrier | ~1,920/hr  | ~$800      |
| **Dinstar UC2000-VE-32**   | 32   | SIP MESSAGE + HTTP      | SIM → carrier | ~1,920/hr  | ~$1,200    |
| **Dinstar UC2000-VF-128G** | 128  | SIP MESSAGE + HTTP      | SIM → carrier | ~7,680/hr  | ~$2,000    |

### Bidirectional — Termination + Origination (Same Hardware)

The same gateway handles both directions through the same SIMs:

```
OUTBOUND — SMS Termination (IP → Cellular):
  Your app → MARS API → SIM gateway → carrier network → recipient's phone
  Use case: Send OTP codes, notifications, alerts as real carrier SMS

INBOUND — SMS Origination (Cellular → IP):
  Facebook sends OTP → carrier network → SIM gateway → MARS interceptor → your app
  Use case: Intercept 2FA codes from Facebook, Instagram, Google, banks
```

Same hardware, same SIMs, both directions. This is what makes the Sierra MC7700 + GoIP combo powerful — terminate outbound AND originate (intercept) inbound through the same physical SIMs.

### Architecture on MARS

```
MARS Server
│
├── Inbound (IP realm — apps send SMS requests):
│   ├── HTTP API:    POST /sms/send { to: "+15551234567", text: "Hello" }
│   ├── SIP MESSAGE: from Telnyx SIP trunk
│   ├── MCP tool:    notify.sms("+15551234567", "Hello")
│   └── Client SDK:  mars.notify.sms("+15551234567", "Hello")
│
├── SMS Termination Router (decides which SIM sends):
│   ├── Round-robin:  spread across all available SIMs
│   ├── Geographic:   Montreal SIM (438/514) for local numbers
│   ├── Load-balanced: least-used SIM first
│   ├── Dedicated:    Client A always uses SIM #7
│   └── Carrier-match: Rogers SIM for Rogers recipients (best deliverability)
│
├── SIM Gateway (exits IP realm → enters cellular realm):
│   ├── Sierra MC7700 (SIM 1)  → sends via Bell
│   ├── GoIP slot 2  (SIM 2)  → sends via Rogers
│   ├── GoIP slot 3  (SIM 3)  → sends via Telus
│   ├── GoIP slot 4  (SIM 4)  → sends via Fido
│   ├── GoIP slot 5  (SIM 5)  → sends via Koodo
│   └── ... (up to 128+ SIMs)
│
├── Carrier Network (cellular realm):
│   └── SMS delivered as real P2P carrier message
│
└── Recipient receives SMS
    └── No VoIP flag, no A2P filter, real carrier-native message
```

### Hybrid Architecture — Cloud + SIM Termination

The most flexible setup uses cloud SMS for general traffic and SIM termination only when needed:

```
MARS SMS Router
│
├── Is recipient's service known to block VoIP?
│   ├── YES (Facebook, Instagram, banks)
│   │   └── Route through SIM gateway (P2P termination)
│   └── NO (general SMS, your own OTP sending)
│       └── Route through Telnyx API (A2P, cheaper, faster)
│
├── Is deliverability critical?
│   ├── YES → SIM termination
│   └── NO  → Cloud API
│
└── Decision table:
    ┌────────────────────┬──────────────────┬─────────────────┐
    │ Use Case           │ Route            │ Why             │
    ├────────────────────┼──────────────────┼─────────────────┤
    │ Your app OTP send  │ Cloud API        │ Fast, cheap     │
    │ Client OTP send    │ Cloud API        │ Scalable        │
    │ Facebook 2FA       │ SIM termination  │ VoIP blocked    │
    │ Bank verification  │ SIM termination  │ VoIP blocked    │
    │ Instagram 2FA      │ SIM termination  │ VoIP blocked    │
    │ High-value alerts  │ SIM termination  │ 99%+ delivery   │
    │ Marketing SMS      │ Cloud API (A2P)  │ Compliant       │
    └────────────────────┴──────────────────┴─────────────────┘
```

### Scaling SMS Termination Throughput

```
Setup                        Outbound Capacity         Daily Volume
─────                        ─────────────────         ────────────
1 Sierra MC7700              60 SMS/hr                 ~1,440/day
+ GoIP-32                    1,980 SMS/hr              ~47,520/day
+ Second GoIP-32             3,900 SMS/hr              ~93,600/day
+ Dinstar 128-slot           7,740 SMS/hr              ~185,760/day
+ Second Dinstar 128         15,420 SMS/hr             ~370,000/day

At 370K SMS/day, you're running a real SMS termination business.
```

### SIM Rotation and Carrier Throttling

Carriers detect SIM farms if one SIM sends too many SMS. Mitigation strategies:

**Per-SIM Limits:**

- Stay under 60 SMS/hr per SIM (carrier fair-use threshold)
- Vary message content (no identical blasts through one SIM)
- Mix outbound and inbound traffic (looks like a real user)

**Multi-Carrier Distribution:**

```
32-SIM GoIP distribution example:
├── 8 SIMs on Bell      (different rate plans)
├── 8 SIMs on Rogers    (different rate plans)
├── 8 SIMs on Telus     (different rate plans)
├── 4 SIMs on Fido      (prepaid)
└── 4 SIMs on Koodo     (prepaid)

If Bell throttles → Rogers/Telus SIMs pick up slack
No single carrier sees more than 480 SMS/hr from your SIMs
```

**SIM Rotation Scheduler:**

```
Every SIM gets a daily "rest window":
  SIM 1-8:   active 00:00-18:00, rest 18:00-24:00
  SIM 9-16:  active 06:00-24:00, rest 00:00-06:00
  SIM 17-24: active 00:00-12:00 + 18:00-24:00, rest 12:00-18:00
  SIM 25-32: active 03:00-21:00, rest 21:00-03:00

This mimics human usage patterns — no SIM is active 24/7.
```

**IMEI Rotation:**

- Some carriers fingerprint by IMEI (device ID) not just SIM
- GoIP/Dinstar gateways support IMEI randomization
- Configure unique IMEI per SIM slot

### The Business Model

```
SMS Termination as a Service:

Client pays you:       $0.04-0.08/SMS  (SIM-terminated, P2P grade)
Your SIM cost:         $0.01-0.02/SMS  (carrier plan allowance)
Your margin:           $0.03-0.06/SMS

Volume scenarios:
┌─────────────────┬──────────┬──────────┬──────────┬───────────┐
│ Daily Volume     │ Revenue  │ SIM Cost │ Margin   │ Monthly   │
├─────────────────┼──────────┼──────────┼──────────┼───────────┤
│ 1,000 SMS/day   │ $50/day  │ $15/day  │ $35/day  │ ~$1,050   │
│ 10,000 SMS/day  │ $500/day │ $150/day │ $350/day │ ~$10,500  │
│ 50,000 SMS/day  │ $2.5K/day│ $750/day │ $1.75K   │ ~$52,500  │
│ 100,000 SMS/day │ $5K/day  │ $1.5K   │ $3.5K    │ ~$105,000 │
└─────────────────┴──────────┴──────────┴──────────┴───────────┘

Hardware amortization:
  GoIP-32 ($800) pays for itself in ~23 days at 1,000 SMS/day
  Dinstar 128 ($2,000) pays for itself in ~6 days at 10,000 SMS/day
```

### Regulatory Considerations

| Jurisdiction      | P2P SMS Termination Status                                                                                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Canada (CRTC)** | Legal for personal use. Commercial bulk P2P is gray area — CASL (anti-spam law) applies to commercial messages regardless of route. OTP/transactional messages are exempt from CASL consent requirements. |
| **USA (FCC)**     | TCPA applies. A2P via P2P route ("grey routing") is actively fought by carriers. 10DLC registration now required for most A2P traffic. OTP/2FA is generally exempt.                                       |
| **EU (GDPR)**     | Content rules apply regardless of delivery route. Consent required for marketing. OTP/transactional exempt.                                                                                               |
| **General**       | Using SIM termination for your own apps' OTP and transactional messages = no issue. Reselling SIM-terminated bulk marketing SMS = check local regulations.                                                |

**Safe uses (no regulatory concern):**

- Your own apps sending OTP codes
- Your own apps sending transactional notifications
- Intercepting your own 2FA codes (Facebook, Instagram for your accounts)

**Check regulations before:**

- Offering SIM-terminated SMS as a service to third parties
- Sending marketing/promotional SMS via SIM termination
- Operating in jurisdictions with strict A2P routing rules

### Telnyx Integration — Best of Both Worlds

Telnyx offers SIP trunking + cloud SMS + IoT SIMs. Combined with your SIM termination gateway:

```
Telnyx Cloud
├── Virtual numbers (1,280 DIDs, $1/mo each)
├── SIP trunk (connects to your gateway)
├── SMS API (for A2P traffic that doesn't need SIM termination)
├── Verify API (built-in OTP send+verify)
└── Number Lookup (verify recipient numbers before sending)
         │
    SIP trunk / API
         │
    MARS Server
    ├── SMS Router (decides: cloud A2P or SIM P2P?)
    ├── Telnyx API client (A2P route)
    └── SIM Gateway (P2P termination route)
         ├── Sierra MC7700 (1 SIM, your apps)
         └── GoIP-32 (32 SIMs, client service)
              │
         Carrier network → recipient
```

**Single provider (Telnyx) for:**

- Virtual number provisioning
- A2P SMS (when VoIP is fine)
- SIP trunk (feeds into your SIM gateway)
- Number lookup (validate before sending)
- Verify API (your own OTP sending)

**Your hardware for:**

- P2P SIM termination (when A2P is blocked/untrusted)
- OTP interception (inbound SMS from Facebook, etc.)
- Maximum deliverability scenarios

---

## Revised Scaling Path (With SMS Termination)

```
NOW         Tier 0 — Your apps only
            Sierra MC7700 + 1 SIM
            Send + receive + intercept
            $0/mo
                │
                ▼
FIRST       Tier 3 + Termination — First clients
CLIENTS     Telnyx cloud numbers (A2P) + Sierra MC7700 (P2P fallback)
            Cloud for general SMS, SIM for VoIP-blocked services
            $50-100/mo
                │
                ▼
50+         Tier 3 + GoIP-32 — Scale termination
CLIENTS     Telnyx (A2P) + GoIP-32 with 32 SIMs (P2P)
            Hybrid routing: cloud where accepted, SIM where needed
            $200-500/mo
                │
                ▼
500+        Tier 3 + Dinstar 128 — Full termination capacity
CLIENTS     Telnyx (A2P) + Dinstar 128-slot (P2P)
            7,680 SMS/hr termination capacity
            $1,000-2,000/mo
                │
                ▼
2,000+      Tier 4 + Multi-gateway — Carrier-scale
CLIENTS     Bandwidth number blocks (A2P) + multiple SIM gateways (P2P)
            SMPP integration + distributed SIM termination
            $3,000-5,000/mo
                │
                ▼
10,000+     Multi-carrier + multi-region
CLIENTS     Multiple Dinstar gateways across regions
            Carrier-diverse SIM distribution
            Automated SIM rotation and health monitoring
            $10,000+/mo → but revenue at $50K+/mo
```
