// ========================================================
// ⚙️ ثوابت التطبيق (أدوار المستخدمين وحالات الطلب)
// أي دور أو حالة جديدة تُضاف هنا فقط، وتنعكس تلقائياً
// على طبقة الصلاحيات (rbac) وبقية الموديولات.
// ========================================================

export const ROLES = {
  CUSTOMER: 'customer',
  MERCHANT: 'merchant',
  DELIVERY: 'delivery',
};

export const ORDER_STATUSES = {
  PENDING_MERCHANT_APPROVAL: 'pending_merchant_approval',
  CONFIRMED_BY_STORE: 'confirmed_by_store',
  ACCEPTED_BY_DELIVERY: 'accepted_by_delivery',
  OUT_FOR_DELIVERY: 'out_for_delivery',
};

// الحالات التي تعتبر "طلب نشط" (تمنع حذف/تعديل المنتج المرتبط بها)
export const ACTIVE_ORDER_STATUSES = [
  ORDER_STATUSES.PENDING_MERCHANT_APPROVAL,
  ORDER_STATUSES.CONFIRMED_BY_STORE,
  ORDER_STATUSES.ACCEPTED_BY_DELIVERY,
  ORDER_STATUSES.OUT_FOR_DELIVERY,
];

// ========================================================
// ⭐ إضافة (2026-07-21): ثوابت نطاق التوصيل وحدود السلة —
// منسوخة حرفياً من api.php (define('ALLOWED_DELIVERY_CENTER_LAT', ...) إلخ)
// حتى يطابق create_order بالـ Worker نفس قواعد api.php تماماً.
// ⚠️ إذا غيّرت هذي القيم بـ api.php مستقبلاً، لازم تعدّلها هنا يدوياً أيضاً
// (ما فيه مصدر واحد مشترك بين النظامين حالياً).
// ========================================================
export const ALLOWED_DELIVERY_CENTER_LAT = 15.3694;
export const ALLOWED_DELIVERY_CENTER_LNG = 44.191;
export const MAX_ALLOWED_DELIVERY_RADIUS_KM = 30;

export const MIN_CART_VALUE = 1000;
export const MAX_QTY_PER_ITEM = 50;
export const MAX_TOTAL_QTY = 200;
