---
spec_version: "0.2"
language: fr
generated_at: "2026-11-11T00:00:00Z"
open_items: 15
actions: 14
anchors:
  bistro-api: "7c1e4f9a2b6d8035e1a4c7f90b2d6e8a1c3f5b79"
  bistro-web: "9d3f6b1a4c7e0258b1d4f7a0c3e6b9d2f5a8c1e4"
---

# Dossier de conformité

- Organisation : Bistro Booking Group
- Généré le : 2026-11-11T00:00:00Z

Dossier de conformité de l'organisation, construit à partir de son dépôt de conformité : l'identité de l'organisation, les actions qui ferment les points ouverts, puis pour chaque traitement son registre des activités de traitement (RGPD art. 30(1)) et ses contrôles DPO, les fonctionnalités d'IA, et ce qui reste hors du registre. La colonne Source indique d'où vient chaque valeur ; `À compléter` signifie qu'aucune source ne donne la valeur et qu'une personne doit la renseigner. Construction de ce document : `templates/register/README.md` dans le dépôt compliance-spec.

> Préparé pour la revue du responsable du traitement et de son délégué à la protection des données. Ce document ne certifie pas la conformité au RGPD ni à l'AI Act.

## Organisation

| Élément | Valeur | Source |
| --- | --- | --- |
| Responsable du traitement | Bistro Booking Group SAS, 12 rue des Tables, 75011 Paris, France, RCS Paris 900 000 000, privacy@bistro-booking.example | declared: compliance.yaml |
| Délégué à la protection des données | Data protection office, dpo@bistro-booking.example | declared: compliance.yaml |
| Représentant (art. 27) | À compléter | — |
| Contact pour l'exercice des droits | privacy@bistro-booking.example | declared: compliance.yaml |

## Actions

15 points ouverts, fermés par 14 actions.

| Action | Rôle | Points ouverts fermés | Où |
| --- | --- | --- | --- |
| `information`: Indiquer comment les personnes sont informées (art. 13 et 14) | Organisation | 1 | marketing-emails |
| `joint-controllers`: Lister les responsables conjoints, ou indiquer qu'il n'y en a pas | Organisation | 1 | marketing-emails |
| `organisation-representative`: Indiquer si un représentant dans l'UE est requis (art. 27) | Organisation | 1 | Organisation |
| `processor-contracts`: Signer ou retrouver les contrats de sous-traitance (art. 28) | Organisation | 1 | marketing-emails |
| `ai-classification`: Classer les fonctionnalités d'IA : rôle et niveau de risque | DPO | 1 | Fonctionnalités d'IA |
| `controller-rationale`: Expliquer pourquoi l'organisation n'est pas responsable du traitement | DPO | 1 | Hors du registre |
| `dpia`: Évaluer si une AIPD est requise, et la référencer | DPO | 1 | marketing-emails |
| `legal-basis-detail`: Documenter la base légale | DPO | 1 | marketing-emails |
| `retention`: Fixer les durées de conservation | DPO | 1 | marketing-emails |
| `sensitive-data`: Évaluer les données sensibles (art. 9) | DPO | 1 | marketing-emails |
| `ai-obligations`: Remplir ou documenter les obligations de l'AI Act | Développeur | 2 | Fonctionnalités d'IA |
| `personal-data`: Décrire les données personnelles et classer les catégories inconnues | Développeur | 1 | marketing-emails |
| `security-measures`: Décrire les mesures de sécurité | Développeur | 1 | marketing-emails |
| `transfer-safeguards`: Déclarer la garantie de chaque transfert hors de l'UE | Développeur | 1 | marketing-emails |

## Marketing emails (marketing-emails)

### Registre des activités de traitement, RGPD art. 30(1)

