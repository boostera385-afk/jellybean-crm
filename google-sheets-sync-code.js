/**
 * =========================================================================
 * JELLYBEAN CRM -> GOOGLE SHEETS LIVE SYNC SCRIPT
 * Target Spreadsheet: https://docs.google.com/spreadsheets/d/1JOW5XGEsDa-ewm7Xh4BIzru8_QU_z4MFFXTZ9ZvZodE/edit
 * Release: v2.6 (Strict "New to Contact" Pipeline Engine)
 * Updated: 2026-09-07
 * =========================================================================
 *
 * EXACT COLUMNS STRUCTURE (13 Columns):
 * 1.  Lead Created Date & Time (Column A - VERY FIRST)
 * 2.  Customer Name            (Column B)
 * 3.  Customer Phone No        (Column C)
 * 4.  Area                     (Column D)
 * 5.  Service                  (Column E)
 * 6.  Status                   (Column F)
 * 7.  Number Name              (Column G)
 * 8.  Context                  (Column H)
 * 9.  Exact Customer Requirement (Column I)
 * 10. Compose                  (Column J)
 * 11. Assigned To              (Column K - THIRD LAST COLUMN)
 * 12. Important                (Column L - SECOND LAST COLUMN)
 * 13. Lead ID                  (Column M - LAST COLUMN / Tracking UUID)
 *
 * TABS / SHEETS:
 * 1. "New to Contact"   -> All leads with status "New to contact" WITHOUT Pinned Important
 * 2. "Pinned Important" -> All leads with status "New to contact" WITH Pinned Important
 *
 * SYNC BEHAVIOR:
 * - ONLY "New to contact" leads belong on these Google Sheets.
 * - ADD (INSERT): If status is "New to contact", added to Row 2 of the appropriate tab.
 * - EDIT / STATUS CHANGE (UPDATE):
 *     * If a lead's status is changed away from "New to contact" (e.g. Contacted, Quoted, Booked, Lost, etc.),
 *       it is IMMEDIATELY REMOVED from the Google Sheet, and the rows below it automatically shift UP!
 *     * If a lead remains "New to contact", its row is updated in place with any edited details.
 *     * Toggling Pinned Important moves the lead seamlessly between the two tabs.
 * - DELETE: Removes the row completely (via sheet.deleteRow), shifting all rows below it UP.
 */

const CONFIG = {
  SHEET_NEW_TO_CONTACT: "New to Contact",
  SHEET_PINNED_IMPORTANT: "Pinned Important",

  HEADERS: [
    "Lead Created Date & Time", // 1  (Column A)
    "Customer Name", // 2  (Column B)
    "Customer Phone No", // 3  (Column C)
    "Area", // 4  (Column D)
    "Service", // 5  (Column E)
    "Status", // 6  (Column F)
    "Number Name", // 7  (Column G)
    "Context", // 8  (Column H)
    "Exact Customer Requirement", // 9  (Column I)
    "Compose", // 10 (Column J)
    "Assigned To", // 11 (Column K)
    "Important", // 12 (Column L)
    "Lead ID", // 13 (Column M)
  ],
};

/**
 * Creates custom CRM menu in Google Sheets
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("⚡ Jellybean CRM")
    .addItem("Format & Setup Sheets", "setupSheets")
    .addItem("Check Webhook Status", "checkWebhookStatus")
    .addItem("Clean Blank Rows", "cleanBlankRows")
    .addToUi();
}

/**
 * Test alert to verify Apps Script is functioning
 */
function checkWebhookStatus() {
  SpreadsheetApp.getUi().alert("Jellybean CRM Sync Script is active and ready for live sync.");
}

