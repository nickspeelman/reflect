import {
  processEntry,
  scoreRelevance,
  attachSummaryV2,
  assignThemesForEntry,
  inferEntrySentimentEnsemble,
  loadModel
} from './ai.js';

import { getRandomPrompt } from './prompts.js';
import { dbPromise } from './db.js';

(() => {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const [url, init] = args;
    console.log('[fetch]', url, init?.method || 'GET');
    const res = await realFetch(...args);
    console.log('[fetch-res]', res.status, res.url);
    return res;
  };
})();



let backupModalReturnFocus = null;


// --- Dev console helpers (safe to remove later) ---
if (typeof window !== 'undefined') {
  window.debug = window.debug || {};
  window.debug.getSetting = getSetting;
  window.debug.setSetting = setSetting;
  window.debug.db = dbPromise;
  // if you added ensureThemesIndex earlier:
  // window.debug.ensureThemesIndex = ensureThemesIndex;
}



// --- Restore (import) from a JSON backup file ---
async function restoreBackupFromFile(file) {
  if (!file) throw new Error('No file selected');

  // Read & parse
  const text = await file.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Selected file is not valid JSON.');
  }

  // Basic validation
  if (!data || typeof data !== 'object') throw new Error('Backup payload missing.');
  if (typeof data.version !== 'number') throw new Error('Backup version missing.');
  if (!Array.isArray(data.entries)) throw new Error('Backup has no entries array.');
  if (!data.settings || typeof data.settings !== 'object') throw new Error('Backup has no settings object.');

  // Confirm destructive action
  const ok = window.confirm(
    'Restoring will REPLACE all current entries and settings with the data in this file. Continue?'
  );
  if (!ok) return;

  const db = await dbPromise;

  // Single readwrite transaction across both stores
  const tx = db.transaction(['entries', 'settings'], 'readwrite');
  const entriesStore = tx.objectStore('entries');
  const settingsStore = tx.objectStore('settings');

  // Clear current data
  await entriesStore.clear();
  await settingsStore.clear();

  // Write entries
  for (const e of data.entries) {
    await entriesStore.put(e);
  }

  // Write settings (merge is fine; we're replacing anyway)
  for (const [k, v] of Object.entries(data.settings)) {
    await settingsStore.put(v, k);
  }

  // Ensure backup counters reflect the imported state
  const importedCount = data.entries.length;
  const importedWhen = typeof data.exportedAt === 'string' ? data.exportedAt : new Date().toISOString();
  await settingsStore.put(importedCount, 'lastBackupEntryCount');
  await settingsStore.put(importedWhen, 'lastBackupAt');

  await tx.done;

  console.log(`✅ Restore complete (${importedCount} entries).`);
}



function mountInPortal(el) {
  let portal = document.getElementById('modal-root');
  if (!portal) {
    portal = document.createElement('div');
    portal.id = 'modal-root';
    portal.className = 'app-scope';
    document.body.appendChild(portal);
  }
  portal.appendChild(el);
}

function makeSnippet(text, max = 150) {
  const s = String(text || '');
  if (s.length <= max) return { snippet: s, truncated: false };
  // break on word boundary if possible
  let cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > max * 0.6) cut = cut.slice(0, lastSpace);
  return { snippet: cut, truncated: true };
}





async function saveEntry(entry) {
  // 1) Summaries + facets
  await attachSummaryV2(entry);

  // 1a) Sentiment (POS/NEG/NEU) — new
  try {
    console.log("Attempting sentiment analysis")
    const sent = await inferEntrySentimentEnsemble(entry.response || "");
    console.log ("Sent: ", sent)
    entry.sentiment = sent.label;                 // "positive" | "negative" | "neutral"
    entry.sentiment_confidence = sent.confidence; // 0..1
    entry.sentiment_breakdown = sent.breakdown;   // {pos,neg,neutral}
    if (sent.negative_subtype) entry.negative_subtype = sent.negative_subtype;
  } catch (e) {
    console.warn('[sentiment ensemble] skipped:', e);
  }

  // 2) Load current themes (stored in settings)
  const currentThemes = (await getSetting('themes_v1')) || [];

  // 3) Assign entry tags and update theme centroids/merges
  const { entryTags, themes } = await assignThemesForEntry(entry, currentThemes);

  // 4) Attach tags to entry (ids + weights), persist updated themes
  entry.theme_ids = entryTags.map(t => t.id);
  entry.theme_weights = entryTags.map(t => t.weight);
  await setSetting('themes_v1', themes);

  // 5) Save entry as usual
  const db = await dbPromise;
  await db.put('entries', entry);
  console.log('Entry: ', entry)
  await checkBackupReminder();
}




