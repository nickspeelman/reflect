import { processEntry, scoreRelevance } from './ai.js';
import { getRandomPrompt } from './prompts.js';
import { dbPromise } from './db.js';

async function saveEntry(entry) {
  const db = await dbPromise;
  await db.put('entries', entry);
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

  async function setNewPrompt() {
    const prompt = await getRandomPrompt();
    setPrompt(prompt);
  }

  const db = await dbPromise;
  const hasSeenWelcome = await db.get('settings', 'hasSeenWelcome');
  if (!hasSeenWelcome) {
    welcomeModal.classList.remove("hidden");
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
      const db = await dbPromise;
      const entries = await db.getAll("entries");

    if (entries.length === 0) {
      allEntriesList.innerHTML = "<li>You haven't written any entries yet.</li>";
    } else {
      const sorted = entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      allEntriesList.innerHTML = "";

      for (const entry of sorted) {
        const li = document.createElement("li");
        const date = new Date(entry.timestamp).toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric"
        });

        li.innerHTML = `<strong>${date}</strong><br><em>${entry.prompt}</em><br>${entry.response}<br><br>`;
        allEntriesList.appendChild(li);
      }
    }

    allEntriesModal.classList.remove("hidden");
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

      const aiData = await processEntry(`${currentPrompt}\n\n${text}`);


      const newEntry = {
        id: crypto.randomUUID(),
        timestamp: new Date().toLocaleString('sv-SE'),
        prompt: "Do you have anything to add?",
        response: text,
        ...aiData
      };

      await saveEntry(newEntry);
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


  // Truncate long responses for summaries
  function truncate(text, length) {
    return text.length > length ? text.substring(0, length) + "..." : text;
  }

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

    const summary = entry.summary || truncate(entry.response, 80);

    const text = document.createElement("div");
    text.className = "entry-summary";
    text.textContent = `${date} — ${summary}`;

    const buttonWrapper = document.createElement("div");
    buttonWrapper.className = "button-wrapper";

    const expand = document.createElement("button");
    expand.textContent = "Read more";
    expand.className = "button-link";
    expand.addEventListener("click", () => {
      document.getElementById("modalPrompt").textContent = entry.prompt;
      document.getElementById("modalResponse").textContent = entry.response;
      modal.classList.remove("hidden");
    });

    buttonWrapper.appendChild(expand);
    wrapper.appendChild(text);
    wrapper.appendChild(buttonWrapper);
    li.appendChild(wrapper);
    entryList.appendChild(li);
  }
}


  // Handle journal submission
  submitBtn.addEventListener("click", async () => {
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
      console.log("Saved entry:", entry);

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
      const li = document.createElement("li");
      const date = new Date(entry.timestamp).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric"
      });

      li.innerHTML = `<strong>${date}</strong><br><em>${entry.prompt}</em><br>${truncate(entry.response, 80)}<br><br>`;
      list.appendChild(li);
    }
  }

modal.classList.remove("hidden");
followUpInput.value = "";
followUpCharCount.textContent = `${maxChars} characters remaining`;

// Save the last entry to chain from
modal.dataset.lastEntryId = newEntry.id;

}



  // Initial setup
  setPrompt("What's on your mind?");
  await displayRecentEntries();
  charCount.textContent = `${maxChars} characters remaining`;
});
