import { HttpError } from '../../security/rbac.js';

// ========================================================
// 🚦 تحديد معدل الطلبات لمسار الدردشة (ai_chat)
// يمنع استنزاف رصيد Workers AI أو هجمات إغراق بسيطة على نفس المتجر.
//
// الأسلوب الأساسي: Cloudflare Rate Limiting Binding (سريع، بلا كتابة
// على D1، يُضبط في wrangler.toml - راجع ملف wrangler.toml.txt المرفق).
// في حال عدم توفر الـ binding (مثلاً أثناء التطوير المحلي)، نسقط تلقائياً
// إلى فحص احتياطي مبنى على D1 حتى لا ينكسر المسار بالكامل.
// ========================================================

const FALLBACK_WINDOW_MS = 60 * 1000; // نافذة دقيقة واحدة
const FALLBACK_MAX_REQUESTS = 10; // 10 رسائل بالدقيقة لكل مفتاح (تاجر+عميل)

export async function assertRateLimitOk(env, { merchantId, clientIp }) {
  const key = `ai_chat:${merchantId}:${clientIp || 'unknown'}`;

  // --- الأسلوب الأساسي: binding مخصص لتحديد المعدل ---
  if (env.AI_CHAT_RATE_LIMITER && typeof env.AI_CHAT_RATE_LIMITER.limit === 'function') {
    const { success } = await env.AI_CHAT_RATE_LIMITER.limit({ key });
    if (!success) {
      throw new HttpError('عدد الرسائل تجاوز الحد المسموح، حاول بعد قليل.', 429);
    }
    return;
  }

  // --- الأسلوب الاحتياطي: عدّاد بسيط في D1 ---
  if (!env.DB) return; // لا يوجد DB متاح (لا يجب أن يحدث بالإنتاج) - نمرّر بدون حظر

  const now = Date.now();
  const windowStart = now - FALLBACK_WINDOW_MS;

  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS ai_chat_rate_limit (
      rate_key TEXT PRIMARY KEY,
      request_count INTEGER NOT NULL DEFAULT 0,
      window_started_at INTEGER NOT NULL
    )`
  ).run();

  const row = await env.DB.prepare(`SELECT request_count, window_started_at FROM ai_chat_rate_limit WHERE rate_key = ?`)
    .bind(key)
    .first();

  if (!row || row.window_started_at < windowStart) {
    // نافذة جديدة
    await env.DB.prepare(
      `INSERT INTO ai_chat_rate_limit (rate_key, request_count, window_started_at)
       VALUES (?, 1, ?)
       ON CONFLICT(rate_key) DO UPDATE SET request_count = 1, window_started_at = excluded.window_started_at`
    )
      .bind(key, now)
      .run();
    return;
  }

  if (row.request_count >= FALLBACK_MAX_REQUESTS) {
    throw new HttpError('عدد الرسائل تجاوز الحد المسموح، حاول بعد قليل.', 429);
  }

  await env.DB.prepare(`UPDATE ai_chat_rate_limit SET request_count = request_count + 1 WHERE rate_key = ?`)
    .bind(key)
    .run();
}