async function getAllEntries() {
  const db = await dbPromise;
  return await db.getAll('entries');
}

async function getSetting(key) {
  const db = await dbPromise;
  return await db.get('settings', key);
}

async function setSetting(key, value) {
  const db = await dbPromise;
  await db.put('settings', value, key);
}

// Truncate long responses for summaries
function truncate(text, length) {
  return text.length > length ? text.substring(0, length) + "..." : text;
  }

async function openEntryModal(entry) {
  const modal = document.getElementById("entryModal");
  await populateEntryModal(entry, modal);
  modal.classList.remove("hidden");



}



function attachEntryListeners() {
  document.querySelectorAll(".read-entry").forEach(button => {
    if (!button.dataset.listenerAttached) {
      button.addEventListener("click", async () => {
        const entryId = button.dataset.entryId;
        const db = await dbPromise;
        const entry = await db.get("entries", entryId);
        openEntryModal(entry);
      });
      button.dataset.listenerAttached = "true";
    }
  });
}




let modalCount = 0;

async function openStackedEntryModal(entry) {
  console.log("Now you are here.")
  modalCount++;

  // ✅ Use the template content, not the tag itself
  const template = document.getElementById("entryModalTemplate");
  if (!template?.content?.firstElementChild) {
    console.error("❌ entryModalTemplate is missing or malformed.");
    return;
  }

  // ✅ Clone the modal DOM from the template
  const clone = template.content.firstElementChild.cloneNode(true);
  console.log(clone)

  // ✅ Remove IDs from the clone to prevent duplicates
  clone.querySelectorAll("[id]").forEach(el => el.removeAttribute("id"));
  clone.querySelector(".modalBox").classList.add("entry-modal-box");

  console.log(clone)

  // ✅ Prepare modal styles
  clone.classList.remove("hidden");
  clone.style.zIndex = 2000 + modalCount;

  // ✅ Handle close button
  const closeButton = clone.querySelector(".close-button");
  if (closeButton) {
    closeButton.addEventListener("click", () => clone.remove());
  }

  // ✅ Append to DOM before populating (important!)
  document.body.appendChild(clone);
  console.log("Child appended")

  // ✅ Wait for browser to register it in DOM
  await new Promise(requestAnimationFrame);

  // ✅ Now populate the modal with entry content
  console.log(entry, clone)
  console.log("right here bud")
  await populateEntryModal(entry, clone);
}

async function checkBackupReminder() {
  const [threshold, lastCount] = await Promise.all([
    getSetting('backupPromptThreshold'),
    getSetting('lastBackupEntryCount')
  ]);

  // Disabled?
  if (!threshold || threshold <= 0) return;

  const total = await countEntries();
  const unbacked = total - (lastCount || 0);
  if (unbacked >= threshold) {
    // Avoid re-opening if already visible
    const overlay = document.getElementById('backupModal');
    const isOpen = overlay && !overlay.classList.contains('hidden');
    if (!isOpen) openBackupModal();
  }
}


async function openBackupModal() {
  const modal = document.getElementById('backupModal');
  if (!modal) return;

  // remember the element that opened the modal
  backupModalReturnFocus = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;

  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  // focus the primary control inside the modal
  await refreshBackupModalUI();
  modal.querySelector('#backupNowBtn')?.focus();
}

