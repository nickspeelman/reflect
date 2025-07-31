// db.js
export const dbPromise = idb.openDB('journalDB', 1, {
  upgrade(db) {
    if (!db.objectStoreNames.contains('entries')) {
      db.createObjectStore('entries', { keyPath: 'id' });
    }
    if (!db.objectStoreNames.contains('settings')) {
      db.createObjectStore('settings');
    }
  },
});
