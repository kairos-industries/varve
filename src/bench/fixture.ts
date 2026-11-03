import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Atlas } from "../atlas.js";

/**
 * The benchmark's bundled atlas: four weeks of invented work in three projects, the same on
 * every machine, so results from different people compare. Questions are written the way a
 * colleague asks weeks later; most share no distinctive word with the note they target.
 */

type Ev = [type: "decision" | "change" | "finding" | "todo", text: string];

interface FixtureSession {
  key: string;
  scope: string;
  /** UTC start; the session closes an hour later. */
  at: string;
  headline: string;
  events: Ev[];
}

export interface FixtureQuestion {
  query: string;
  relevant: string[];
  /** dev: the first 33, seen while choosing the search defaults. test: written afterwards, never used to tune anything. */
  split?: "dev" | "test";
  /** paraphrase: no distinctive word shared with the target. exact: a name or term to look up. dated: a vague query with a date range. */
  kind: "paraphrase" | "exact" | "dated";
  from?: string;
  to?: string;
}

export const FIXTURE_TODAY = "2026-10-05T09:00:00Z";

export const FIXTURE_SESSIONS: FixtureSession[] = [
  { key: "b1", scope: "billing-api", at: "2026-09-07T09:00:00Z", headline: "Invoice PDFs render from a queue", events: [["decision", "Render invoice PDFs on a worker queue; the request path timed out on 400-line invoices."], ["change", "Retry key is invoice_id plus version, so a re-render after an edit is not deduplicated."], ["todo", "Load test with 10k invoices before the release."]] },
  { key: "b2", scope: "billing-api", at: "2026-09-08T13:00:00Z", headline: "EUR rounding bug in credit notes", events: [["finding", "EUR totals were off by a cent: banker's rounding in the tax step, half-up everywhere else."], ["decision", "Use half-up in every money calculation; it matches the finance team's ledger."]] },
  { key: "b3", scope: "billing-api", at: "2026-09-10T09:00:00Z", headline: "Stripe webhook signatures", events: [["change", "Webhook signature check moved into middleware."], ["finding", "Stripe retries a failed webhook for 3 days, so handlers must be idempotent."]] },
  { key: "b4", scope: "billing-api", at: "2026-09-14T09:00:00Z", headline: "Proration for mid-cycle plan changes", events: [["decision", "Prorate by the day, not the second; customers read invoices by date."], ["change", "Added proration line items to the invoice model."]] },
  { key: "b5", scope: "billing-api", at: "2026-09-16T09:00:00Z", headline: "Drop the legacy CSV export", events: [["decision", "Remove the legacy CSV export: two tenants use it and both can take the API instead."], ["todo", "Email the two CSV tenants before the removal."]] },
  { key: "b6", scope: "billing-api", at: "2026-09-21T09:00:00Z", headline: "Dunning emails for failed charges", events: [["change", "Three reminder emails at day 1, 4 and 9 after a failed charge."], ["decision", "Pause the subscription after the third failed attempt instead of cancelling it."]] },
  { key: "b7", scope: "billing-api", at: "2026-09-23T09:00:00Z", headline: "VAT IDs for EU tenants", events: [["change", "VAT number validation against VIES with a 24-hour cache."], ["finding", "VIES is down most Sunday nights; fall back to accepting the number and re-checking on Monday."]] },
  { key: "b8", scope: "billing-api", at: "2026-09-28T09:00:00Z", headline: "Usage-based billing meter", events: [["decision", "Aggregate usage events hourly in Postgres, not Redis: we need an audit trail."], ["todo", "Backfill September usage for the pilot accounts."]] },
  { key: "b9", scope: "billing-api", at: "2026-09-30T09:00:00Z", headline: "Invoice numbering gaps", events: [["finding", "Invoice numbers skipped when a transaction rolled back, because Postgres sequences are not transactional."], ["decision", "Assign invoice numbers at finalization from a counter table locked per tenant."]] },
  { key: "b10", scope: "billing-api", at: "2026-10-02T09:00:00Z", headline: "Partial refunds as credit notes", events: [["change", "Partial refunds create a credit note linked to the original invoice."]] },

  { key: "m1", scope: "mobile-app", at: "2026-09-08T09:00:00Z", headline: "Push notifications on Android 15", events: [["finding", "Android 15 drops notifications from apps that never showed the runtime permission prompt."], ["change", "Ask for notification permission after the first order, not at launch."]] },
  { key: "m2", scope: "mobile-app", at: "2026-09-09T09:00:00Z", headline: "Okta SAML for enterprise accounts", events: [["decision", "Enterprise customers authenticate through Okta with SAML; magic links stay for everyone else."], ["change", "Added the SAML callback screen."]] },
  { key: "m3", scope: "mobile-app", at: "2026-09-15T09:00:00Z", headline: "Offline cart", events: [["decision", "Keep the cart in SQLite on the device and sync on reconnect; last write wins per line."], ["finding", "Sync conflicts hit 0.3% of carts in the beta."]] },
  { key: "m4", scope: "mobile-app", at: "2026-09-17T09:00:00Z", headline: "iPad split view crash", events: [["finding", "The checkout sheet crashed in split view because its layout assumed a full-width window."], ["change", "Checkout now uses adaptive size classes."]] },
  { key: "m5", scope: "mobile-app", at: "2026-09-22T09:00:00Z", headline: "App Store guideline 5.1.1 rejection", events: [["finding", "Review rejected build 2.8 under guideline 5.1.1: account deletion was only possible on the website."], ["change", "Account deletion added under Settings > Privacy."]] },
  { key: "m6", scope: "mobile-app", at: "2026-09-24T09:00:00Z", headline: "Design tokens for dark mode", events: [["change", "Every colour now comes from the design tokens; removed 140 hard-coded hex values."]] },
  { key: "m7", scope: "mobile-app", at: "2026-09-29T09:00:00Z", headline: "Cold start on Android", events: [["finding", "Cold start was 3.1 s on a Pixel 6; 1.2 s of it went to loading every font family."], ["change", "Fonts load lazily; cold start is now 1.6 s."], ["todo", "Measure cold start on the oldest supported iPhone."]] },
  { key: "m8", scope: "mobile-app", at: "2026-10-01T09:00:00Z", headline: "LaunchDarkly flags", events: [["decision", "Use LaunchDarkly for flags: the home-grown JSON file could not target by tenant."]] },

  { key: "d1", scope: "data-platform", at: "2026-09-07T13:00:00Z", headline: "Nightly load on Airflow", events: [["change", "The nightly load moved from cron to Airflow, with retries."], ["finding", "The Salesforce extract times out above 2 million rows."]] },
  { key: "d2", scope: "data-platform", at: "2026-09-11T09:00:00Z", headline: "Emails leaking into event properties", events: [["finding", "Email addresses leaked into event properties from the signup form."], ["decision", "Hash emails at the collector; raw values never reach the warehouse."]] },
  { key: "d3", scope: "data-platform", at: "2026-09-14T13:00:00Z", headline: "dbt churn model", events: [["change", "New dbt model for monthly churn by plan."], ["decision", "A tenant counts as churned 30 days after its last paid invoice."]] },
  { key: "d4", scope: "data-platform", at: "2026-09-18T09:00:00Z", headline: "Snowflake credits spike", events: [["finding", "A dashboard refreshing every minute kept the Snowflake warehouse awake all weekend: $4,100 in two days."], ["change", "Warehouse auto-suspends after 60 s and dashboards refresh hourly."]] },
  { key: "d5", scope: "data-platform", at: "2026-09-22T13:00:00Z", headline: "Schemas required before ingestion", events: [["decision", "An event needs a schema in the registry before the collector accepts it."], ["todo", "Write the schema for the checkout events with the mobile team."]] },
  { key: "d6", scope: "data-platform", at: "2026-09-25T09:00:00Z", headline: "Late-arriving mobile events", events: [["finding", "Mobile events arrive up to 3 days late when phones are offline."], ["decision", "Reprocess the last 4 days on every nightly load."]] },
  { key: "d7", scope: "data-platform", at: "2026-09-29T13:00:00Z", headline: "Revenue dashboard 2% off", events: [["finding", "The revenue dashboard differed from the ledger by 2% because refunds were booked on the refund date."], ["decision", "Revenue reports book refunds against the original invoice month."]] },
  { key: "d8", scope: "data-platform", at: "2026-10-01T13:00:00Z", headline: "GDPR erasure job", events: [["change", "Erasure requests remove the user from every table within 30 days, through a weekly job."]] },
];