function closeBackupModal() {
  const modal = document.getElementById('backupModal');
  if (!modal) return;

  // move focus OUT of the modal BEFORE hiding it
  const fallback = document.getElementById('openBackupModalLink');
  const target =
    (backupModalReturnFocus && document.contains(backupModalReturnFocus)) ? backupModalReturnFocus :
    (fallback || null);

  if (target instanceof HTMLElement) {
    target.focus();
  } else {
    // last-resort safe focus target
    document.body.setAttribute('tabindex', '-1');
    document.body.focus();
    document.body.removeAttribute('tabindex');
  }

  // now it's safe to hide the modal
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');

  // clear for next time
  backupModalReturnFocus = null;
}


function wireBackupModal() {
  const openLink = document.getElementById('openBackupModalLink');
  const closeBtn1 = document.getElementById('closeBackupModalBtn');
  const closeBtn2 = document.getElementById('closeBackupModalBtn2');
  const overlay = document.getElementById('backupModal');
  const backupNowBtn = document.getElementById('backupNowBtn');

  if (openLink) openLink.addEventListener('click', (e) => { e.preventDefault(); openBackupModal(); });
  if (closeBtn1) closeBtn1.addEventListener('click', closeBackupModal);
  if (closeBtn2) closeBtn2.addEventListener('click', closeBackupModal);

  // Click-outside to close
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeBackupModal();
    });
  }

  // Wire “Backup now”
  if (backupNowBtn) {
    backupNowBtn.addEventListener('click', async () => {
      try {
        await exportBackup();  // from Step 2
        // optional: close after success
        closeBackupModal();
      } catch (err) {
        console.error('Backup failed:', err);
        // (Optional) show a toast or inline message
      }
    });
  }

    const restoreInput = document.getElementById('restoreFileInput');
  restoreInput?.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      await restoreBackupFromFile(file);  // your restore function
      closeBackupModal();
      window.location.reload();           // simplest reliable refresh
    } catch (err) {
      console.error('[backup] Restore failed:', err);
      alert(err?.message || 'Restore failed.');
    } finally {
      e.target.value = '';                // allow selecting the same file again
    }
  });

    const thresholdInput = document.getElementById('backupThresholdInput');

  // Save on change (clamp to >= 0)
  thresholdInput?.addEventListener('change', async (e) => {
    let n = parseInt(e.target.value, 10);
    if (isNaN(n) || n < 0) n = 0;
    e.target.value = n;
    await setSetting('backupPromptThreshold', n);
  });
}

function formatLastBackupLabel(iso) {
  if (!iso) return 'Never';
  try {
    const d = new Date(iso);
    if (isNaN(d)) return 'Never';
    return d.toLocaleString();
  } catch { return 'Never'; }
}

async function countEntries() {
  const db = await dbPromise;
  if (typeof db.count === 'function') {
    try { return await db.count('entries'); } catch { /* fall through */ }
  }
  const all = await db.getAll('entries');
  return all.length;
}

// Update the modal UI (counts + current threshold)
async function refreshBackupModalUI() {
  const [threshold, lastCount, lastAt, total] = await Promise.all([
    getSetting('backupPromptThreshold'),
    getSetting('lastBackupEntryCount'),
    getSetting('lastBackupAt'),
    countEntries()
  ]);

  const unbacked = total - (lastCount || 0);

  const $unbacked = document.getElementById('unbackedCount');
  const $last = document.getElementById('lastBackupLabel');
  const $input = document.getElementById('backupThresholdInput');

  if ($unbacked) $unbacked.textContent = String(Math.max(0, unbacked));
  if ($last) $last.textContent = formatLastBackupLabel(lastAt);
  if ($input) $input.value = (typeof threshold === 'number' && threshold >= 0) ? threshold : 10;
}


// Call this during your app init / DOMContentLoaded
document.addEventListener('DOMContentLoaded', async () => {
  // make sure defaults exist (Step 1)
  await ensureBackupSettingsDefaults();
  wireBackupModal();
  checkBackupReminder();
  // in app.js, at boot after DOMContentLoaded begins
  await loadModel();

});