/**
 * Creates and formats the two required sheets:
 * 1. "New to Contact"
 * 2. "Pinned Important"
 */
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const targetSheets = [CONFIG.SHEET_NEW_TO_CONTACT, CONFIG.SHEET_PINNED_IMPORTANT];

  targetSheets.forEach((name, idx) => {
    let sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name, idx);
    }

    // Set headers
    sheet.getRange(1, 1, 1, CONFIG.HEADERS.length).setValues([CONFIG.HEADERS]);

    // Style headers
    const headerRange = sheet.getRange(1, 1, 1, CONFIG.HEADERS.length);
    headerRange.setFontWeight("bold");
    headerRange.setFontSize(10);
    headerRange.setBackground(name === CONFIG.SHEET_PINNED_IMPORTANT ? "#fee2e2" : "#e0e7ff");
    headerRange.setFontColor("#0f172a");
    headerRange.setVerticalAlignment("middle");
    sheet.setRowHeight(1, 38);
    sheet.setFrozenRows(1);

    // Column widths tailored for readable CRM content
    sheet.setColumnWidth(1, 180); // Lead Created Date & Time (Column A)
    sheet.setColumnWidth(2, 180); // Customer Name
    sheet.setColumnWidth(3, 160); // Customer Phone No
    sheet.setColumnWidth(4, 140); // Area
    sheet.setColumnWidth(5, 130); // Service
    sheet.setColumnWidth(6, 130); // Status
    sheet.setColumnWidth(7, 140); // Number Name
    sheet.setColumnWidth(8, 220); // Context
    sheet.setColumnWidth(9, 240); // Exact Customer Requirement
    sheet.setColumnWidth(10, 220); // Compose
    sheet.setColumnWidth(11, 160); // Assigned To (Third last column)
    sheet.setColumnWidth(12, 130); // Important (Second last column)
    sheet.setColumnWidth(13, 120); // Lead ID (Last column)
  });

  // Remove default blank "Sheet1" if target sheets exist
  const defaultSheet = ss.getSheetByName("Sheet1");
  if (defaultSheet && ss.getSheets().length > 1) {
    try {
      ss.deleteSheet(defaultSheet);
    } catch (e) {}
  }

  SpreadsheetApp.getActiveSpreadsheet().toast(
    "Sheets formatted! 13 columns configured successfully.",
    "Jellybean CRM",
  );
}

/**
 * Removes any empty trailing rows to keep the sheet compact and fast
 */
function cleanBlankRows() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = [
    ss.getSheetByName(CONFIG.SHEET_NEW_TO_CONTACT),
    ss.getSheetByName(CONFIG.SHEET_PINNED_IMPORTANT),
  ];

  sheets.forEach((sheet) => {
    if (!sheet) return;
    const maxRows = sheet.getMaxRows();
    const lastRow = sheet.getLastRow();
    if (maxRows > lastRow && lastRow > 1) {
      try {
        sheet.deleteRows(lastRow + 1, maxRows - lastRow);
      } catch (e) {}
    }
  });
  SpreadsheetApp.getActiveSpreadsheet().toast("Blank rows cleaned up!", "Jellybean CRM");
}

/**
 * Formats status strings into human-readable CRM labels
 */
function formatStatus(rawStatus) {
  if (!rawStatus) return "New to contact";
  const s = String(rawStatus).trim().toLowerCase();
  if (s === "new" || s === "new to contact") return "New to contact";
  if (s === "old_lead" || s === "old leads") return "Old Leads";
  if (s === "converted" || s === "processed" || s === "delivered") return "Delivered";
  if (s === "cx_interested") return "CX interested";
  if (s === "cx_not_interested") return "CX not interested";
  if (s === "cx_didnt_replied") return "CX didn't replied";
  if (s === "contacted") return "Contacted";
  if (s === "followup" || s === "follow_up" || s === "follow up") return "Follow Up";
  if (s === "quoted") return "Quoted";
  if (s === "booked") return "Booked";
  if (s === "lost") return "Lost";
  if (s === "won") return "Won";
  if (s === "pending") return "Pending";
  if (s === "archive" || s === "archived") return "Archived";
  return rawStatus.charAt(0).toUpperCase() + rawStatus.slice(1);
}

/**
 * Validates whether a lead has "New to contact" status
 */
function isNewToContact(rawStatus) {
  if (!rawStatus) return true;
  const s = String(rawStatus).trim().toLowerCase();
  return s === "new" || s === "new to contact" || s === "new_to_contact";
}