export const FIXTURE_QUESTIONS: FixtureQuestion[] = [
  { query: "why do we generate billing documents in the background", relevant: ["b1"], kind: "paraphrase" },
  { query: "off-by-a-penny problem with euro amounts", relevant: ["b2"], kind: "paraphrase" },
  { query: "verifying callbacks from the payment provider", relevant: ["b3"], kind: "paraphrase" },
  { query: "charging someone who upgrades halfway through the month", relevant: ["b4"], kind: "paraphrase" },
  { query: "spreadsheet download we got rid of", relevant: ["b5"], kind: "paraphrase" },
  { query: "what happens when a card keeps getting declined", relevant: ["b6"], kind: "paraphrase" },
  { query: "checking company tax registration when the lookup service is unavailable", relevant: ["b7"], kind: "paraphrase" },
  { query: "where do we count metered consumption", relevant: ["b8"], kind: "paraphrase" },
  { query: "skipped document numbers after a failed database write", relevant: ["b9"], kind: "paraphrase" },
  { query: "giving part of the money back to a customer", relevant: ["b10"], kind: "paraphrase" },
  { query: "phones not showing alerts on the newest Google OS", relevant: ["m1"], kind: "paraphrase" },
  { query: "corporate single sign-on in the app", relevant: ["m2"], kind: "paraphrase" },
  { query: "keeping the shopping basket without internet", relevant: ["m3"], kind: "paraphrase" },
  { query: "tablet multitasking makes the payment screen fail", relevant: ["m4"], kind: "paraphrase" },
  { query: "why did Apple turn down our submission", relevant: ["m5"], kind: "paraphrase" },
  { query: "night theme palette cleanup", relevant: ["m6"], kind: "paraphrase" },
  { query: "the app takes too long to open", relevant: ["m7"], kind: "paraphrase" },
  { query: "remote switches to turn features on per customer", relevant: ["m8"], kind: "paraphrase" },
  { query: "moving the scheduled warehouse job to a workflow orchestrator", relevant: ["d1"], kind: "paraphrase" },
  { query: "personal data showing up in tracking", relevant: ["d2"], kind: "paraphrase" },
  { query: "when do we consider a customer lost", relevant: ["d3"], kind: "paraphrase" },
  { query: "why was the cloud database bill so high that weekend", relevant: ["d4"], kind: "paraphrase" },
  { query: "agreeing on event formats between teams", relevant: ["d5"], kind: "paraphrase" },
  { query: "handsets that were disconnected send their data days later", relevant: ["d6"], kind: "paraphrase" },
  { query: "finance and the charts disagree on income", relevant: ["d7"], kind: "paraphrase" },
  { query: "right to be forgotten", relevant: ["d8"], kind: "paraphrase" },

  { query: "VIES", relevant: ["b7"], kind: "exact" },
  { query: "invoice_id", relevant: ["b1"], kind: "exact" },
  { query: "LaunchDarkly", relevant: ["m8"], kind: "exact" },
  { query: "guideline 5.1.1", relevant: ["m5"], kind: "exact" },
  { query: "Airflow", relevant: ["d1"], kind: "exact" },
  { query: "dbt", relevant: ["d3"], kind: "exact" },

  { query: "billing changes", relevant: ["b8", "b9", "b10"], kind: "dated", from: "2026-09-28", to: "2026-10-04" },
];