async function showEntryModal(entry) {
  modalCount++;

  const template = document.getElementById("entryModalTemplate");
  const clone = template.content.firstElementChild.cloneNode(true);
  const modal = clone;

  // Position and stack
  modal.style.position = "fixed";
  modal.style.zIndex = 2000 + modalCount;

  // Close button
  const closeBtn = modal.querySelector(".close-button");
  closeBtn.addEventListener("click", () => modal.remove());

  // Append before populating
  document.body.appendChild(modal);

  // Populate content
  await populateEntryModal(entry, modal);
}

async function populateEntryModal(entry, modal) {
  const modalDate = modal.querySelector(".modal-date");
  const modalPrompt = modal.querySelector(".modal-prompt");
  const modalResponse = modal.querySelector(".modal-response");
  const relatedContainer = modal.querySelector(".related-entries");

  // Header/date/prompt/response
  modalDate.textContent = new Date(entry.timestamp).toLocaleDateString();

  // Prompt in italics (avoid innerHTML for safety)
  modalPrompt.textContent = "";
  const promptItal = document.createElement("i");
  promptItal.textContent = entry.prompt || "";
  modalPrompt.appendChild(promptItal);

  // Response as a paragraph (preserves CSS whitespace handling)
  modalResponse.textContent = "";
  const p = document.createElement("p");
  p.textContent = entry.response || "";
  modalResponse.appendChild(p);

  // Related entries
  relatedContainer.innerHTML = "";
  relatedContainer.classList.add("hidden");

  const ids = Array.isArray(entry.relatedEntryIds) ? entry.relatedEntryIds : [];
  if (ids.length > 0) {
    const db = await dbPromise;
    const relatedEntries = await Promise.all(ids.map(id => db.get('entries', id)));
    const validEntries = relatedEntries.filter(Boolean);

    if (validEntries.length > 0) {
      relatedContainer.classList.remove("hidden");

      for (const rel of validEntries) {
        const preview = document.createElement("div");
        preview.className = "related-entry-preview";

        // Build inline: <b>date</b> <i>prompt</i> snippet … read more
        const b = document.createElement("b");
        b.textContent = new Date(rel.timestamp).toLocaleDateString();

        const iEl = document.createElement("i");
        iEl.textContent = rel.prompt || "";

        const { snippet } = makeSnippet(rel.response || "", 150);
        const snippetSpan = document.createElement("span");
        snippetSpan.textContent = ` ${snippet}`;

        const readMore = document.createElement("a");
        readMore.href = "#";
        readMore.className = "read-more-link";
        readMore.textContent = " … read more";
        readMore.addEventListener("click", (e) => {
          e.preventDefault();
          openStackedEntryModal(rel);
        });

        preview.append(b, " ", iEl, " ", snippetSpan, readMore);
        relatedContainer.appendChild(preview);
      }
    }
  }
}


// --- Backup settings: defaults and helpers ---
const BACKUP_SETTINGS_DEFAULTS = {
  backupPromptThreshold: 10,   // 0 = never prompt
  lastBackupEntryCount: 0,
  lastBackupAt: null           // ISO string or null
};

async function ensureBackupSettingsDefaults() {
  for (const [k, v] of Object.entries(BACKUP_SETTINGS_DEFAULTS)) {
    const existing = await getSetting(k);
    if (existing === undefined) {
      await setSetting(k, v);
    }
  }
}

async function getAllSettings() {
  const db = await dbPromise;                         // :contentReference[oaicite:0]{index=0}
  const keys = await db.getAllKeys('settings');
  const out = {};
  for (const k of keys) out[k] = await db.get('settings', k);
  return out;
}









