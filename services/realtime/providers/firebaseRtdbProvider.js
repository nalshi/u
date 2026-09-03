// ========================================================
// 📡 مزود المزامنة اللحظية: Firebase Realtime Database
// ========================================================

export async function writeToRealtimeDb(env, path, data, method = 'PUT') {
  try {
    if (!env.FIREBASE_DB_URL || !env.FIREBASE_DB_SECRET) return;
    const base = env.FIREBASE_DB_URL.replace(/\/$/, '');
    await fetch(`${base}/${path}.json?auth=${env.FIREBASE_DB_SECRET}`, {
      method,
      body: JSON.stringify(data),
    });
  } catch (e) {
    console.error('writeToRealtimeDb error:', e);
  }
}