/**
 * Transforms a CRM Lead object into a 13-column array matching exact requirements
 */
function leadToRow(lead) {
  // 1. Created Date & Time (Column A)
  let createdDate = lead.created_at || lead.assigned_at || "";
  if (createdDate) {
    try {
      const d = new Date(createdDate);
      if (!isNaN(d.getTime())) {
        createdDate = Utilities.formatDate(
          d,
          Session.getScriptTimeZone() || "GMT+5",
          "yyyy-MM-dd HH:mm:ss",
        );
      }
    } catch (e) {}
  }

  // 3. Customer Phone No (Combine main + secondary if available)
  const phone = lead.customer_number_2
    ? `${lead.customer_number || ""}, ${lead.customer_number_2}`
    : lead.customer_number || "";

  // 4. Area
  const area = lead.main_area || lead.sub_area || lead.area || "";

  // 6. Status
  const status = formatStatus(lead.cs_status);

  // 9. Exact Customer Requirement
  const exactRequirement =
    lead.requirement_1 ||
    lead.requirement_2 ||
    lead.post_text ||
    lead.exact_requirement ||
    lead.context ||
    "";

  // 10. Compose
  const compose = lead.marketing_notes || lead.compose || "";

  // 11. Assigned To (Third Last Column - Resolved Staff Name)
  const assignedName =
    lead.assigned_to_name ||
    (lead.assigned_to && !lead.assigned_to.includes("-") ? lead.assigned_to : "Unassigned");

  // 12. Important (Second Last Column)
  let importantStatus = "No";
  if (lead.pinned_important === true) {
    importantStatus = "Pinned Important";
  } else if (lead.is_important === true) {
    importantStatus = "Important";
  }

  return [
    createdDate, // 1. Lead Created Date & Time (Column A)
    lead.customer_name || "", // 2. Customer Name
    phone, // 3. Customer Phone No
    area, // 4. Area
    lead.service || lead.pass_it_to || "", // 5. Service
    status, // 6. Status
    lead.number_name || "", // 7. Number Name
    lead.context || "", // 8. Context
    exactRequirement, // 9. Exact Customer Requirement
    compose, // 10. Compose
    assignedName, // 11. Assigned To (THIRD LAST COLUMN)
    importantStatus, // 12. Important (SECOND LAST COLUMN)
    lead.id || "", // 13. Lead ID (LAST COLUMN)
  ];
}

/**
 * Helper to extract raw digits from phone string(s)
 */
function extractDigitsList(phoneStr) {
  if (!phoneStr) return [];
  return String(phoneStr)
    .split(/[,/|]/)
    .map(function (p) {
      return p.replace(/\D/g, "");
    })
    .filter(function (p) {
      return p.length >= 7;
    });
}

/**
 * Handles GET requests (for browser/curl testing)
 */
