# CRM Webhook Contract

The extension can now send leads directly to a CRM webhook. The CRM endpoint should accept JSON `POST` requests and return JSON responses using the same contract the old Sheets Apps Script used.

## Endpoint

Configure this URL in the extension popup under `CRM Connection`.

Example:

```text
https://your-crm.com/api/public/nextdoor-leads
```

For local testing, `http://localhost/...` and `http://127.0.0.1/...` are also allowed by the extension manifest.

## Common Request Fields

Every request includes:

```json
{
  "schemaVersion": "2026-04-08.nd.v1",
  "action": "test_connection"
}
```

The CRM should reject unknown or missing schema versions if you want strict compatibility.

## Test Connection

Request:

```json
{
  "schemaVersion": "2026-04-08.nd.v1",
  "action": "test_connection"
}
```

Successful response:

```json
{
  "schemaVersion": "2026-04-08.nd.v1",
  "ok": true,
  "status": "ok"
}
```

## Append Leads

Request:

```json
{
  "schemaVersion": "2026-04-08.nd.v1",
  "action": "append_rows",
  "source": "account-boosters-nd-ext",
  "sentAt": "2026-06-08T12:00:00.000Z",
  "rows": [
    {
      "accountName": "Jane Neighbor",
      "subArea": "Rancho Palos Verdes",
      "postDateTime": "Today at 9:15 AM",
      "postText": "Looking for a garage door repair company.",
      "profileLink": "https://nextdoor.com/profile/...",
      "postLink": "https://nextdoor.com/p/...",
      "finalLink": "https://nextdoor.com/p/...",
      "capturedDate": "2026-06-08",
      "capturedTime": "12:00:00",
      "captureDateTime": "2026-06-08T12:00:00.000Z",
      "accountArea": "Los Angeles",
      "incogAccount": "Profile A",
      "postId": "stable-client-id",
      "sourceMode": "recent",
      "linkStatus": "resolved",
      "linkAttempts": 1
    }
  ]
}
```

Successful response:

```json
{
  "schemaVersion": "2026-04-08.nd.v1",
  "ok": true,
  "status": "ok",
  "added": 1,
  "acceptedIds": ["stable-client-id"],
  "skippedIds": [],
  "skippedReasons": {}
}
```

If a lead is a duplicate, return its identifier in `skippedIds` and increment `skippedReasons.duplicate`.

## Required CRM Behavior

- Store leads directly in CRM lead/contact tables instead of Google Sheets.
- Deduplicate by `postId`, then by lead link, then by author/time/text when no stable ID is available.
- Return `acceptedIds` and `skippedIds` using the same identifier logic so the extension can mark sync status correctly.
- Return HTTP 200 for handled CRM-level failures with `{ "ok": false, "reason": "..." }`, or a non-2xx response for infrastructure/auth failures.
