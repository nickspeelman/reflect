// js/app.js

import { processEntry, scoreRelevance } from './ai.js';
import { getRandomPrompt } from './prompts.js';

document.addEventListener("DOMContentLoaded", () => {
  const promptEl = document.getElementById("prompt");
  const newPromptBtn = document.getElementById("newPrompt");
  const entryInput = document.getElementById("journalEntry");
  const submitBtn = document.getElementById("submitEntry");
  const entryList = document.getElementById("entryList");
  const charCount = document.getElementById("charCount");
  const maxChars = 2000;

  const modal = document.getElementById("entryModal");
    const modalContent = document.getElementById("modalContent");
    const closeModal = document.getElementById("closeModal");

    closeModal.addEventListener("click", () => {
    modal.classList.add("hidden");
    });

    window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") modal.classList.add("hidden");
    });


  let currentPrompt = getRandomPrompt();
  promptEl.textContent = currentPrompt;

  newPromptBtn.addEventListener("click", () => {
    currentPrompt = getRandomPrompt();
    promptEl.textContent = currentPrompt;
  });

  entryInput.addEventListener("input", () => {
    const remaining = maxChars - entryInput.value.length;
    charCount.textContent = `${remaining} characters remaining`;
  });

  submitBtn.addEventListener("click", async () => {
  const text = entryInput.value.trim();
  if (!text) return;

  const splash = document.getElementById("processingSplash");
  splash.classList.remove("hidden"); // ✅ Show splash

  try {
    const aiData = await processEntry(text);

    const entry = {
      id: crypto.randomUUID(),
      date: new Date().toISOString().split("T")[0],
      prompt: currentPrompt,
      response: text,
      ...aiData
    };

    saveEntry(entry);
    console.log("Saved entry:", entry);

    entryInput.value = "";
    charCount.textContent = `${maxChars} characters remaining`;

    // Update prompt
    currentPrompt = getRandomPrompt();
    promptEl.textContent = "After reviewing these entries, do you have anything to add?";

    displayRelevantEntries(entry);
  } catch (err) {
    console.error("❌ Error during submission:", err);
    alert("Something went wrong while processing your entry.");
  } finally {
    splash.classList.add("hidden"); // ✅ Always hide splash
  }
});


  function saveEntry(entry) {
    const entries = JSON.parse(localStorage.getItem("journalEntries") || "[]");
    entries.push(entry);
    localStorage.setItem("journalEntries", JSON.stringify(entries));
  }

function displayRelevantEntries(newEntry = null) {
  const entries = JSON.parse(localStorage.getItem("journalEntries") || "[]");
  const entryList = document.getElementById("entryList");
  const entrySectionTitle = document.getElementById("entrySectionTitle");
  const modal = document.getElementById("entryModal");
  const modalContent = document.getElementById("modalContent");

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
    // First-ever entry — show it instead of skipping
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
}
 else {
    // Show 3 most recent entries (newest first)
    displayEntries = entries.slice(-3).reverse();
    entrySectionTitle.textContent = "Recent Entries";
  }

  entryList.innerHTML = "";

  for (const entry of displayEntries) {
    const li = document.createElement("li");

    const wrapper = document.createElement("div");
    wrapper.className = "entry-wrapper";

    const date = new Date(entry.date).toLocaleDateString(undefined, {
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
      modalContent.textContent = entry.response;
      modal.classList.remove("hidden");
    });

    buttonWrapper.appendChild(expand);
    wrapper.appendChild(text);
    wrapper.appendChild(buttonWrapper);
    li.appendChild(wrapper);
    entryList.appendChild(li);
  }
}





  function truncate(text, length) {
    return text.length > length ? text.substring(0, length) + "..." : text;
  }

  // Initial UI setup
  displayRelevantEntries();
  charCount.textContent = `${maxChars} characters remaining`;
});