function doGet(e) {
  return ContentService.createTextOutput(
    JSON.stringify({
      status: "active",
      message: "Jellybean CRM Google Sheets Sync Engine is live!",
      time: new Date().toISOString(),
    }),
  ).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Main Webhook Receiver: Handles POST requests from Jellybean CRM
 * Supports: PING, BULK_SYNC, INSERT, UPDATE, DELETE
 */
function doPost(e) {
  // Use ScriptLock to serialize requests and prevent simultaneous race conditions
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000); // Wait up to 30 seconds for lock
  } catch (lockErr) {
    return jsonResponse(
      { error: "Server busy, could not acquire script lock", details: lockErr.toString() },
      429,
    );
  }

  try {
    let payload = {};
    if (e && e.postData && e.postData.contents) {
      try {
        payload = JSON.parse(e.postData.contents);
      } catch (parseErr) {
        payload = e.parameter || {};
      }
    } else if (e && e.parameter) {
      payload = e.parameter;
    }

    // Handle nested payload.data string if passed as form-encoded
    if (payload.data && typeof payload.data === "string") {
      try {
        payload = JSON.parse(payload.data);
      } catch (err) {}
    }

    const eventType = (payload.type || payload.action || "").toUpperCase();
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheetNew =
      ss.getSheetByName(CONFIG.SHEET_NEW_TO_CONTACT) || ss.insertSheet(CONFIG.SHEET_NEW_TO_CONTACT);
    const sheetPinned =
      ss.getSheetByName(CONFIG.SHEET_PINNED_IMPORTANT) ||
      ss.insertSheet(CONFIG.SHEET_PINNED_IMPORTANT);

    // Ensure header row exists on both sheets
    ensureHeaders(sheetNew, false);
    ensureHeaders(sheetPinned, true);

    // ── 1. TEST PING ──
    if (eventType === "PING") {
      return jsonResponse({
        status: "ok",
        message: "Connected to Google Sheets successfully! Ready for live sync.",
        spreadsheet: ss.getName(),
      });
    }

    // ── 2. BULK SYNC / BATCH SYNC ──
    if (eventType === "BULK_SYNC" || eventType === "BATCH_SYNC") {
      setupSheets();
      const leads = payload.leads || [];
      const isChunked = payload.total_chunks && payload.total_chunks > 1;
      const isFirstChunk =
        !isChunked || payload.chunk_index === 0 || payload.is_first_chunk === true;

      // Only clear existing data rows on the first chunk or single full sync
      if (isFirstChunk) {
        const lastNew = sheetNew.getLastRow();
        if (lastNew > 1) {
          sheetNew.getRange(2, 1, lastNew - 1, CONFIG.HEADERS.length).clearContent();
        }
        const lastPinned = sheetPinned.getLastRow();
        if (lastPinned > 1) {
          sheetPinned.getRange(2, 1, lastPinned - 1, CONFIG.HEADERS.length).clearContent();
        }
        SpreadsheetApp.flush();
      }

      const unpinnedNewRows = [];
      const pinnedRows = [];

      leads.forEach(function (l) {
        // Strictly only process "New to contact" leads
        if (!isNewToContact(l.cs_status)) return;
        const row = leadToRow(l);
        if (l.pinned_important === true) {
          pinnedRows.push(row);
        } else {
          unpinnedNewRows.push(row);
        }
      });

      if (unpinnedNewRows.length > 0) {
        const startRow = sheetNew.getLastRow() + 1;
        ensureCapacity(sheetNew, startRow + unpinnedNewRows.length);
        sheetNew
          .getRange(startRow, 1, unpinnedNewRows.length, CONFIG.HEADERS.length)
          .setValues(unpinnedNewRows);
      }
      if (pinnedRows.length > 0) {
        const startRow = sheetPinned.getLastRow() + 1;
        ensureCapacity(sheetPinned, startRow + pinnedRows.length);
        sheetPinned
          .getRange(startRow, 1, pinnedRows.length, CONFIG.HEADERS.length)
          .setValues(pinnedRows);
      }

      SpreadsheetApp.flush();

      return jsonResponse({
        status: "success",
        chunkIndex: payload.chunk_index || 0,
        totalChunks: payload.total_chunks || 1,
        unpinnedCount: unpinnedNewRows.length,
        pinnedCount: pinnedRows.length,
      });
    }

    // Extract lead details
    const rec = payload.record || payload.lead || {};
    const oldRec = payload.old_record || payload.old_lead || {};
    const leadId = rec.id || oldRec.id || payload.leadId || "";
    const phone = rec.customer_number || oldRec.customer_number || payload.customer_number || "";
    const name = rec.customer_name || oldRec.customer_name || payload.customer_name || "";

    if (!leadId && !phone && !name) {
      return jsonResponse({ error: "Missing lead identifier (id, phone, or name)" }, 400);
    }

    // ── 3. DELETE ACTION ──
    // Deletes the row completely using sheet.deleteRow.
    // All rows below it automatically shift UP to fill the empty space!
    if (eventType === "DELETE") {
      const deletedFromNew = deleteLeadRow(sheetNew, leadId, phone, name);
      const deletedFromPinned = deleteLeadRow(sheetPinned, leadId, phone, name);
      return jsonResponse({
        success: true,
        action: "DELETED",
        leadId: leadId,
        rowsShifted: true,
        deletedFromNew: deletedFromNew,
        deletedFromPinned: deletedFromPinned,
      });
    }

    // ── 4. INSERT / UPDATE ACTION ──
    // Sheets ONLY maintain "New to contact" leads.
    // If a lead changes status to anything else (e.g. Contacted, Quoted, Booked, Lost),
    // it is automatically removed from the sheets, shifting subsequent rows UP!
    const rowValues = leadToRow(rec);
    const isPinned = rec.pinned_important === true;
    const isNew = isNewToContact(rec.cs_status);

    if (eventType === "UPDATE" || eventType === "INSERT") {
      // If lead is no longer "New to contact", remove from both sheets
      if (!isNew) {
        const deletedFromNew = deleteLeadRow(sheetNew, leadId, phone, name);
        const deletedFromPinned = deleteLeadRow(sheetPinned, leadId, phone, name);
        return jsonResponse({
          success: true,
          action: "REMOVED_STATUS_CHANGED",
          status: rec.cs_status,
          leadId: leadId,
          rowsShifted: true,
          deletedFromNew: deletedFromNew,
          deletedFromPinned: deletedFromPinned,
        });
      }

      // If lead is "New to contact":
      if (isPinned) {
        // Remove from unpinned sheet if it was previously there
        deleteLeadRow(sheetNew, leadId, phone, name);
        // Upsert into pinned sheet
        upsertLeadRow(sheetPinned, leadId, rowValues);
      } else {
        // Remove from pinned sheet if it was previously pinned
        deleteLeadRow(sheetPinned, leadId, phone, name);
        // Upsert into unpinned sheet
        upsertLeadRow(sheetNew, leadId, rowValues);
      }

      return jsonResponse({
        success: true,
        action: eventType,
        sheet: isPinned ? CONFIG.SHEET_PINNED_IMPORTANT : CONFIG.SHEET_NEW_TO_CONTACT,
        leadId: leadId,
      });
    }

    return jsonResponse({ message: "No matching action handler for: " + eventType });
  } catch (err) {
    return jsonResponse({ error: err.toString(), stack: err.stack }, 500);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Ensures a sheet has at least requiredRows rows to prevent out-of-bounds range errors
 */
function ensureCapacity(sheet, requiredRows) {
  const currentMax = sheet.getMaxRows();
  if (currentMax < requiredRows) {
    sheet.insertRowsAfter(currentMax, requiredRows - currentMax);
  }
}

/**
 * Guarantees headers are present and styled on the sheet
 */
function ensureHeaders(sheet, isPinned) {
  if (sheet.getLastRow() < 1) {
    sheet.getRange(1, 1, 1, CONFIG.HEADERS.length).setValues([CONFIG.HEADERS]);
    const headerRange = sheet.getRange(1, 1, 1, CONFIG.HEADERS.length);
    headerRange.setFontWeight("bold");
    headerRange.setFontSize(10);
    headerRange.setBackground(isPinned ? "#fee2e2" : "#e0e7ff");
    headerRange.setFontColor("#0f172a");
    headerRange.setVerticalAlignment("middle");
    sheet.setRowHeight(1, 38);
    sheet.setFrozenRows(1);
  }
}

/**
 * Inserts a lead row at Row 2 (directly below headers, top of table)
 * and shifts all existing rows down
 */
function insertLeadAtTop(sheet, rowValues) {
  ensureHeaders(sheet, sheet.getName() === CONFIG.SHEET_PINNED_IMPORTANT);
  sheet.insertRowBefore(2);
  sheet.getRange(2, 1, 1, rowValues.length).setValues([rowValues]);
  sheet.setRowHeight(2, 32);
}

/**
 * Updates an existing lead row in place, or inserts it at Row 2 if not found
 */
function upsertLeadRow(sheet, leadId, rowValues) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    insertLeadAtTop(sheet, rowValues);
    return;
  }

  const cleanId = leadId ? String(leadId).trim().toLowerCase() : "";
  const phoneDigitsList = extractDigitsList(rowValues[2]);
  const cleanName = rowValues[1] ? String(rowValues[1]).trim().toLowerCase() : "";

  const data = sheet.getRange(2, 1, lastRow - 1, CONFIG.HEADERS.length).getValues();
  for (let i = 0; i < data.length; i++) {
    const rowId = String(data[i][12] || "")
      .trim()
      .toLowerCase();
    const rowPhoneDigits = String(data[i][2] || "").replace(/\D/g, "");
    const rowName = String(data[i][1] || "")
      .trim()
      .toLowerCase();

    let match = false;
    // 1. Match by Lead ID
    if (cleanId && rowId && rowId === cleanId) {
      match = true;
    } else if (!cleanId || !rowId) {
      // 2. Fallback match by phone number
      if (phoneDigitsList.length > 0 && rowPhoneDigits.length >= 7) {
        for (let p = 0; p < phoneDigitsList.length; p++) {
          if (
            rowPhoneDigits.indexOf(phoneDigitsList[p]) !== -1 ||
            phoneDigitsList[p].indexOf(rowPhoneDigits) !== -1
          ) {
            match = true;
            break;
          }
        }
      }
      // 3. Fallback match by customer name
      if (!match && cleanName && cleanName.length >= 3 && rowName === cleanName) {
        match = true;
      }
    }

    if (match) {
      const rowPosition = i + 2;
      // Preserve existing cell values if the incoming update payload left them empty
      for (let col = 0; col < CONFIG.HEADERS.length; col++) {
        if (
          (rowValues[col] === "" || rowValues[col] === null || rowValues[col] === undefined) &&
          data[i][col] !== "" &&
          data[i][col] !== null &&
          data[i][col] !== undefined
        ) {
          rowValues[col] = data[i][col];
        }
      }
      // If row did not have Lead ID previously, ensure it is written now
      if (!rowValues[12] && cleanId) {
        rowValues[12] = cleanId;
      }
      sheet.getRange(rowPosition, 1, 1, rowValues.length).setValues([rowValues]);
      return;
    }
  }

  // If not found in sheet, insert at top (Row 2)
  insertLeadAtTop(sheet, rowValues);
}