document.addEventListener("DOMContentLoaded", async () => {

  // DOM Elements
  const promptEl = document.getElementById("prompt");
  const newPromptBtn = document.getElementById("newPrompt");
  const entryInput = document.getElementById("journalEntry");
  const submitBtn = document.getElementById("submitEntry");
  const entryList = document.getElementById("entryList");
  const entrySectionTitle = document.getElementById("entrySectionTitle");
  const charCount = document.getElementById("charCount");
  const maxChars = 2000;

  const modal = document.getElementById("entryModal");
  const closeModal = document.getElementById("closeModal");

  const viewAllLink = document.getElementById("viewAllEntries");
  const allEntriesModal = document.getElementById("allEntriesModal");
  const allEntriesList = document.getElementById("allEntriesList");
  const closeAllEntries = document.getElementById("closeAllEntries");

  const welcomeModal = document.getElementById("welcomeModal");
  const dismissWelcome = document.getElementById("dismissWelcome");
  const reopenWelcome = document.getElementById("reopenWelcome");

  const splash = document.getElementById("processingSplash");
  const relevantEntriesModal = document.getElementById("relevantEntriesModal");
  const closeRelevantEntries = document.getElementById("closeRelevantEntries");

  const followUpInput = document.getElementById("followUpEntry");
  const followUpSubmitBtn = document.getElementById("submitFollowUpEntry");
  const followUpCharCount = document.getElementById("followUpCharCount");

  const relevanceFilterOptions = document.getElementsByName("relevanceFilter");

  const entrySearchInput = document.getElementById("entrySearchInput");
  const entrySearchModeOptions = document.getElementsByName("entrySearchMode");
  const entrySearchButton = document.getElementById("entrySearchButton");
  const clearSearchButton = document.getElementById("clearSearchButton");

  let viewedRelevantEntries = new Set();

  await ensureBackupSettingsDefaults();




  clearSearchButton.addEventListener("click", async () => {
    entrySearchInput.value = ""; // clear input
    const entries = await getAllEntries();
    showAllEntriesResults(entries, false); // show full list
  });

  

  entrySearchButton.addEventListener("click", async () => {
    const query = entrySearchInput.value.trim();
    if (!query) return;

    const allEntries = await getAllEntries();
    const selectedMode = [...entrySearchModeOptions].find(r => r.checked)?.value || "text";


    await setSetting("entrySearchMode", selectedMode); // remember last used

    let results = [];

    if (selectedMode === "text") {
      results = allEntries.filter(entry =>
        (entry.prompt + " " + entry.response).toLowerCase().includes(query.toLowerCase())
      );
    } else if (selectedMode === "semantic") {
      const newEmbedding = await processEntry(query);
      results = allEntries
        .filter(e => Array.isArray(e.embedding))
        .map(entry => ({
          ...entry,
          relevance: scoreRelevance(newEmbedding, entry)
        }))
        .sort((a, b) => b.relevance - a.relevance)
        .slice(0, 10);
    }

    showAllEntriesResults(results, true);
  });



  closeRelevantEntries.addEventListener("click", () => {
    relevantEntriesModal.classList.add("hidden");
  });



  await migrateToIndexedDB();

  async function migrateToIndexedDB() {
  const db = await dbPromise;
  const storedFlag = localStorage.getItem('migratedToIndexedDB');

    if (!storedFlag) {
      const entries = JSON.parse(localStorage.getItem('journalEntries') || "[]");
      for (const entry of entries) {
        await db.put('entries', entry);
      }

      const settings = JSON.parse(localStorage.getItem('journalSettings') || "{}");
      for (const [key, value] of Object.entries(settings)) {
        await db.put('settings', value, key);
      }

      localStorage.setItem('migratedToIndexedDB', 'true');
      localStorage.removeItem('journalEntries');
      localStorage.removeItem('journalSettings');
    }
  }


  // Prompt State
  let currentPrompt = "";

  // Prompt utility
  function setPrompt(text) {
    currentPrompt = text;
    promptEl.textContent = text;
  }

  async function setNewPrompt(fallback = "What's on your mind?") {
    const prompt = await getRandomPrompt() || fallback;
    setPrompt(prompt);
  }


  const db = await dbPromise;
  const hasSeenWelcome = await db.get('settings', 'hasSeenWelcome');
  if (!hasSeenWelcome) {
    welcomeModal.classList.remove("hidden");
  }

  const savedSearchMode = await getSetting("entrySearchMode") || "text";
    for (const option of entrySearchModeOptions) {
      if (option.value === savedSearchMode) option.checked = true;

      option.addEventListener("change", async () => {
        await setSetting("entrySearchMode", option.value);
      });
  }


  const savedFilter = await getSetting("relevanceFilter") || "recent";
  for (const option of relevanceFilterOptions) {
    if (option.value === savedFilter) option.checked = true;

    option.addEventListener("change", async () => {
      await setSetting("relevanceFilter", option.value);

      // 🔁 Rerun the modal with updated filter
      const allEntries = await getAllEntries();
      const lastEntryId = relevantEntriesModal.dataset.lastEntryId;
      const lastEntry = allEntries.find(e => e.id === lastEntryId);
      if (lastEntry) {
        showRelevantEntriesModal(lastEntry, allEntries);
      }
    });
  }




  dismissWelcome.addEventListener("click", async () => {
    welcomeModal.classList.add("hidden");
    await db.put('settings', true, 'hasSeenWelcome');
  });
  reopenWelcome.addEventListener("click", () => {
    welcomeModal.classList.remove("hidden");
  });

  window.addEventListener("keydown", async (e) => {
    if (e.key === "Escape") {
      if (!welcomeModal.classList.contains("hidden")) {
        welcomeModal.classList.add("hidden");
        await setSetting("hasSeenWelcome", true);

      }
      allEntriesModal.classList.add("hidden");
      modal.classList.add("hidden");
    }
  });

  // Handle view all entries modal
viewAllLink.addEventListener("click", async () => {
  const entries = await getAllEntries();
  showAllEntriesResults(entries, false);
});


  

  closeAllEntries.addEventListener("click", () => {
    allEntriesModal.classList.add("hidden");
  });

  closeModal.addEventListener("click", () => {
    modal.classList.add("hidden");
  });

  // Live character count
  entryInput.addEventListener("input", () => {
    const remaining = maxChars - entryInput.value.length;
    charCount.textContent = `${remaining} characters remaining`;
  });

  followUpInput.addEventListener("input", () => {
    const remaining = maxChars - followUpInput.value.length;
    followUpCharCount.textContent = `${remaining} characters remaining`;
  });

  followUpSubmitBtn.addEventListener("click", async () => {
    const text = followUpInput.value.trim();
    if (!text) return;

    splash.classList.remove("hidden");
    await new Promise(resolve => setTimeout(resolve, 0));

    try {
      const lastEntryId = relevantEntriesModal.dataset.lastEntryId;
      const allEntries = await getAllEntries();
      const lastEntry = allEntries.find(e => e.id === lastEntryId);

      const aiData = await processEntry(text);


      const newEntry = {
        id: crypto.randomUUID(),
        timestamp: new Date().toLocaleString('sv-SE'),
        prompt: "Do you have anything to add?",
        response: text,
        relatedEntryIds: [...viewedRelevantEntries],
        ...aiData
      };

      await saveEntry(newEntry);
      console.log("📎 Related entry IDs saved:", [...viewedRelevantEntries]);
      viewedRelevantEntries.clear();  // reset for the next follow-up session

      await displayRecentEntries(newEntry);

      const updatedEntries = await getAllEntries();
      showRelevantEntriesModal(newEntry, updatedEntries);

    } catch (err) {
      console.error("❌ Error during follow-up submission:", err);
      alert("Something went wrong with your follow-up entry.");
    } finally {
      splash.classList.add("hidden");
    }
  });



  newPromptBtn.addEventListener("click", setNewPrompt);




  // Display most relevant (or recent) entries
async function displayRecentEntries(newEntry = null) {
  const db = await dbPromise;
  const entries = await db.getAll('entries');

  entryList.innerHTML = "";

  if (entries.length === 0) {
    entrySectionTitle.textContent = "Recent Entries";
    entryList.innerHTML = "<li>You haven't made any entries yet.</li>";
    return;
  }

  // Sort by timestamp descending
  const sorted = entries
    .filter(e => e.timestamp)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  // Always show the top 5
  const displayEntries = sorted.slice(0, 5);

  entrySectionTitle.textContent = "Recent Entries";

  for (const entry of displayEntries) {
    const li = document.createElement("li");

    const wrapper = document.createElement("div");
    wrapper.className = "entry-wrapper";

    const date = new Date(entry.timestamp || entry.date).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric"
    });

    const text = document.createElement("div");
    text.className = "entry-summary";
    text.innerHTML = `
      <strong>${date}</strong><br>
      <em>${entry.prompt}</em><br>
      ${truncate(entry.response, 200)}
    `;


    const buttonWrapper = document.createElement("div");
    buttonWrapper.className = "button-wrapper";

    const expand = document.createElement("button");
    expand.textContent = "Read more";
    expand.className = "button-link read-entry";
    expand.dataset.entryId = entry.id;



    buttonWrapper.appendChild(expand);
    wrapper.appendChild(text);
    wrapper.appendChild(buttonWrapper);
    li.appendChild(wrapper);
    entryList.appendChild(li);
  }

  attachEntryListeners();
}


  // Handle journal submission
  submitBtn.addEventListener("click", async () => {
    console.log("currentPrompt before submit:", currentPrompt);
    console.log("promptEl.textContent:", promptEl.textContent);

    const text = entryInput.value.trim();
    if (!text) return;

    splash.classList.remove("hidden");
    await new Promise(resolve => setTimeout(resolve, 0)); // Allow splash to appear

    try {
      const aiData = await processEntry(text);

      const entry = {
        id: crypto.randomUUID(),
        timestamp: new Date().toLocaleString('sv-SE'),
        prompt: currentPrompt,
        response: text,
        ...aiData
      };

      await saveEntry(entry);
      
      entryInput.value = "";
      charCount.textContent = `${maxChars} characters remaining`;

      // Set follow-up prompt
      setPrompt("What's on your mind?");

      // Show relevant entries
      await displayRecentEntries(entry);

      const allEntries = await getAllEntries();
      showRelevantEntriesModal(entry, allEntries);

    } catch (err) {
      console.error("❌ Error during submission:", err);
      alert("Something went wrong while processing your entry.");
    } finally {
      splash.classList.add("hidden");
    }
  });

