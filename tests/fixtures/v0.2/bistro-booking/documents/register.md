---
spec_version: "0.2"
language: en
generated_at: "2026-11-11T00:00:00Z"
open_items: 15
actions: 14
anchors:
  bistro-api: "7c1e4f9a2b6d8035e1a4c7f90b2d6e8a1c3f5b79"
  bistro-web: "9d3f6b1a4c7e0258b1d4f7a0c3e6b9d2f5a8c1e4"
---

# Compliance dossier

- Organisation: Bistro Booking Group
- Generated at: 2026-11-11T00:00:00Z

Compliance dossier of the organisation, built from its compliance repo: the organisation's identity, the actions that close the open items, then for each processing activity its records of processing (GDPR Art. 30(1)) and its DPO checks, the AI features, and what stays outside the register. The Source column says where each value comes from; `To complete` means that no source gives the value and a person has to fill it in. How this document is built: `templates/register/README.md` in the compliance-spec repository.

> Prepared for review by the controller and its data protection officer. This document does not certify compliance with the GDPR or the AI Act.

## Organisation

| Item | Value | Source |
| --- | --- | --- |
| Controller | Bistro Booking Group SAS, 12 rue des Tables, 75011 Paris, France, RCS Paris 900 000 000, privacy@bistro-booking.example | declared: compliance.yaml |
| Data protection officer | Data protection office, dpo@bistro-booking.example | declared: compliance.yaml |
| Representative (Art. 27) | To complete | — |
| Privacy contact | privacy@bistro-booking.example | declared: compliance.yaml |

## Actions

15 open items, closed by 14 actions.

| Action | Role | Open items closed | Where |
| --- | --- | --- | --- |
| `information`: State how the persons are informed (Art. 13 and 14) | Organisation | 1 | marketing-emails |
| `joint-controllers`: List the joint controllers, or state that there are none | Organisation | 1 | marketing-emails |
| `organisation-representative`: State whether a representative in the EU is required (Art. 27) | Organisation | 1 | Organisation |
| `processor-contracts`: Sign or locate the processor contracts (Art. 28) | Organisation | 1 | marketing-emails |
| `ai-classification`: Classify the AI features: role and risk level | DPO | 1 | AI features |
| `controller-rationale`: Explain why the organisation is not the controller | DPO | 1 | Outside the register |
| `dpia`: Assess whether a DPIA is required, and reference it | DPO | 1 | marketing-emails |
| `legal-basis-detail`: Document the legal basis | DPO | 1 | marketing-emails |
| `retention`: Set the retention periods | DPO | 1 | marketing-emails |
| `sensitive-data`: Assess the sensitive data (Art. 9) | DPO | 1 | marketing-emails |
| `ai-obligations`: Meet or document the AI Act obligations | Developer | 2 | AI features |
| `personal-data`: Describe the personal data and classify the unknown categories | Developer | 1 | marketing-emails |
| `security-measures`: Describe the security measures | Developer | 1 | marketing-emails |
| `transfer-safeguards`: Declare the safeguard of each transfer outside the EU | Developer | 1 | marketing-emails |

## Marketing emails (marketing-emails)

### Records of processing, GDPR Art. 30(1)