/**
 * Held-out questions, written after the search defaults were chosen and never used to tune them.
 * Scores on this split are the ones to quote.
 */
const TEST_QUESTIONS: FixtureQuestion[] = [
  { query: "billing documents timing out when customers download them", relevant: ["b1"], kind: "paraphrase" },
  { query: "money calculations disagreeing with the accountants' books", relevant: ["b2"], kind: "paraphrase" },
  { query: "duplicate payment notifications arriving for days", relevant: ["b3"], kind: "paraphrase" },
  { query: "charging for part of a period when the subscription tier changes", relevant: ["b4"], kind: "paraphrase" },
  { query: "retiring the old file download for two clients", relevant: ["b5"], kind: "paraphrase" },
  { query: "reminder messages after a payment fails", relevant: ["b6"], kind: "paraphrase" },
  { query: "checking EU business tax codes when the government service is offline at weekends", relevant: ["b7"], kind: "paraphrase" },
  { query: "measuring how much each customer consumes, with history for auditors", relevant: ["b8"], kind: "paraphrase" },
  { query: "why our bill sequence has holes in it", relevant: ["b9"], kind: "paraphrase" },
  { query: "returning money to a client, tied back to the original bill", relevant: ["b10"], kind: "paraphrase" },
  { query: "users stopped getting alerts after the OS upgrade until they allowed them", relevant: ["m1"], kind: "paraphrase" },
  { query: "staff at big companies log in with their corporate identity provider", relevant: ["m2"], kind: "paraphrase" },
  { query: "what wins when two devices change the basket while offline", relevant: ["m3"], kind: "paraphrase" },
  { query: "layout breaking when the tablet screen is shared between two apps", relevant: ["m4"], kind: "paraphrase" },
  { query: "store review refused the build because people could not remove their profile in the app", relevant: ["m5"], kind: "paraphrase" },
  { query: "consistent colour variables for the night appearance", relevant: ["m6"], kind: "paraphrase" },
  { query: "typefaces slowing down the first launch", relevant: ["m7"], kind: "paraphrase" },
  { query: "why we stopped using our own config file for toggles", relevant: ["m8"], kind: "paraphrase" },
  { query: "the CRM export fails when it gets too big", relevant: ["d1"], kind: "paraphrase" },
  { query: "scrambling customer addresses at ingestion", relevant: ["d2"], kind: "paraphrase" },
  { query: "monthly measure of customers leaving, by tier", relevant: ["d3"], kind: "paraphrase" },
  { query: "a report that reloaded constantly burned money over two days", relevant: ["d4"], kind: "paraphrase" },
  { query: "data has to be described up front or the pipeline rejects it", relevant: ["d5"], kind: "paraphrase" },
  { query: "rerunning several days of data each night because phones sync late", relevant: ["d6"], kind: "paraphrase" },
  { query: "returns counted on the day they happened instead of the sale month", relevant: ["d7"], kind: "paraphrase" },
  { query: "erasing someone from every dataset within a month", relevant: ["d8"], kind: "paraphrase" },

  { query: "SQLite", relevant: ["m3"], kind: "exact" },
  { query: "Pixel 6", relevant: ["m7"], kind: "exact" },
  { query: "Salesforce", relevant: ["d1"], kind: "exact" },
  { query: "banker's rounding", relevant: ["b2"], kind: "exact" },
  { query: "SAML", relevant: ["m2"], kind: "exact" },
  { query: "Postgres sequences", relevant: ["b9"], kind: "exact" },

  { query: "mobile work", relevant: ["m3", "m4"], kind: "dated", from: "2026-09-14", to: "2026-09-20" },
  { query: "data platform changes", relevant: ["d1", "d2"], kind: "dated", from: "2026-09-07", to: "2026-09-13" },
  { query: "billing", relevant: ["b4", "b5"], kind: "dated", from: "2026-09-14", to: "2026-09-20" },
  { query: "what did we do on the app", relevant: ["m7", "m8"], kind: "dated", from: "2026-09-28", to: "2026-10-04" },
];

