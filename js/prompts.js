// js/prompts.js

const PROMPTS = [
  "What’s on your mind right now?",
  "What have you been carrying lately?",
  "What feels unfinished or unresolved?",
  "What are you avoiding?",
  "What would you say if no one was listening?",
  "What feels heavy?",
  "What feels true today?"
];

export function getRandomPrompt() {
  const index = Math.floor(Math.random() * PROMPTS.length);
  return PROMPTS[index];
}
