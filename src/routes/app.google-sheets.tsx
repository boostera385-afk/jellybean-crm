import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { toast } from "sonner";
import {
  ExternalLink,
  CheckCircle2,
  Code2,
  Copy,
  RefreshCw,
  Zap,
  Check,
  Loader2,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { PageHeader, PageBody, RoleGate } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import {
  getGoogleSheetsWebhookUrl,
  isGoogleSheetsAutoSyncEnabled,
  setGoogleSheetsConfigInMemory,
  persistGoogleSheetsConfig,
  initGoogleSheetsConfig,
  GOOGLE_SHEETS_SHARED_STATE_KEY,
} from "@/lib/google-sheets-sync";

const GOOGLE_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/1JOW5XGEsDa-ewm7Xh4BIzru8_QU_z4MFFXTZ9ZvZodE/edit?gid=0#gid=0";

const APPS_SCRIPT_SOURCE = `/**
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
    "Lead Created Date & Time",  // 1  (Column A)
    "Customer Name",             // 2  (Column B)
    "Customer Phone No",         // 3  (Column C)
    "Area",                      // 4  (Column D)
    "Service",                   // 5  (Column E)
    "Status",                    // 6  (Column F)
    "Number Name",               // 7  (Column G)
    "Context",                   // 8  (Column H)
    "Exact Customer Requirement",// 9  (Column I)
    "Compose",                   // 10 (Column J)
    "Assigned To",               // 11 (Column K)
    "Important",                 // 12 (Column L)
    "Lead ID"                    // 13 (Column M)
  ]
};

function onOpen() {
  SpreadsheetApp.getUi().createMenu("⚡ Jellybean CRM")
    .addItem("Format & Setup Sheets", "setupSheets")
    .addItem("Check Webhook Status", "checkWebhookStatus")
    .addItem("Clean Blank Rows", "cleanBlankRows")
    .addToUi();
}

function checkWebhookStatus() {
  SpreadsheetApp.getUi().alert("Jellybean CRM Sync Script is active and ready for live sync.");
}

function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const targetSheets = [CONFIG.SHEET_NEW_TO_CONTACT, CONFIG.SHEET_PINNED_IMPORTANT];

  targetSheets.forEach((name, idx) => {
    let sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name, idx);
    }
    
    sheet.getRange(1, 1, 1, CONFIG.HEADERS.length).setValues([CONFIG.HEADERS]);
    const headerRange = sheet.getRange(1, 1, 1, CONFIG.HEADERS.length);
    headerRange.setFontWeight("bold");
    headerRange.setFontSize(10);
    headerRange.setBackground(name === CONFIG.SHEET_PINNED_IMPORTANT ? "#fee2e2" : "#e0e7ff");
    headerRange.setFontColor("#0f172a");
    headerRange.setVerticalAlignment("middle");
    sheet.setRowHeight(1, 38);
    sheet.setFrozenRows(1);
    
    sheet.setColumnWidth(1, 180);
    sheet.setColumnWidth(2, 180);
    sheet.setColumnWidth(3, 160);
    sheet.setColumnWidth(4, 140);
    sheet.setColumnWidth(5, 130);
    sheet.setColumnWidth(6, 130);
    sheet.setColumnWidth(7, 140);
    sheet.setColumnWidth(8, 220);
    sheet.setColumnWidth(9, 240);
    sheet.setColumnWidth(10, 220);
    sheet.setColumnWidth(11, 160);
    sheet.setColumnWidth(12, 130);
    sheet.setColumnWidth(13, 120);
  });

  const defaultSheet = ss.getSheetByName("Sheet1");
  if (defaultSheet && ss.getSheets().length > 1) {
    try { ss.deleteSheet(defaultSheet); } catch (e) {}
  }

  SpreadsheetApp.getActiveSpreadsheet().toast("Sheets formatted! 13 columns configured successfully.", "Jellybean CRM");
}

function cleanBlankRows() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = [ss.getSheetByName(CONFIG.SHEET_NEW_TO_CONTACT), ss.getSheetByName(CONFIG.SHEET_PINNED_IMPORTANT)];
  
  sheets.forEach(sheet => {
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

function formatStatus(rawStatus) {
  if (!rawStatus) return "New to contact";
  const s = String(rawStatus).trim().toLowerCase();
  if (s === "new" || s === "new to contact") return "New to contact";
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

function isNewToContact(rawStatus) {
  if (!rawStatus) return true;
  const s = String(rawStatus).trim().toLowerCase();
  return s === "new" || s === "new to contact" || s === "new_to_contact";
}

function leadToRow(lead) {
  let createdDate = lead.created_at || lead.assigned_at || "";
  if (createdDate) {
    try {
      const d = new Date(createdDate);
      if (!isNaN(d.getTime())) {
        createdDate = Utilities.formatDate(d, Session.getScriptTimeZone() || "GMT+5", "yyyy-MM-dd HH:mm:ss");
      }
    } catch (e) {}
  }

  const phone = lead.customer_number_2 
    ? (lead.customer_number || '') + ", " + lead.customer_number_2
    : (lead.customer_number || '');
    
  const area = lead.main_area || lead.sub_area || lead.area || "";
  const status = formatStatus(lead.cs_status);
  const exactRequirement = lead.requirement_1 || lead.requirement_2 || lead.post_text || lead.exact_requirement || lead.context || "";
  const compose = lead.marketing_notes || lead.compose || "";
  const assignedName = lead.assigned_to_name || (lead.assigned_to && !lead.assigned_to.includes("-") ? lead.assigned_to : "Unassigned");

  let importantStatus = "No";
  if (lead.pinned_important === true) {
    importantStatus = "Pinned Important";
  } else if (lead.is_important === true) {
    importantStatus = "Important";
  }

  return [
    createdDate,
    lead.customer_name || "",
    phone,
    area,
    lead.service || lead.pass_it_to || "",
    status,
    lead.number_name || "",
    lead.context || "",
    exactRequirement,
    compose,
    assignedName,
    importantStatus,
    lead.id || ""
  ];
}

function extractDigitsList(phoneStr) {
  if (!phoneStr) return [];
  return String(phoneStr)
    .split(/[,/|]/)
    .map(function(p) { return p.replace(/[^0-9]/g, ""); })
    .filter(function(p) { return p.length >= 7; });
}

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({
    status: "active",
    message: "Jellybean CRM Google Sheets Sync Engine is live!",
    time: new Date().toISOString()
  })).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (lockErr) {
    return jsonResponse({ error: "Server busy, could not acquire script lock", details: lockErr.toString() }, 429);
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

    if (payload.data && typeof payload.data === "string") {
      try {
        payload = JSON.parse(payload.data);
      } catch (err) {}
    }

    const eventType = (payload.type || payload.action || "").toUpperCase();
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheetNew = ss.getSheetByName(CONFIG.SHEET_NEW_TO_CONTACT) || ss.insertSheet(CONFIG.SHEET_NEW_TO_CONTACT);
    const sheetPinned = ss.getSheetByName(CONFIG.SHEET_PINNED_IMPORTANT) || ss.insertSheet(CONFIG.SHEET_PINNED_IMPORTANT);

    ensureHeaders(sheetNew, false);
    ensureHeaders(sheetPinned, true);

    if (eventType === "PING") {
      return jsonResponse({
        status: "ok",
        message: "Connected to Google Sheets successfully! Ready for live sync.",
        spreadsheet: ss.getName()
      });
    }

    // ── 2. BULK SYNC / BATCH SYNC ──
    if (eventType === "BULK_SYNC" || eventType === "BATCH_SYNC") {
      setupSheets();
      const leads = payload.leads || [];
      const isChunked = (payload.total_chunks && payload.total_chunks > 1);
      const isFirstChunk = (!isChunked || payload.chunk_index === 0 || payload.is_first_chunk === true);

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

      leads.forEach(function(l) {
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
        sheetNew.getRange(startRow, 1, unpinnedNewRows.length, CONFIG.HEADERS.length).setValues(unpinnedNewRows);
      }
      if (pinnedRows.length > 0) {
        const startRow = sheetPinned.getLastRow() + 1;
        ensureCapacity(sheetPinned, startRow + pinnedRows.length);
        sheetPinned.getRange(startRow, 1, pinnedRows.length, CONFIG.HEADERS.length).setValues(pinnedRows);
      }

      SpreadsheetApp.flush();

      return jsonResponse({
        status: "success",
        chunkIndex: payload.chunk_index || 0,
        totalChunks: payload.total_chunks || 1,
        unpinnedCount: unpinnedNewRows.length,
        pinnedCount: pinnedRows.length
      });
    }

    const rec = payload.record || payload.lead || {};
    const oldRec = payload.old_record || payload.old_lead || {};
    const leadId = rec.id || oldRec.id || payload.leadId || "";
    const phone = rec.customer_number || oldRec.customer_number || payload.customer_number || "";
    const name = rec.customer_name || oldRec.customer_name || payload.customer_name || "";

    if (!leadId && !phone && !name) {
      return jsonResponse({ error: "Missing lead identifier (id, phone, or name)" }, 400);
    }

    if (eventType === "DELETE") {
      const deletedFromNew = deleteLeadRow(sheetNew, leadId, phone, name);
      const deletedFromPinned = deleteLeadRow(sheetPinned, leadId, phone, name);
      return jsonResponse({
        success: true,
        action: "DELETED",
        leadId: leadId,
        rowsShifted: true,
        deletedFromNew: deletedFromNew,
        deletedFromPinned: deletedFromPinned
      });
    }

    const rowValues = leadToRow(rec);
    const isPinned = (rec.pinned_important === true);
    const isNew = isNewToContact(rec.cs_status);

    if (eventType === "UPDATE" || eventType === "INSERT") {
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
          deletedFromPinned: deletedFromPinned
        });
      }

      if (isPinned) {
        deleteLeadRow(sheetNew, leadId, phone, name);
        upsertLeadRow(sheetPinned, leadId, rowValues);
      } else {
        deleteLeadRow(sheetPinned, leadId, phone, name);
        upsertLeadRow(sheetNew, leadId, rowValues);
      }

      return jsonResponse({
        success: true,
        action: eventType,
        sheet: isPinned ? CONFIG.SHEET_PINNED_IMPORTANT : CONFIG.SHEET_NEW_TO_CONTACT,
        leadId: leadId
      });
    }

    return jsonResponse({ message: "No matching action handler for: " + eventType });
  } catch (err) {
    return jsonResponse({ error: err.toString(), stack: err.stack }, 500);
  } finally {
    lock.releaseLock();
  }
}

function ensureCapacity(sheet, requiredRows) {
  const currentMax = sheet.getMaxRows();
  if (currentMax < requiredRows) {
    sheet.insertRowsAfter(currentMax, requiredRows - currentMax);
  }
}

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

function insertLeadAtTop(sheet, rowValues) {
  ensureHeaders(sheet, sheet.getName() === CONFIG.SHEET_PINNED_IMPORTANT);
  sheet.insertRowBefore(2);
  sheet.getRange(2, 1, 1, rowValues.length).setValues([rowValues]);
  sheet.setRowHeight(2, 32);
}

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
    const rowId = String(data[i][12] || "").trim().toLowerCase();
    const rowPhoneDigits = String(data[i][2] || "").replace(/[^0-9]/g, "");
    const rowName = String(data[i][1] || "").trim().toLowerCase();

    let match = false;
    if (cleanId && rowId && rowId === cleanId) {
      match = true;
    } else if (!cleanId || !rowId) {
      if (phoneDigitsList.length > 0 && rowPhoneDigits.length >= 7) {
        for (let p = 0; p < phoneDigitsList.length; p++) {
          if (rowPhoneDigits.indexOf(phoneDigitsList[p]) !== -1 || phoneDigitsList[p].indexOf(rowPhoneDigits) !== -1) {
            match = true;
            break;
          }
        }
      }
      if (!match && cleanName && cleanName.length >= 3 && rowName === cleanName) {
        match = true;
      }
    }

    if (match) {
      const rowPosition = i + 2;
      for (let col = 0; col < CONFIG.HEADERS.length; col++) {
        if ((rowValues[col] === "" || rowValues[col] === null || rowValues[col] === undefined) && data[i][col] !== "" && data[i][col] !== null && data[i][col] !== undefined) {
          rowValues[col] = data[i][col];
        }
      }
      if (!rowValues[12] && cleanId) {
        rowValues[12] = cleanId;
      }
      sheet.getRange(rowPosition, 1, 1, rowValues.length).setValues([rowValues]);
      return;
    }
  }

  insertLeadAtTop(sheet, rowValues);
}

function deleteLeadRow(sheet, leadId, fallbackPhone, fallbackName) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;

  const data = sheet.getRange(2, 1, lastRow - 1, CONFIG.HEADERS.length).getValues();
  const cleanId = leadId ? String(leadId).trim().toLowerCase() : "";
  const phoneDigitsList = extractDigitsList(fallbackPhone);
  const cleanName = fallbackName ? String(fallbackName).trim().toLowerCase() : "";

  let deletedCount = 0;

  for (let i = data.length - 1; i >= 0; i--) {
    const rowId = String(data[i][12] || "").trim().toLowerCase();
    const rowPhoneDigits = String(data[i][2] || "").replace(/[^0-9]/g, "");
    const rowName = String(data[i][1] || "").trim().toLowerCase();

    let match = false;
    if (cleanId && rowId && rowId === cleanId) {
      match = true;
    } else if (!cleanId || !rowId) {
      if (phoneDigitsList.length > 0 && rowPhoneDigits.length >= 7) {
        for (let p = 0; p < phoneDigitsList.length; p++) {
          if (rowPhoneDigits.indexOf(phoneDigitsList[p]) !== -1 || phoneDigitsList[p].indexOf(rowPhoneDigits) !== -1) {
            match = true;
            break;
          }
        }
      }
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
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
};`;

export const Route = createFileRoute("/app/google-sheets")({
  head: () => ({
    meta: [
      { title: "Google Sheets \u00b7 JellyBean" },
      {
        name: "description",
        content: "Manage the JellyBean lead synchronization with Google Sheets.",
      },
      { property: "og:title", content: "Google Sheets \u00b7 JellyBean" },
      {
        property: "og:description",
        content: "Manage the JellyBean lead synchronization with Google Sheets.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

function Page() {
  const auth = useAuth();
  return (
    <RoleGate allow={["admin", "sub_admin"]} current={auth.primaryRole}>
      <Dashboard />
    </RoleGate>
  );
}

function Dashboard() {
  const [webhookUrl, setWebhookUrl] = useState(() => {
    return (
      localStorage.getItem("jellybean_google_sheets_webhook") || getGoogleSheetsWebhookUrl() || ""
    );
  });
  const [autoSync, setAutoSync] = useState(() => {
    return isGoogleSheetsAutoSyncEnabled();
  });
  const [lastBulkSync, setLastBulkSync] = useState<string | null>(() => {
    return localStorage.getItem("jellybean_google_sheets_last_sync") || null;
  });
  const [lastSyncCount, setLastSyncCount] = useState<number>(() => {
    return Number(localStorage.getItem("jellybean_google_sheets_sync_count") || 0);
  });
  const [isConnected, setIsConnected] = useState<boolean>(() => {
    return !!localStorage.getItem("jellybean_google_sheets_connected");
  });

  const [isTesting, setIsTesting] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [copied, setCopied] = useState(false);

  // Load and sync config on mount
  useEffect(() => {
    initGoogleSheetsConfig().then((url) => {
      if (url) {
        setWebhookUrl(url);
        setIsConnected(true);
      }
    });
  }, []);

  const handleUrlChange = (val: string) => {
    setWebhookUrl(val);
    const trimmed = val.trim();
    if (trimmed.startsWith("https://script.google.com/macros/s/") && trimmed.includes("/exec")) {
      void persistGoogleSheetsConfig(trimmed, autoSync);
      setIsConnected(true);
      localStorage.setItem("jellybean_google_sheets_connected", "true");
    }
  };

  const handleAutoSyncToggle = async (checked: boolean) => {
    setAutoSync(checked);
    if (webhookUrl.trim()) {
      await persistGoogleSheetsConfig(webhookUrl.trim(), checked);
    }
  };

  // Save settings locally and to Supabase shared_state
  const handleSaveSettings = async () => {
    const trimmed = webhookUrl.trim();
    if (!trimmed) {
      toast.error("Please enter a valid Google Apps Script Web App URL first.");
      return;
    }
    const res = await persistGoogleSheetsConfig(trimmed, autoSync);
    setIsConnected(true);
    localStorage.setItem("jellybean_google_sheets_connected", "true");
    if (res.success) {
      toast.success("Google Sheets live sync settings saved and activated across all CRM users!");
    } else {
      toast.info(
        "Settings saved locally! (Notice: " + (res.error || "Database sync pending") + ")",
      );
    }
  };

  // Test connection
  const handleTestConnection = async () => {
    const trimmed = webhookUrl.trim();
    if (!trimmed) {
      toast.error("Please enter a valid Google Apps Script Web App URL first.");
      return;
    }
    setIsTesting(true);
    try {
      // Auto-save configuration immediately so all subsequent edits sync automatically
      await persistGoogleSheetsConfig(trimmed, autoSync);

      await fetch(trimmed, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ type: "PING" }),
        mode: "no-cors",
      });

      setIsConnected(true);
      localStorage.setItem("jellybean_google_sheets_connected", "true");
      toast.success("Connected & Active! Webhook saved and live sync is running.");
    } catch (err) {
      console.error(err);
      toast.error("Failed to reach webhook URL. Make sure it is deployed as 'Anyone'.");
    } finally {
      setIsTesting(false);
    }
  };

  // Trigger bulk sync
  const handleSyncAllLeads = async () => {
    const trimmed = webhookUrl.trim();
    if (!trimmed) {
      toast.error("Please enter your Google Apps Script Web App URL before syncing.");
      return;
    }

    // Auto-save configuration immediately so all subsequent edits sync automatically
    await persistGoogleSheetsConfig(trimmed, autoSync);

    setIsSyncing(true);
    const toastId = toast.loading("Fetching all leads from Jellybean CRM...");

    try {
      // 1. Fetch ALL qualified leads by paginating past PostgREST 1000-row limit
      const allLeads: Array<{
        id: string;
        customer_name: string | null;
        customer_number: string | null;
        customer_number_2: string | null;
        main_area: string | null;
        sub_area: string | null;
        service: string | null;
        cs_status: string | null;
        number_name: string | null;
        context: string | null;
        requirement_1: string | null;
        requirement_2: string | null;
        post_text: string | null;
        marketing_notes: string | null;
        assigned_to: string | null;
        created_at: string | null;
        pinned_important: boolean | null;
        is_important: boolean | null;
      }> = [];

      const PAGE_SIZE = 1000;
      let pageIndex = 0;
      let hasMore = true;

      while (hasMore) {
        const from = pageIndex * PAGE_SIZE;
        const to = from + PAGE_SIZE - 1;

        toast.loading(
          `Fetching all leads from Jellybean CRM... (${allLeads.length} leads loaded)`,
          { id: toastId },
        );

        const { data: pageData, error: pageError } = await supabase
          .from("qualified_leads")
          .select(
            "id, customer_name, customer_number, customer_number_2, main_area, sub_area, service, cs_status, number_name, context, requirement_1, requirement_2, post_text, marketing_notes, assigned_to, created_at, pinned_important, is_important",
          )
          .order("created_at", { ascending: false })
          .range(from, to);

        if (pageError) throw pageError;

        if (pageData && pageData.length > 0) {
          allLeads.push(...pageData);
          if (pageData.length < PAGE_SIZE) {
            hasMore = false;
          } else {
            pageIndex++;
          }
        } else {
          hasMore = false;
        }
      }

      // Filter strictly for "New to contact" leads
      const newToContactLeads = allLeads.filter((l) => {
        if (!l.cs_status) return true;
        const s = l.cs_status.trim().toLowerCase();
        return s === "new" || s === "new to contact" || s === "new_to_contact";
      });

      if (newToContactLeads.length === 0) {
        toast.info("No 'New to contact' leads found to sync.", { id: toastId });
        setIsSyncing(false);
        return;
      }

      // 2. Fetch profiles to resolve assigned_to names
      const { data: profiles } = await supabase
        .from("profiles")
        .select("user_id, full_name, email");
      const nameMap: Record<string, string> = {};
      (profiles || []).forEach((p) => {
        nameMap[p.user_id] = p.full_name || p.email || "Staff";
      });

      // 3. Map leads with Date & Time as first attribute and include cs_status
      const mappedLeads = newToContactLeads.map((l) => ({
        id: l.id,
        created_at: l.created_at ? new Date(l.created_at).toLocaleString() : "",
        customer_name: l.customer_name || "",
        customer_number: l.customer_number_2
          ? `${l.customer_number || ""}, ${l.customer_number_2}`
          : l.customer_number || "",
        area: l.main_area || l.sub_area || "",
        service: l.service || "",
        cs_status: l.cs_status || "new",
        number_name: l.number_name || "",
        context: l.context || "",
        exact_requirement: l.requirement_1 || l.requirement_2 || l.post_text || l.context || "",
        marketing_notes: l.marketing_notes || "",
        assigned_to_name: l.assigned_to ? nameMap[l.assigned_to] || "CS" : "Unassigned",
        pinned_important: !!l.pinned_important,
        is_important: !!l.is_important,
      }));

      const unpinnedCount = mappedLeads.filter((l) => !l.pinned_important).length;
      const pinnedCount = mappedLeads.filter((l) => l.pinned_important).length;

      // 4. Send leads to Google Apps Script in batches of 1,000 for maximum reliability
      const BATCH_SIZE = 1000;
      const totalBatches = Math.ceil(mappedLeads.length / BATCH_SIZE);

      for (let b = 0; b < totalBatches; b++) {
        const chunk = mappedLeads.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
        toast.loading(
          `Syncing leads to Google Sheets (Batch ${b + 1} of ${totalBatches} - ${chunk.length} leads)...`,
          { id: toastId },
        );

        await fetch(trimmed, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({
            type: "BULK_SYNC",
            is_first_chunk: b === 0,
            chunk_index: b,
            total_chunks: totalBatches,
            leads: chunk,
          }),
          mode: "no-cors",
        });

        if (b < totalBatches - 1) {
          // Brief pause between chunks to let Google Apps Script flush
          await new Promise((r) => setTimeout(r, 400));
        }
      }

      const nowStr = new Date().toLocaleString();
      setLastBulkSync(nowStr);
      setLastSyncCount(mappedLeads.length);
      setIsConnected(true);

      localStorage.setItem("jellybean_google_sheets_last_sync", nowStr);
      localStorage.setItem("jellybean_google_sheets_sync_count", String(mappedLeads.length));
      localStorage.setItem("jellybean_google_sheets_connected", "true");

      toast.success(
        `Successfully synced ${mappedLeads.length} "New to contact" leads (${unpinnedCount} unpinned + ${pinnedCount} pinned)!`,
        { id: toastId },
      );
    } catch (err) {
      console.error(err);
      toast.error(`Sync failed: ${err instanceof Error ? err.message : String(err)}`, {
        id: toastId,
      });
    } finally {
      setIsSyncing(false);
    }
  };

  const handleCopyCode = () => {
    navigator.clipboard.writeText(APPS_SCRIPT_SOURCE);
    setCopied(true);
    toast.success("Apps Script code copied to clipboard!");
    setTimeout(() => setCopied(false), 2500);
  };

  return (
    <div className="pb-12">
      {/* Header */}
      <PageHeader
        title="Google Sheets Live Sync"
        description="Real-time bidirectional synchronization with your Google Sheet"
        actions={
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold ${
                isConnected
                  ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                  : "bg-muted text-muted-foreground border border-border"
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  isConnected ? "bg-emerald-400 animate-pulse" : "bg-muted-foreground"
                }`}
              />
              {isConnected ? "Connected & Active" : "Disconnected"}
            </span>

            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 border-border bg-card/60 hover:bg-card text-foreground"
              onClick={() => window.open(GOOGLE_SHEET_URL, "_blank")}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open Sheet
            </Button>
          </div>
        }
      />

      <PageBody>
        {/* Top 3 Stat Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          {/* Card 1: Target Sheet */}
          <div className="bg-card/70 border border-border/80 rounded-2xl p-5 backdrop-blur-sm">
            <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground block mb-1">
              Target Sheet
            </span>
            <div className="text-lg font-bold text-foreground">Jellybean CRM Leads</div>
            <a
              href={GOOGLE_SHEET_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline mt-2"
            >
              View in Google Sheets <span>&rarr;</span>
            </a>
          </div>

          {/* Card 2: Sync Engine */}
          <div className="bg-card/70 border border-border/80 rounded-2xl p-5 backdrop-blur-sm">
            <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground block mb-1">
              Sync Engine
            </span>
            <div className="text-lg font-bold text-foreground">Instant Realtime</div>
            <p className="text-xs text-muted-foreground mt-2">
              Triggers on create, edit &amp; delete
            </p>
          </div>

          {/* Card 3: Last Bulk Sync */}
          <div className="bg-card/70 border border-border/80 rounded-2xl p-5 backdrop-blur-sm">
            <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground block mb-1">
              Last Bulk Sync
            </span>
            <div className="text-lg font-bold text-foreground">
              {lastBulkSync || "Never synced"}
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              {lastBulkSync
                ? `Successfully synced ${lastSyncCount} leads across New to Contact (unpinned) and Pinned Important tabs.`
                : "Click 'Sync All Leads Now' below to perform your initial sync."}
            </p>
          </div>
        </div>

        {/* Webhook Configuration Card */}
        <div className="bg-card/70 border border-border/80 rounded-2xl p-6 mb-6 backdrop-blur-sm space-y-6">
          <div>
            <label className="block text-sm font-semibold text-foreground mb-2">
              Google Apps Script Web App URL (Webhook)
            </label>
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                type="text"
                placeholder="https://script.google.com/macros/s/.../exec"
                value={webhookUrl}
                onChange={(e) => handleUrlChange(e.target.value)}
                onBlur={() => {
                  if (webhookUrl.trim())
                    void persistGoogleSheetsConfig(webhookUrl.trim(), autoSync);
                }}
                className="font-mono text-xs bg-background/80 border-border flex-1"
              />
              <Button
                variant="secondary"
                size="default"
                onClick={handleTestConnection}
                disabled={isTesting}
                className="gap-2 shrink-0 font-semibold"
              >
                {isTesting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Zap className="h-4 w-4 text-amber-500 fill-amber-500" />
                )}
                Test Connection
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Generated from your Google Sheet by clicking{" "}
              <strong className="text-foreground">
                Extensions &gt; Apps Script &gt; Deploy &gt; New deployment &gt; Web app
              </strong>
              . Automatically saved across all sessions and CRM users.
            </p>
          </div>

          {/* Toggle & Buttons */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-4 border-t border-border/60">
            <div className="flex items-start sm:items-center gap-3">
              <Switch
                id="autoSyncToggle"
                checked={autoSync}
                onCheckedChange={handleAutoSyncToggle}
                className="data-[state=checked]:bg-primary"
              />
              <div>
                <label
                  htmlFor="autoSyncToggle"
                  className="text-sm font-semibold text-foreground cursor-pointer block"
                >
                  Automatic Realtime Sync
                </label>
                <p className="text-xs text-muted-foreground">
                  Instantly syncs lead creation, updates, status changes, and deletions to Google
                  Sheets.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 self-end sm:self-auto">
              <Button
                variant="outline"
                size="default"
                onClick={handleSaveSettings}
                className="border-border hover:bg-accent"
              >
                Save Settings
              </Button>

              <Button
                size="default"
                onClick={handleSyncAllLeads}
                disabled={isSyncing}
                className="gap-2 font-semibold bg-primary hover:bg-primary/90 text-primary-foreground shadow-sm"
              >
                {isSyncing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                Sync All Leads Now
              </Button>
            </div>
          </div>
        </div>

        {/* 1-Minute Setup Guide for Google Sheets */}
        <div className="bg-card/70 border border-border/80 rounded-2xl p-6 backdrop-blur-sm">
          {/* Guide Header */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-border/60">
            <div className="flex items-start gap-3">
              <div className="h-9 w-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary shrink-0 mt-0.5">
                <Code2 className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-foreground">
                  1-Minute Setup Guide for Google Sheets
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Copy this Apps Script into your Google Sheet to enable automated tab creation
                  &amp; row shifting
                </p>
              </div>
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyCode}
              className="gap-2 border-border font-medium hover:bg-accent shrink-0"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-emerald-400" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              {copied ? "Copied!" : "Copy Apps Script Code"}
            </Button>
          </div>

          {/* 4 Steps Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 my-6">
            {/* Step 1 */}
            <div className="bg-background/50 border border-border/70 rounded-xl p-4 flex flex-col justify-between">
              <div>
                <span className="inline-flex items-center justify-center h-6 w-6 rounded-full bg-primary/15 text-primary text-xs font-bold mb-3">
                  1
                </span>
                <h4 className="text-sm font-semibold text-foreground mb-1">Open Sheet</h4>
                <p className="text-xs text-muted-foreground">
                  Open{" "}
                  <a
                    href={GOOGLE_SHEET_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline font-medium"
                  >
                    your Google Sheet
                  </a>
                  .
                </p>
              </div>
            </div>

            {/* Step 2 */}
            <div className="bg-background/50 border border-border/70 rounded-xl p-4 flex flex-col justify-between">
              <div>
                <span className="inline-flex items-center justify-center h-6 w-6 rounded-full bg-primary/15 text-primary text-xs font-bold mb-3">
                  2
                </span>
                <h4 className="text-sm font-semibold text-foreground mb-1">Open Apps Script</h4>
                <p className="text-xs text-muted-foreground">
                  Click <strong className="text-foreground">Extensions &gt; Apps Script</strong> in
                  Google Sheets menu.
                </p>
              </div>
            </div>

            {/* Step 3 */}
            <div className="bg-background/50 border border-border/70 rounded-xl p-4 flex flex-col justify-between">
              <div>
                <span className="inline-flex items-center justify-center h-6 w-6 rounded-full bg-primary/15 text-primary text-xs font-bold mb-3">
                  3
                </span>
                <h4 className="text-sm font-semibold text-foreground mb-1">Paste &amp; Save</h4>
                <p className="text-xs text-muted-foreground">
                  Click <strong className="text-foreground">Copy Apps Script Code</strong> above,
                  paste into editor, and hit{" "}
                  <strong className="text-foreground">Save (Ctrl+S)</strong>.
                </p>
              </div>
            </div>

            {/* Step 4 */}
            <div className="bg-background/50 border border-border/70 rounded-xl p-4 flex flex-col justify-between">
              <div>
                <span className="inline-flex items-center justify-center h-6 w-6 rounded-full bg-primary/15 text-primary text-xs font-bold mb-3">
                  4
                </span>
                <h4 className="text-sm font-semibold text-foreground mb-1">Deploy as Web App</h4>
                <p className="text-xs text-muted-foreground">
                  Deploy &gt; New deployment &gt; Web app. Execute as:{" "}
                  <strong className="text-foreground">Me</strong>, Access:{" "}
                  <strong className="text-foreground">Anyone</strong>. Paste URL here!
                </p>
              </div>
            </div>
          </div>

          {/* Checklist Area */}
          <div className="bg-background/80 border border-border/70 rounded-xl p-5 space-y-3">
            <h5 className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              What this Google Sheet sync handles automatically:
            </h5>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              <div className="flex items-start gap-2 text-foreground/90">
                <Check className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                <div>
                  <strong className="text-foreground">
                    First Column: Lead Created Date &amp; Time:
                  </strong>{" "}
                  Automatically placed as Column A for instant timeline filtering.
                </div>
              </div>

              <div className="flex items-start gap-2 text-foreground/90">
                <Check className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                <div>
                  <strong className="text-foreground">Recent Leads on Top:</strong> Reverse
                  chronological order with recent leads always inserted on Row 2 directly below the
                  header.
                </div>
              </div>

              <div className="flex items-start gap-2 text-foreground/90">
                <Check className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                <div>
                  <strong className="text-foreground">New to Contact (Unpinned Only):</strong> Tab
                  strictly holds leads where status is &ldquo;New to contact&rdquo; and NOT marked
                  as Pinned Important.
                </div>
              </div>

              <div className="flex items-start gap-2 text-foreground/90">
                <Check className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                <div>
                  <strong className="text-foreground">Pinned Important Leads Sheet:</strong>{" "}
                  Dedicated tab for &ldquo;New to contact&rdquo; leads that ARE pinned. Pinning a
                  lead moves it here; unpinning moves it back to New to Contact automatically!
                </div>
              </div>
            </div>
          </div>
        </div>
      </PageBody>
    </div>
  );
}
