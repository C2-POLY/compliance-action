---
spec_version: "0.1"
generated_at: "2026-11-11T00:00:00Z"
open_items: 2
anchors:
  bistro-api: "7c1e4f9a2b6d8035e1a4c7f90b2d6e8a1c3f5b79"
  bistro-web: "9d3f6b1a4c7e0258b1d4f7a0c3e6b9d2f5a8c1e4"
---

# Records of processing activities

- Organisation: Bistro Booking Group
- Generated at: 2026-11-11T00:00:00Z

Records of processing activities of the controller, GDPR Art. 30(1), one section per processing activity. The Source column says where each value comes from; `To complete` means that no source gives the value and a person has to fill it in. How this document is built: `templates/register/README.md` in the compliance-spec repository.

> Prepared for review by the controller and its data protection officer. This document does not certify compliance with the GDPR.

## Open items

2 open items in 2 of the 2 processing activities.

| Processing activity | Open items |
| --- | --- |
| Marketing emails (marketing-emails) | (g) Security measures |
| Table bookings (table-bookings) | (e) Transfers: destination to assess for the calendar application chosen by the guest (country unknown) |

Joint controller and representative are not counted: the processing format of v0.1 has no field for them, so they always read `To complete` and a person confirms them by hand.

## Marketing emails (marketing-emails)

| Item | Value | Source |
| --- | --- | --- |
| (a) Controller | Bistro Booking Group, privacy@bistro-booking.example | declared: marketing team |
| (a) Joint controller | To complete | — |
| (a) Representative | To complete | — |
| (a) Data protection officer | Data protection office, dpo@bistro-booking.example | declared: marketing team |
| (b) Purposes | Send the monthly newsletter and special offers to guests who subscribed. | declared: marketing team |
| (c) Data subjects | guests who subscribed to the newsletter | declared: declared/crm/manifest.yaml (marketing team) |
| | restaurant guests | code: bistro-api@7c1e4f9:src/bookings/guest.ts |
| (c) Personal data | contact: guest email | declared: declared/crm/manifest.yaml (marketing team) |
| | contact: guest email, guest phone number | code: bistro-api@7c1e4f9:src/bookings/guest.ts |
| | identity: guest name | code: bistro-api@7c1e4f9:src/bookings/guest.ts |
| | identity: guest name | declared: declared/crm/manifest.yaml (marketing team) |
| | usage: subscription date and consent record | declared: declared/crm/manifest.yaml (marketing team) |
| (d) Recipients | ClientDesk CRM (IE) | declared: declared/crm/manifest.yaml (marketing team) |
| (e) Transfers | None identified in the sources | — |
| (f) Erasure time limits | app-logs (log): P30D, log rotation | declared: services/bistro-api/manifest.yaml (docs/operations.md) |
| | crm-database (database): P2Y, after the last interaction with the contact | declared: declared/crm/manifest.yaml (marketing team) |
| | main-db (database): P3Y, after the last booking of the guest | code: bistro-api@7c1e4f9:db/migrations/** |
| (g) Security measures | To complete | — |

## Table bookings (table-bookings)

| Item | Value | Source |
| --- | --- | --- |
| (a) Controller | Bistro Booking Group, privacy@bistro-booking.example | declared: operations team |
| (a) Joint controller | To complete | — |
| (a) Representative | To complete | — |
| (a) Data protection officer | Data protection office, dpo@bistro-booking.example | declared: operations team |
| (b) Purposes | Take, confirm, remind and secure table bookings made by guests. | declared: operations team |
| (c) Data subjects | restaurant guests | code: bistro-api@7c1e4f9:src/bookings/booking.ts |
| (c) Personal data | contact: guest email, guest phone number | code: bistro-api@7c1e4f9:src/bookings/guest.ts |
| | contact: guest email, guest phone number | code: bistro-web@9d3f6b1:src/components/BookingForm.tsx |
| | financial: card brand and last four digits, payment provider customer id | code: bistro-api@7c1e4f9:src/payments/deposit.ts |
| | identity: guest name | code: bistro-api@7c1e4f9:src/bookings/guest.ts |
| | identity: guest name | code: bistro-web@9d3f6b1:src/components/BookingForm.tsx |
| | special: dietary notes (free text) | code: bistro-api@7c1e4f9:src/bookings/booking.ts |
| | special: dietary notes (free text) | code: bistro-web@9d3f6b1:src/components/BookingForm.tsx |
| | usage: booking date and time, party size | code: bistro-api@7c1e4f9:src/bookings/booking.ts |
| | usage: no-show risk score, number of past no-shows | spec: https://github.com/bistro-org/bistro-api/issues/42 |
| (d) Recipients | MailRelay (FR) | code: bistro-api@7c1e4f9:src/notifications/email.ts |
| | PayGate (US) | code: bistro-api@7c1e4f9:src/payments/deposit.ts |
| | TextFlow SMS (NL) | code: bistro-api@7c1e4f9:src/notifications/sms.ts |
| | the calendar application chosen by the guest (country unknown) | code: bistro-api@7c1e4f9:src/bookings/calendar.ts |
| (e) Transfers | PayGate (US): standard contractual clauses | code: bistro-api@7c1e4f9:src/payments/deposit.ts |
| | the calendar application chosen by the guest (country unknown): destination to assess | code: bistro-api@7c1e4f9:src/bookings/calendar.ts |
| (f) Erasure time limits | P3Y, after the last booking of the guest | declared: records of processing policy |
| (g) Security measures | Back office access limited to restaurant staff with individual accounts | declared: docs/security.md |
| | Data encrypted in transit (TLS) and at rest | declared: docs/security.md |