export const ALL_FIXTURE_QUESTIONS: FixtureQuestion[] = [
  ...FIXTURE_QUESTIONS.map((q) => ({ ...q, split: "dev" as const })),
  ...TEST_QUESTIONS.map((q) => ({ ...q, split: "test" as const })),
];

/** Build the fixture atlas in `root` and return it with the note name of each session key. */
export function buildFixture(root: string): { atlas: Atlas; notes: Map<string, string>; today: Date } {
  const dir = join(root, "atlas");
  let now = new Date(FIXTURE_SESSIONS[0]!.at);
  let n = 0;
  const atlas = new Atlas({ dir, clock: () => now, config: { timezone: "UTC", semanticSearch: true }, sessionIds: () => `fx${String(++n).padStart(4, "0")}` });
  const notes = new Map<string, string>();
  for (const s of FIXTURE_SESSIONS) {
    const cwd = join(root, "work", s.scope);
    mkdirSync(cwd, { recursive: true });
    const start = new Date(s.at);
    now = start;
    const session = atlas.session({ cwd });
    s.events.forEach(([type, text], i) => {
      now = new Date(start.getTime() + (i + 1) * 10 * 60 * 1000);
      session.log({ type, text });
    });
    now = new Date(start.getTime() + 60 * 60 * 1000);
    const decisions = s.events.filter(([t]) => t === "decision").map(([, x]) => `- ${x}`);
    const todos = s.events.filter(([t]) => t === "todo").map(([, x]) => `- ${x}`);
    const summary = [`### Done`, `- ${s.headline}.`, decisions.length ? `### Decisions\n${decisions.join("\n")}` : "", todos.length ? `### Open threads\n${todos.join("\n")}` : ""]
      .filter(Boolean)
      .join("\n");
    session.closeSession({ headline: s.headline, summary });
    session.disconnect();
    notes.set(s.key, session.notePath!.split(/[\\/]/).pop()!.replace(/\.md$/, ""));
  }
  now = new Date(FIXTURE_TODAY);
  return { atlas, notes, today: now };
}