function findRelevantEntries(newEntry, allEntries, filter = "most") {
  const now = new Date(newEntry.timestamp).getTime();
  const biasStrength = 0.25; // 🔧 Strength of age preference

  const pastEntries = allEntries.filter(
    e => e.id !== newEntry.id && Array.isArray(e.embedding)
  );

  // Find max age for normalization
  const maxAgeInDays = Math.max(
    ...pastEntries.map(e => Math.floor((now - new Date(e.timestamp).getTime()) / (1000 * 60 * 60 * 24)))
  );

  const scored = pastEntries.map(entry => {
    const relevance = scoreRelevance(newEntry, entry);

    const entryTime = new Date(entry.timestamp).getTime();
    const ageInDays = Math.floor((now - entryTime) / (1000 * 60 * 60 * 24));
    const ageRatio = maxAgeInDays === 0 ? 0 : ageInDays / maxAgeInDays;

    let weight = 1;

    if (filter === "recent") {
      weight = 1 - (ageRatio * biasStrength);
    } else if (filter === "older") {
      weight = 1 + (ageRatio * biasStrength);
    }

    return {
      ...entry,
      relevance,
      weightedRelevance: relevance * weight
    };
  });

  return scored
    .sort((a, b) => b.weightedRelevance - a.weightedRelevance)
    .slice(0, 5);
}



