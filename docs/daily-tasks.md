# Daily tasks

The operating routine for JellyBean, by role. Written for the team, not for
developers — no code knowledge needed.

**The one rule that matters:** a lead's outcome is only as good as the status
someone records. If you contact someone, log it the same day.

---

## The lead pipeline in one picture

```
 Nextdoor posts
      │
      ▼
 RAW LEADS ────────────► cancelled  (with a reason)
      │  AI classifies: qualified / cancelled / review
      ▼
 FORWARDED LEADS ──────► CS PIPELINE ──► outcome logged
      │                     │              │
      │                     │              └─► Google Sheets (automatic)
      ▼                     ▼
 manual submit          CRISP CHAT (live chat)
```

Each stage has an owner. Nobody should work a stage that isn't theirs.

---

## First thing each morning (everyone, 2 minutes)

1. Sign in. If you are asked for your **6-digit access code**, enter it — this is
   required for every non-admin account.
2. Check your nav bar for a **red unread badge** on _Pending leads_ or _Crisp
   Chat_. Anything badged needs attention today.
3. Anything you could not finish yesterday: start with it.

---

## By role

### `maturing` — Raw Leads, Forwarded Leads, Manual Lead

This role turns raw scraped posts into qualified leads. **Highest volume role.**

**Morning**

1. **Raw Leads.** Run **AI classification** on the new `new` batch. It returns
   `qualified`, `cancelled`, or leaves a post for human review.
2. Work the **review** items first — those are the AI's low-confidence calls.
3. For every `qualified` post, confirm it by reading the post text. The AI is a
   filter, not a decision-maker.

**During the day**

4. **Cancel the rejects, with a reason.** Do not leave posts sitting in `new`.
   Reasons: not a lead, general post, spam, duplicate, irrelevant, number not
   found.
5. **Duplicates.** New duplicate detection flags likely repeats. Confirm or
   dismiss — do not ignore the queue, it grows.
6. **Forwarded Leads** — spot-check leads assigned to CS. Anything sitting
   untouched for a day is a bottleneck worth raising.
7. **Manual Lead** — submit leads that arrive by phone, referral, or anywhere
   outside Nextdoor.

**End of day** — leave nothing in `new` that you have already reviewed.

> Only `qualified` posts move to the CS stage. A cancelled post with no reason
> cannot be audited, and the reason is what makes the AI thresholds tunable.

---

### `cs` — CS Pipeline, Pending Leads, Crisp Chat

This role contacts customers and records outcomes. **Revenue depends on this.**

**Morning**

1. **CS Pipeline**, filter to the current period. Work `New to contact` first.
2. For each lead: read the post, the area, and the service before you call. The
   AI-drafted message is a starting point — adjust it to the actual request.
3. Call or message, then **immediately** set the status. Do not batch this to
   end of day; you will lose the context of who was already tried.
4. **Pending leads** — these were sent a reminder. Follow up on those first; the
   customer has already shown interest.

**During the day**

5. **Crisp Chat** — clear unread conversations. Customers who start a live chat
   are the hottest leads you will see.
6. **Mark conversations read** once you have actually responded, not when you
   open them.

**End of day**

7. Leave no lead in `New to contact` that you already contacted.
8. If AI auto-rephrase is on, spot-check any message it drafted before sending.

> **Status honesty matters most.** `Wrong number`, `Already got someone`,
> `Service provider himself`, `Small service`, `Not interested` are all useful
> answers — they keep the next person from wasting a call. Only `converted`
> should mean money.
>
> Pick the **most specific** status that fits. "Follow-up" is almost always
> better than a vague one.

---

### `cs_admin` — CS Pipeline, Pending, Crisp, Lead Assignment, Users

Everything `cs` does, plus two extras.

- **Lead Assignment** — check that new CS users are receiving a fair share. The
  system auto-assigns by service and then by state; use this page to correct
  imbalances and to set up rules.
- **Users** — you can create, deactivate, reset passwords, and regenerate access
  codes for `cs` accounts only. You cannot manage other roles.

---

### `scraping` — Raw Leads, Browser Profiles

- **Raw Leads** — confirm the Chrome extension is still delivering posts. If new
  posts have stopped arriving, the extension is the cause, not JellyBean.
- **Browser Profiles** — check profile health. Profiles are launched from here
  for local account work; a failed launch shows a status.