| Élément | Valeur | Source |
| --- | --- | --- |
| (a) Responsable du traitement | Bistro Booking Group, newsletter@bistro-booking.example | declared: marketing team |
| (a) Responsable conjoint | À compléter | — |
| (a) Représentant | À compléter | — |
| (a) Délégué à la protection des données | Data protection office, dpo@bistro-booking.example | declared: compliance.yaml |
| (b) Finalités | Send the monthly newsletter and special offers to guests who subscribed. | declared: marketing team |
| (c) Personnes concernées | guests who subscribed to the newsletter | declared: declared/crm/manifest.yaml (marketing team) |
| | restaurant guests | code: bistro-api@7c1e4f9:src/bookings/guest.ts |
| (c) Données personnelles | contact: guest email | declared: declared/crm/manifest.yaml (marketing team) |
| | contact: guest email, guest phone number | code: bistro-api@7c1e4f9:src/bookings/guest.ts |
| | identity: guest name | code: bistro-api@7c1e4f9:src/bookings/guest.ts |
| | identity: guest name | declared: declared/crm/manifest.yaml (marketing team) |
| | unknown: campaign notes (free text) | declared: declared/crm/manifest.yaml (marketing team) |
| | usage: subscription date and consent record | declared: declared/crm/manifest.yaml (marketing team) |
| (d) Destinataires | BulkLetter (US): DPA no | declared: declared/crm/manifest.yaml (marketing team) |
| | ClientDesk CRM (IE): DPA yes | declared: declared/crm/manifest.yaml (marketing team) |
| (e) Transferts | BulkLetter (US): garantie non déclarée | declared: declared/crm/manifest.yaml (marketing team) |
| (f) Délais d'effacement | app-logs (log): P30D, log rotation | declared: services/bistro-api/manifest.yaml (docs/operations.md) |
| | campaign-exports (file): unknown | declared: declared/crm/manifest.yaml (marketing team) |
| | crm-database (database): P2Y, after the last interaction with the contact | declared: declared/crm/manifest.yaml (marketing team) |
| | main-db (database): P3Y, after the last booking of the guest | code: bistro-api@7c1e4f9:db/migrations/** |
| (g) Mesures de sécurité | À compléter | — |

### Contrôles DPO

| Contrôle | Valeur | Source |
| --- | --- | --- |
| Base légale | consent | declared: marketing team |
| Détail de la base légale | À compléter | — |
| AIPD | Requise: to-assess | declared: marketing team |
| Information des personnes | À compléter | — |
| Données sensibles | to-assess | declared: marketing team |
| Contrats de sous-traitance | BulkLetter (US): DPA no | declared: declared/crm/manifest.yaml (marketing team) |
| | ClientDesk CRM (IE): DPA yes | declared: declared/crm/manifest.yaml (marketing team) |

## Table bookings (table-bookings)

### Registre des activités de traitement, RGPD art. 30(1)

| Élément | Valeur | Source |
| --- | --- | --- |
| (a) Responsable du traitement | Bistro Booking Group SAS, 12 rue des Tables, 75011 Paris, France, RCS Paris 900 000 000, privacy@bistro-booking.example | declared: compliance.yaml |
| (a) Responsable conjoint | Aucun | declared: operations team |
| (a) Représentant | À compléter | — |
| (a) Délégué à la protection des données | Data protection office, dpo@bistro-booking.example | declared: compliance.yaml |
| (b) Finalités | Take, confirm, remind and secure table bookings made by guests. | declared: operations team |
| (c) Personnes concernées | restaurant guests | code: bistro-api@7c1e4f9:src/bookings/booking.ts |
| (c) Données personnelles | connection: IP address of the booking request, browser user agent | code: bistro-api@7c1e4f9:src/middleware/rate-limit.ts |
| | contact: guest email, guest phone number | code: bistro-api@7c1e4f9:src/bookings/guest.ts |
| | contact: guest email, guest phone number | code: bistro-web@9d3f6b1:src/components/BookingForm.tsx |
| | financial: card brand and last four digits, payment provider customer id | code: bistro-api@7c1e4f9:src/payments/deposit.ts |
| | identity: guest name | code: bistro-api@7c1e4f9:src/bookings/guest.ts |
| | identity: guest name | code: bistro-web@9d3f6b1:src/components/BookingForm.tsx |
| | special: dietary notes (free text) | code: bistro-api@7c1e4f9:src/bookings/booking.ts |
| | special: dietary notes (free text) | code: bistro-web@9d3f6b1:src/components/BookingForm.tsx |
| | usage: booking date and time, party size | code: bistro-api@7c1e4f9:src/bookings/booking.ts |
| | usage: no-show risk score, number of past no-shows | spec: https://github.com/bistro-org/bistro-api/issues/42 |
| (d) Destinataires | MailRelay (FR): DPA yes | code: bistro-api@7c1e4f9:src/notifications/email.ts |
| | PayGate (US): DPA yes | code: bistro-api@7c1e4f9:src/payments/deposit.ts |
| | TextFlow SMS (NL): DPA yes | code: bistro-api@7c1e4f9:src/notifications/sms.ts |
| | the calendar application chosen by the guest (pays inconnu) | code: bistro-api@7c1e4f9:src/bookings/calendar.ts |
| (e) Transferts | PayGate (US): standard contractual clauses | code: bistro-api@7c1e4f9:src/payments/deposit.ts |
| | the calendar application chosen by the guest (pays inconnu): The guest adds the booking to a calendar of their choice with their own account; the service only offers the link. | code: bistro-api@7c1e4f9:src/bookings/calendar.ts |
| (f) Délais d'effacement | P3Y, after the last booking of the guest | declared: records of processing policy |
| (g) Mesures de sécurité | Back office access limited to restaurant staff with individual accounts | declared: docs/security.md |
| | Data encrypted in transit (TLS) and at rest | declared: docs/security.md |

### Contrôles DPO

| Contrôle | Valeur | Source |
| --- | --- | --- |
| Base légale | contract | declared: operations team |
| Détail de la base légale | Référence: Booking terms accepted by the guest when booking a table, section 3; dietary notes are optional and asked with the guest's explicit consent (Art. 9(2)(a)) | declared: operations team |
| AIPD | Requise: yes; Critères: evaluation, sensitive; Référence: DPIA-2026-01, table bookings (dpia/table-bookings.pdf) | declared: operations team |
| Information des personnes | page: https://bistro-booking.example/privacy (bistro-web) | code: bistro-web@9d3f6b1:src/pages/privacy.tsx |
| | The booking confirmation email repeats the link to the privacy page. | declared: operations team |
| Données sensibles | health, religious | declared: operations team |
| Contrats de sous-traitance | MailRelay (FR): DPA yes (MailRelay standard data processing terms, version 2025) | code: bistro-api@7c1e4f9:src/notifications/email.ts |
| | PayGate (US): DPA yes (PayGate data processing addendum, signed 2025-11-20) | code: bistro-api@7c1e4f9:src/payments/deposit.ts |
| | TextFlow SMS (NL): DPA yes (TextFlow SMS data processing agreement, signed 2025-09-02) | code: bistro-api@7c1e4f9:src/notifications/sms.ts |

## Fonctionnalités d'IA

2 fonctionnalités d'IA dans les services des traitements.

| Service | Fonctionnalité | Rôle | Risque | Obligations | Source |
| --- | --- | --- | --- | --- | --- |
| bistro-api | booking-assistant: A chat assistant answers guests' questions about opening hours and menus. | to-assess | limited: A chat assistant that talks to guests: transparency obligations only. | art4-ai-literacy: done (AI training of the support team, 2026); art50-interaction: done (The chat window starts with "You are talking to an AI assistant".); art50-synthetic-content: À compléter | code: bistro-api@7c1e4f9:src/assistant/chat.ts |
| bistro-api | no-show-prediction: A statistical model predicts the no-show risk of a booking from the guest's booking history. | provider | limited: The score only asks for a deposit that a manager can waive; it is not an Annex III use. | art4-ai-literacy: open | spec: https://github.com/bistro-org/bistro-api/issues/42 |

## Hors du registre

2 services ou composants dont le responsable n'est pas l'organisation seule.

| Service | Responsable | Justification | Protection dès la conception | Données personnelles | Source |
| --- | --- | --- | --- | --- | --- |
| bistro-web/offline-app | user-of-the-app | The offline app keeps the guest's favourite restaurants and private notes on the guest's device only. Nothing is sent to Bistro Booking, which cannot read them: the guest decides what to write and when to delete it. | Favourites and notes of the offline app never leave the device; Page views are sent only after the visitor has consented; The offline app works without an account | guest-notes (unknown, usage) | declared: services/bistro-web/manifest.yaml (README.md) |
| crm | shared | À compléter | Aucun identifié dans les sources | newsletter-contacts (contact, identity, unknown, usage) | declared: declared/crm/manifest.yaml (marketing team) |

## Non couvert

Ce dossier prépare une revue ; il ne certifie pas la conformité au RGPD ni à l'AI Act. Il contient les références des analyses d'impact relatives à la protection des données, pas les analyses elles-mêmes, et ne montre que ce que les sources indiquent : un traitement, un dépôt ou un outil absent du dépôt de conformité est absent du dossier.