function showRelevantEntriesModal(newEntry, allEntries) {
  const selectedFilter =
    Array.from(document.getElementsByName("relevanceFilter")).find(opt => opt.checked)?.value || "most";

  const relevantEntries = findRelevantEntries(newEntry, allEntries, selectedFilter);


  const modal = document.getElementById("relevantEntriesModal");
  const list = document.getElementById("relevantEntriesList");
  const closeBtn = document.getElementById("closeRelevantEntries");

  list.innerHTML = "";

  if (relevantEntries.length === 0) {
    list.innerHTML = "<li>No similar entries found.</li>";
  } else {
      for (const entry of relevantEntries) {
      viewedRelevantEntries.add(entry.id);

      const li = document.createElement("li");
      li.classList.add("relevant-entry-preview");

      const date = new Date(entry.timestamp).toLocaleDateString(undefined, {
        year: "numeric", month: "short", day: "numeric"
      });

      // Build preview content using nodes (safer than innerHTML)
      const preview = document.createElement("div");

      const strong = document.createElement("strong");
      strong.textContent = date;

      const em = document.createElement("em");
      em.textContent = entry.prompt;

      const { snippet } = makeSnippet(entry.response, 150);
      const snippetSpan = document.createElement("span");
      snippetSpan.textContent = ` ${snippet}`; // leading space after <em>

      preview.append(strong, " ", em, " ", snippetSpan);

      // always add an inline “… read more” link
      const readMoreLink = document.createElement("a");
      readMoreLink.href = "#";
      readMoreLink.className = "read-more-link";
      readMoreLink.textContent = " …read more";
      readMoreLink.setAttribute(
        "aria-label",
        `Read full entry from ${date}: ${entry.prompt}`
      );
      readMoreLink.addEventListener("click", (e) => {
        e.preventDefault();
        openStackedEntryModal(entry);
      });
      preview.append(readMoreLink);


      li.appendChild(preview);
      list.appendChild(li);
    }



  }

modal.classList.remove("hidden");
followUpInput.value = "";
followUpCharCount.textContent = `${maxChars} characters remaining`;

// Save the last entry to chain from
modal.dataset.lastEntryId = newEntry.id;

attachEntryListeners();


}






  // Initial setup
 // At the bottom of DOMContentLoaded
  setPrompt("What's on your mind?");
  await displayRecentEntries();

  charCount.textContent = `${maxChars} characters remaining`;
})
function showAllEntriesResults(entries, isSearch = false) {
  const list = document.getElementById("allEntriesList");
  const title = document.getElementById("allEntriesTitle");

  // Title
  title.textContent = isSearch ? "Search Results" : "Past Entries";
  list.innerHTML = "";

  // Sort by descending timestamp
  const sorted = entries
    .filter(e => e.timestamp)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  if (sorted.length === 0) {
    list.innerHTML = "<li>No entries found.</li>";
    return;
  }

  for (const entry of sorted) {
    const li = document.createElement("li");

    const dateStr = new Date(entry.timestamp).toLocaleDateString(undefined, {
      year: "numeric", month: "short", day: "numeric"
    });

    // Build inline: <strong>date</strong> <em>prompt</em> snippet … read more
    const strong = document.createElement("strong");
    strong.textContent = dateStr;

    const em = document.createElement("em");
    em.textContent = entry.prompt || "";

    const { snippet } = makeSnippet(entry.response || "", 200);
    const snippetSpan = document.createElement("span");
    snippetSpan.textContent = ` ${snippet}`;

    const readMore = document.createElement("a");
    // Use href that won't navigate; attachEntryListeners will handle the click
    readMore.href = "javascript:void(0)";
    readMore.className = "read-more-link read-entry";
    readMore.dataset.entryId = entry.id;
    readMore.textContent = " …read more";

    // Assemble the line
    li.append(strong, " ", em, " ", snippetSpan, readMore);

    list.appendChild(li);
  }

  document.getElementById("allEntriesModal").classList.remove("hidden");
  attachEntryListeners();
}


// --- Export (backup) all data to a JSON file ---
async function exportBackup() {
  const db = await dbPromise;
  const [entries, settings] = await Promise.all([
    db.getAll('entries'),
    getAllSettings()
  ]);

  const now = new Date().toISOString();
  const payload = {
    version: 1,
    exportedAt: now,
    entries,
    settings
  };

  // Download as JSON
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const fname = `Reflect-backup-${now.replace(/[-:]/g, '').slice(0, 15)}.json`; // YYYYMMDDTHHMM

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  // Update counters for reminder logic
  await setSetting('lastBackupEntryCount', entries.length);
  await setSetting('lastBackupAt', now);

  console.log(`✅ Backup saved (${entries.length} entries) at ${now}.`);
}

// Dev trigger so you can test from the console
window.exportBackup = exportBackup;