/**
 * Deletes lead row and automatically shifts all rows below it UP
 * Loops backwards to preserve row indices during deletion
 */
function deleteLeadRow(sheet, leadId, fallbackPhone, fallbackName) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;

  const data = sheet.getRange(2, 1, lastRow - 1, CONFIG.HEADERS.length).getValues();
  const cleanId = leadId ? String(leadId).trim().toLowerCase() : "";
  const phoneDigitsList = extractDigitsList(fallbackPhone);
  const cleanName = fallbackName ? String(fallbackName).trim().toLowerCase() : "";

  let deletedCount = 0;

  // Search backwards so deleting a row does not distort subsequent indices
  for (let i = data.length - 1; i >= 0; i--) {
    const rowId = String(data[i][12] || "")
      .trim()
      .toLowerCase();
    const rowPhoneDigits = String(data[i][2] || "").replace(/\D/g, "");
    const rowName = String(data[i][1] || "")
      .trim()
      .toLowerCase();

    let match = false;
    // 1. Match by Lead ID
    if (cleanId && rowId && rowId === cleanId) {
      match = true;
    } else if (!cleanId || !rowId) {
      // 2. Fallback match by phone
      if (phoneDigitsList.length > 0 && rowPhoneDigits.length >= 7) {
        for (let p = 0; p < phoneDigitsList.length; p++) {
          if (
            rowPhoneDigits.indexOf(phoneDigitsList[p]) !== -1 ||
            phoneDigitsList[p].indexOf(rowPhoneDigits) !== -1
          ) {
            match = true;
            break;
          }
        }
      }
      // 3. Fallback match by customer name
      if (!match && cleanName && cleanName.length >= 3 && rowName === cleanName) {
        match = true;
      }
    }

    if (match) {
      const rowPosition = i + 2;
      sheet.deleteRow(rowPosition);
      deletedCount++;
    }
  }

  return deletedCount > 0;
}

function jsonResponse(data, code) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