---

### `acc_handler` — Map, Browser Profiles, Raw Leads, Forwarded, Manual Lead

- **Map** — the operational view. Check coverage radius and which profiles
  launched today. "Launched today" uses **Pakistan time**, so check before
  midnight PKT.
- **Browser Profiles** — launch what the day's work requires; stop what is
  finished.
- **Raw Leads / Forwarded Leads / Manual Lead** — same work as `maturing` when
  covering.

---

### `facebook` / `seo` — Submit Lead, Forwarded Leads

- **Submit Lead** — enter leads from your channel. Facebook's Reference is
  filled in automatically as **Had a conversation on FB**; SEO types its own
  reference. Service and context are required. Facebook also needs an area and
  state, and the FB Service/Area Base is checked when submitting from the form. Attach photos
  where relevant.
- **Forwarded Leads** — track leads you have submitted that are now with CS.

---

### `fb_admin` — Facebook team lead

- **Submit Lead** — use the same Facebook form and automatic FB reference as a
  `facebook` user. The FB Service/Area Base and Pakistan reporting day also
  apply. Older drafts with an ND reference use the FB reference when reopened
  or sent.
- **Forwarded Leads** — see your own submissions and the Facebook team's leads.
- **Reports / Users** — review forwarded leads by user and manage Facebook
  submitters and their access codes. A full admin creates `fb_admin` accounts.

---

### `sub_admin` — everything except CS Pipeline, Pending, Crisp, Activity log

- **Users** — create accounts, change roles, deactivate leavers, regenerate lost
  access codes. You manage `maturing`, `facebook`, `seo`, `acc_handler`.
- **Analytics**, **Reports**, **Raw Leads**, **Forwarded**, **Manual Lead**,
  **Browser Profiles**, **Map**, **Google Sheets** — full access.
- Review **Reports** for anything unusual: sudden drop in captured leads, a CS
  user with no activity, or a spike in wrong numbers.

---

### `admin` — everything

Everything `sub_admin` does, plus **CS Pipeline**, **Pending leads**,
**Crisp Chat**, and the **Activity log**.

**Weekly (not daily)**

- **Activity log** — spot-check that user provisioning and role changes look
  right. This is the audit trail.
- **Lead Assignment** — review service and state routing rules.
- **Settings → Google Sheets** — confirm the sheet is still receiving rows.
- **Crisp workspaces** — confirm each workspace is enabled and its credentials
  are healthy.
- **Users** — deactivate accounts for anyone who has left.

---

## Reference

### Raw lead outcomes

| Field         | Values                                                                  |
| ------------- | ----------------------------------------------------------------------- |
| Status        | `new` → `qualified` or `cancelled`                                      |
| Cancel reason | not a lead, general post, spam, duplicate, irrelevant, number not found |

### CS statuses (22)

**Progress** — New to contact · Called · Messaged · Follow-up · Interested ·
Processed

**Negative but useful** — Not interested · Already done · No response ·
Undeliver · Wrong number · Wrong lead · Wrong service · Wrong person ·
Already got someone · Already received before · Service provider himself ·
Small service

**Closed** — Closed (done) · Closed (lost)

### Two timezone rules that cause confusion

| Where                                             | Timezone               |
| ------------------------------------------------- | ---------------------- |
| Everything, including "launched today" on the Map | **Pakistan (PKT)**     |
| CS Pipeline date filters                          | **Eastern (New York)** |
| Anything saved to the database                    | UTC                    |

The CS Pipeline filters by Eastern date on purpose so the CS team's day lines up
with theirs. Do not "correct" a date that looks off by a few hours.

---

## When something is wrong

| Symptom                         | Do this                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| No new posts arriving           | Chrome extension is not delivering. Not a JellyBean fault.                              |
| AI classification unavailable   | `OPENAI_API_KEY` missing or out of credit. Tell an admin.                               |
| Crisp Chat empty or failing     | Admin: check the workspace is enabled and its Vault credentials are valid.              |
| Google Sheets not updating      | Admin: Settings → Google Sheets. Realtime dispatch is automatic; check the webhook URL. |
| You cannot sign in              | Your account may be deactivated, or you need a fresh access code from a manager.        |
| Access code rejected repeatedly | Ask a manager to regenerate it.                                                         |

Report anything not on this list to an admin rather than working around it.
