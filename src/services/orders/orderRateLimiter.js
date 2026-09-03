import { HttpError } from '../../security/rbac.js';

// ========================================================
// 🚦 تحديد معدل إنشاء الطلبات (create_order) لكل عميل
// ⭐ إصلاح: create_order (أهم وأثقل أكشن بالمشروع - يكتب على المخزون،
// يُشغّل مزامنة GitHub/Vercel/Cloudflare، يرسل إشعارات) لم يكن محمياً بأي
// حد لمعدل الطلبات، بخلاف ai_chat الذي له نظام مخصص أصلاً. حساب عميل واحد
// (مخترق أو آلي) كان يقدر يستدعيه بشكل متكرر جداً لإغراق التجار بطلبات
// وهمية أو استنزاف المخزون. نفس نمط ai/rateLimiter.js بالضبط (عدّاد D1
// بسيط لكل عميل)، لكن بجدول/حد منفصلين يناسبان طبيعة الطلبات (أقل تكراراً
// من رسائل الدردشة، فحدّ أعلى قليلاً لتفادي إزعاج عميل حقيقي يشتري من
// أكثر من متجر خلال دقائق قليلة). فشل مفتوح (لا يمنع الطلب) عند أي خطأ
// غير متوقع بالفحص نفسه، حتى لا يتوقف نظام الطلبات بالكامل بسبب عطل بهذا
// الفحص الإضافي.
// ========================================================

const WINDOW_MS = 5 * 60 * 1000; // نافذة 5 دقائق
const MAX_ORDERS_PER_WINDOW = 8;

export async function assertOrderRateLimitOk(env, customerId) {
  try {
    if (!env.DB || !customerId) return;

    const key = `create_order:${customerId}`;
    const now = Date.now();
    const windowStart = now - WINDOW_MS;

    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS order_rate_limit (
        rate_key TEXT PRIMARY KEY,
        request_count INTEGER NOT NULL DEFAULT 0,
        window_started_at INTEGER NOT NULL
      )`
    ).run();

    const row = await env.DB.prepare(
      `SELECT request_count, window_started_at FROM order_rate_limit WHERE rate_key = ?`
    )
      .bind(key)
      .first();

    if (!row || row.window_started_at < windowStart) {
      await env.DB.prepare(
        `INSERT INTO order_rate_limit (rate_key, request_count, window_started_at)
         VALUES (?, 1, ?)
         ON CONFLICT(rate_key) DO UPDATE SET request_count = 1, window_started_at = excluded.window_started_at`
      )
        .bind(key, now)
        .run();
      return;
    }

    if (row.request_count >= MAX_ORDERS_PER_WINDOW) {
      throw new HttpError('عدد محاولات إنشاء الطلبات كبير جداً خلال وقت قصير. يرجى الانتظار قليلاً.', 429);
    }

    await env.DB.prepare(`UPDATE order_rate_limit SET request_count = request_count + 1 WHERE rate_key = ?`)
      .bind(key)
      .run();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    console.error('assertOrderRateLimitOk error (fail-open):', e);
  }
}
