import { writeToRealtimeDb } from './providers/firebaseRtdbProvider.js';

// ========================================================
// 📡 خدمة مزامنة تتبع الطلب اللحظي
// ========================================================

export async function syncOrderTracking(env, ticketId, status, merchantUsername) {
  await writeToRealtimeDb(env, `tracking/${ticketId}`, {
    status,
    merchant_username: merchantUsername,
    updated_at: Date.now(),
  });
}
