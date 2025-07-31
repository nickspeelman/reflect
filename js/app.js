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

  newPromptBtn.addEventListener("click", setNewPrompt);


  // Truncate long responses for summaries
  function truncate(text, length) {
    return text.length > length ? text.substring(0, length) + "..." : text;
  }

  // Display most relevant (or recent) entries
  async function displayRelevantEntries(newEntry = null) {
    const db = await dbPromise;
    const entries = await db.getAll('entries');

    entryList.innerHTML = "";

    if (entries.length === 0) {
      entrySectionTitle.textContent = "Recent Entries";
      entryList.innerHTML = "<li>You haven't made any entries yet.</li>";
      return;
    }

    let displayEntries = [];

    if (newEntry) {
      const pastEntries = entries.filter(
        e => e.id !== newEntry.id && Array.isArray(e.embedding)
      );

      if (pastEntries.length === 0) {
        displayEntries = [newEntry];
        entrySectionTitle.textContent = "Recent Entry";
      } else {
        const scored = pastEntries.map(entry => ({
          ...entry,
          relevance: scoreRelevance(newEntry, entry)
        }));

        displayEntries = scored
          .sort((a, b) => b.relevance - a.relevance)
          .slice(0, 3);

        entrySectionTitle.textContent = "Potentially Relevant Entries";
      }
    } else {
      displayEntries = entries.slice(-3).reverse();
      entrySectionTitle.textContent = "Recent Entries";
    }

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
      setPrompt("After reviewing these entries, do you have anything to add?");

      // Show relevant entries
      await displayRelevantEntries(entry);
    } catch (err) {
      console.error("❌ Error during submission:", err);
      alert("Something went wrong while processing your entry.");
    } finally {
      splash.classList.add("hidden");
    }
  });

  // Initial setup
  setNewPrompt();
  displayRelevantEntries();
  charCount.textContent = `${maxChars} characters remaining`;
});