| Item | Value | Source |
| --- | --- | --- |
| (a) Controller | Bistro Booking Group, newsletter@bistro-booking.example | declared: marketing team |
| (a) Joint controller | To complete | — |
| (a) Representative | To complete | — |
| (a) Data protection officer | Data protection office, dpo@bistro-booking.example | declared: compliance.yaml |
| (b) Purposes | Send the monthly newsletter and special offers to guests who subscribed. | declared: marketing team |
| (c) Data subjects | guests who subscribed to the newsletter | declared: declared/crm/manifest.yaml (marketing team) |
| | restaurant guests | code: bistro-api@7c1e4f9:src/bookings/guest.ts |
| (c) Personal data | contact: guest email | declared: declared/crm/manifest.yaml (marketing team) |
| | contact: guest email, guest phone number | code: bistro-api@7c1e4f9:src/bookings/guest.ts |
| | identity: guest name | code: bistro-api@7c1e4f9:src/bookings/guest.ts |
| | identity: guest name | declared: declared/crm/manifest.yaml (marketing team) |
| | unknown: campaign notes (free text) | declared: declared/crm/manifest.yaml (marketing team) |
| | usage: subscription date and consent record | declared: declared/crm/manifest.yaml (marketing team) |
| (d) Recipients | BulkLetter (US): DPA no | declared: declared/crm/manifest.yaml (marketing team) |
| | ClientDesk CRM (IE): DPA yes | declared: declared/crm/manifest.yaml (marketing team) |
| (e) Transfers | BulkLetter (US): safeguard not declared | declared: declared/crm/manifest.yaml (marketing team) |
| (f) Erasure time limits | app-logs (log): P30D, log rotation | declared: services/bistro-api/manifest.yaml (docs/operations.md) |
| | campaign-exports (file): unknown | declared: declared/crm/manifest.yaml (marketing team) |
| | crm-database (database): P2Y, after the last interaction with the contact | declared: declared/crm/manifest.yaml (marketing team) |
| | main-db (database): P3Y, after the last booking of the guest | code: bistro-api@7c1e4f9:db/migrations/** |
| (g) Security measures | To complete | — |

### DPO checks

| Check | Value | Source |
| --- | --- | --- |
| Legal basis | consent | declared: marketing team |
| Legal basis detail | To complete | — |
| DPIA | Required: to-assess | declared: marketing team |
| Information of persons | To complete | — |
| Sensitive data | to-assess | declared: marketing team |
| Processor contracts | BulkLetter (US): DPA no | declared: declared/crm/manifest.yaml (marketing team) |
| | ClientDesk CRM (IE): DPA yes | declared: declared/crm/manifest.yaml (marketing team) |

## Table bookings (table-bookings)

### Records of processing, GDPR Art. 30(1)

| Item | Value | Source |
| --- | --- | --- |
| (a) Controller | Bistro Booking Group SAS, 12 rue des Tables, 75011 Paris, France, RCS Paris 900 000 000, privacy@bistro-booking.example | declared: compliance.yaml |
| (a) Joint controller | None | declared: operations team |
| (a) Representative | To complete | — |
| (a) Data protection officer | Data protection office, dpo@bistro-booking.example | declared: compliance.yaml |
| (b) Purposes | Take, confirm, remind and secure table bookings made by guests. | declared: operations team |
| (c) Data subjects | restaurant guests | code: bistro-api@7c1e4f9:src/bookings/booking.ts |
| (c) Personal data | connection: IP address of the booking request, browser user agent | code: bistro-api@7c1e4f9:src/middleware/rate-limit.ts |
| | contact: guest email, guest phone number | code: bistro-api@7c1e4f9:src/bookings/guest.ts |
| | contact: guest email, guest phone number | code: bistro-web@9d3f6b1:src/components/BookingForm.tsx |
| | financial: card brand and last four digits, payment provider customer id | code: bistro-api@7c1e4f9:src/payments/deposit.ts |
| | identity: guest name | code: bistro-api@7c1e4f9:src/bookings/guest.ts |
| | identity: guest name | code: bistro-web@9d3f6b1:src/components/BookingForm.tsx |
| | special: dietary notes (free text) | code: bistro-api@7c1e4f9:src/bookings/booking.ts |
| | special: dietary notes (free text) | code: bistro-web@9d3f6b1:src/components/BookingForm.tsx |
| | usage: booking date and time, party size | code: bistro-api@7c1e4f9:src/bookings/booking.ts |
| | usage: no-show risk score, number of past no-shows | spec: https://github.com/bistro-org/bistro-api/issues/42 |
| (d) Recipients | MailRelay (FR): DPA yes | code: bistro-api@7c1e4f9:src/notifications/email.ts |
| | PayGate (US): DPA yes | code: bistro-api@7c1e4f9:src/payments/deposit.ts |
| | TextFlow SMS (NL): DPA yes | code: bistro-api@7c1e4f9:src/notifications/sms.ts |
| | the calendar application chosen by the guest (country unknown) | code: bistro-api@7c1e4f9:src/bookings/calendar.ts |
| (e) Transfers | PayGate (US): standard contractual clauses | code: bistro-api@7c1e4f9:src/payments/deposit.ts |
| | the calendar application chosen by the guest (country unknown): The guest adds the booking to a calendar of their choice with their own account; the service only offers the link. | code: bistro-api@7c1e4f9:src/bookings/calendar.ts |
| (f) Erasure time limits | P3Y, after the last booking of the guest | declared: records of processing policy |
| (g) Security measures | Back office access limited to restaurant staff with individual accounts | declared: docs/security.md |
| | Data encrypted in transit (TLS) and at rest | declared: docs/security.md |

### DPO checks

| Check | Value | Source |
| --- | --- | --- |
| Legal basis | contract | declared: operations team |
| Legal basis detail | Reference: Booking terms accepted by the guest when booking a table, section 3; dietary notes are optional and asked with the guest's explicit consent (Art. 9(2)(a)) | declared: operations team |
| DPIA | Required: yes; Criteria: evaluation, sensitive; Reference: DPIA-2026-01, table bookings (dpia/table-bookings.pdf) | declared: operations team |
| Information of persons | page: https://bistro-booking.example/privacy (bistro-web) | code: bistro-web@9d3f6b1:src/pages/privacy.tsx |
| | The booking confirmation email repeats the link to the privacy page. | declared: operations team |
| Sensitive data | health, religious | declared: operations team |
| Processor contracts | MailRelay (FR): DPA yes (MailRelay standard data processing terms, version 2025) | code: bistro-api@7c1e4f9:src/notifications/email.ts |
| | PayGate (US): DPA yes (PayGate data processing addendum, signed 2025-11-20) | code: bistro-api@7c1e4f9:src/payments/deposit.ts |
| | TextFlow SMS (NL): DPA yes (TextFlow SMS data processing agreement, signed 2025-09-02) | code: bistro-api@7c1e4f9:src/notifications/sms.ts |

## AI features

2 AI features in the services of the processing activities.

| Service | Feature | Role | Risk | Obligations | Source |
| --- | --- | --- | --- | --- | --- |
| bistro-api | booking-assistant: A chat assistant answers guests' questions about opening hours and menus. | to-assess | limited: A chat assistant that talks to guests: transparency obligations only. | art4-ai-literacy: done (AI training of the support team, 2026); art50-interaction: done (The chat window starts with "You are talking to an AI assistant".); art50-synthetic-content: To complete | code: bistro-api@7c1e4f9:src/assistant/chat.ts |
| bistro-api | no-show-prediction: A statistical model predicts the no-show risk of a booking from the guest's booking history. | provider | limited: The score only asks for a deposit that a manager can waive; it is not an Annex III use. | art4-ai-literacy: open | spec: https://github.com/bistro-org/bistro-api/issues/42 |

## Outside the register

2 services or components whose controller is not the organisation alone.

| Service | Controller | Rationale | Privacy by design | Personal data | Source |
| --- | --- | --- | --- | --- | --- |
| bistro-web/offline-app | user-of-the-app | The offline app keeps the guest's favourite restaurants and private notes on the guest's device only. Nothing is sent to Bistro Booking, which cannot read them: the guest decides what to write and when to delete it. | Favourites and notes of the offline app never leave the device; Page views are sent only after the visitor has consented; The offline app works without an account | guest-notes (unknown, usage) | declared: services/bistro-web/manifest.yaml (README.md) |
| crm | shared | To complete | None identified in the sources | newsletter-contacts (contact, identity, unknown, usage) | declared: declared/crm/manifest.yaml (marketing team) |

## Not covered

This dossier prepares a review; it does not certify compliance with the GDPR or the AI Act. It holds the references of the data protection impact assessments, not the assessments themselves, and it shows only what the sources state: a processing activity, a repo or a tool missing from the compliance repo is missing from the dossier.
