import { sendFcmNotification } from './providers/fcmProvider.js';

// ========================================================
// 🔔 خدمة الإشعارات - منطق العمل فقط
// ⚠️ ملاحظة مهمة: العملاء (customers) والتجار/المناديب (users) في جدولين
// منفصلين بالـ D1. أي دالة تُشعر عميلاً يجب أن تقرأ fcm_token من جدول
// customers، وأي دالة تُشعر تاجراً تقرأه من جدول users، وإلا لن يصل
// الإشعار إطلاقاً رغم عدم وجود أي خطأ ظاهر.
// ========================================================

const STATUS_LABELS_AR = {
  pending_merchant_approval: 'بانتظار موافقة التاجر',
  confirmed_by_store: 'تم تأكيد الطلب من المتجر',
  accepted_by_delivery: 'تم قبول الطلب من مندوب التوصيل',
  out_for_delivery: 'خرج الطلب للتوصيل',
  completed: 'تم تسليم الطلب بنجاح',
  cancelled: 'تم إلغاء الطلب',
};

function statusLabel(status) {
  return STATUS_LABELS_AR[status] || status;
}

async function getCustomerFcmToken(env, customerId) {
  const row = await env.DB.prepare(`SELECT fcm_token FROM customers WHERE id = ?`)
    .bind(customerId)
    .first();
  return (row && row.fcm_token) || null;
}

async function getMerchantFcmToken(env, merchantId) {
  const row = await env.DB.prepare(`SELECT fcm_token FROM users WHERE id = ?`)
    .bind(merchantId)
    .first();
  return (row && row.fcm_token) || null;
}

// 📦 يُستدعى عندما يغيّر التاجر حالة الطلب (موافقة، خرج للتوصيل، ...) —
// يُشعر العميل بحالته الجديدة.
export async function notifyOrderStatusUpdate(env, customerId, status, ticketId) {
  const token = await getCustomerFcmToken(env, customerId);
  if (!token) return;

  await sendFcmNotification(
    env,
    token,
    'تحديث حالة طلبك 📦',
    `تم تحديث حالة طلبك إلى: ${statusLabel(status)}`,
    { action: 'order_status_update', ticket_id: ticketId, status }
  );
}

// 🏪 يُستدعى بالتوازي مع notifyOrderStatusUpdate ليصل تأكيد بنفس التحديث
// للتاجر أيضاً (مفيد لو كان يستخدم أكثر من جهاز/لوحة تحكم).
export async function notifyMerchantOrderUpdate(env, merchantId, status, ticketId) {
  const token = await getMerchantFcmToken(env, merchantId);
  if (!token) return;

  await sendFcmNotification(
    env,
    token,
    'تحديث حالة طلب 🛍️',
    `تم تحديث حالة الطلب رقم ${String(ticketId).slice(0, 8)} إلى: ${statusLabel(status)}`,
    { action: 'order_status_update', ticket_id: ticketId, status }
  );
}

// ✅ يُستدعى عند اتمام الطلب فعلياً (تأكيد كود التسليم) — يصل للعميل
// والتاجر معاً بشكل صحيح، كل واحد من جدوله الخاص.
export async function notifyOrderCompleted(env, { customerId, merchantId, ticketId, grandTotal, currency }) {
  const [customerToken, merchantToken] = await Promise.all([
    getCustomerFcmToken(env, customerId),
    getMerchantFcmToken(env, merchantId),
  ]);

  const tasks = [];
  if (customerToken) {
    tasks.push(
      sendFcmNotification(
        env,
        customerToken,
        'تم تسليم طلبك ✅',
        'تم تأكيد استلامك للطلب بنجاح. شكراً لثقتك بنا!',
        { action: 'order_completed', ticket_id: ticketId }
      )
    );
  }
  if (merchantToken) {
    tasks.push(
      sendFcmNotification(
        env,
        merchantToken,
        'تم إتمام الطلب 💰',
        `تم تسليم الطلب رقم ${String(ticketId).slice(0, 8)} وتوثيق مبلغ ${grandTotal} ${currency} في رصيدك.`,
        { action: 'order_completed', ticket_id: ticketId }
      )
    );
  }
  await Promise.all(tasks);
}
