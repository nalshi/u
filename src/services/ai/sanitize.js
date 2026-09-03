// ========================================================
// 🧼 تعقيم المدخلات والمخرجات الخاصة بميزة "المساعد الذكي"
// تُستخدم في 3 نقاط:
//   1) عند حفظ إعدادات التاجر (bot_name / custom_rules)
//   2) عند استقبال رسالة العميل قبل إرسالها للـ LLM
//   3) عند استقبال رد الـ LLM قبل إعادته للعميل (دفاع من الدرجة الثانية
//      في حال قام الموديل بالخطأ بتوليد HTML/سكربت داخل رده)
// ========================================================

const HTML_ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

// ⚠️ الدالة الوحيدة المسؤولة عن الهروب من HTML بكل الميزة - أي نص يُعرض
// لاحقاً في واجهة (لوحة التاجر أو ودجت العميل) يجب أن يمر من هنا أولاً.
export function escapeHtml(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/[&<>"'`]/g, (ch) => HTML_ESCAPE_MAP[ch]);
}

// تنظيف نص عام: إزالة أحرف التحكم غير المرئية (منها ما يُستخدم بهجمات
// حقن التوجيهات لإخفاء تعليمات داخل نص يبدو عادياً)، وقص الطول الأقصى.
export function sanitizePlainText(input, maxLength = 500) {
  if (typeof input !== 'string') return '';
  return input
    // إزالة أحرف التحكم (0x00-0x1F, 0x7F) باستثناء السطر الجديد والتاب
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim()
    .slice(0, maxLength);
}

// اسم البوت: نص قصير بدون HTML، بدون أسطر متعددة
export function sanitizeBotName(name) {
  const clean = sanitizePlainText(String(name || ''), 40).replace(/\s+/g, ' ');
  return clean || 'المساعد الذكي';
}

const ALLOWED_TONES = new Set(['friendly', 'formal', 'funny', 'professional', 'concise']);
export function sanitizeTone(tone) {
  return ALLOWED_TONES.has(tone) ? tone : 'friendly';
}

// القواعد المخصصة: كل سطر = قاعدة. نحدد عدد الأسطر وطول كل سطر لمنع
// تضخيم الـ prompt (وبالتالي التكلفة) أو حقن نصوص طويلة جداً.
const MAX_RULES = 25;
const MAX_RULE_LENGTH = 200;

export function sanitizeCustomRules(rawRules) {
  let lines = [];
  if (Array.isArray(rawRules)) {
    lines = rawRules;
  } else if (typeof rawRules === 'string') {
    lines = rawRules.split('\n');
  }

  return lines
    .map((line) => sanitizePlainText(String(line || ''), MAX_RULE_LENGTH))
    .filter((line) => line.length > 0)
    .slice(0, MAX_RULES);
}

// رسالة العميل قبل إرسالها للـ LLM: تحديد طول أقصى معقول لرسالة دردشة
// (يمنع إغراق النموذج بنص ضخم يرفع التكلفة أو يحاول "تعويم" حقن التوجيهات)
export function sanitizeCustomerMessage(message) {
  return sanitizePlainText(String(message || ''), 1000);
}

// سجل المحادثة السابق (يُرسَل من الواجهة الأمامية مع كل رسالة جديدة حتى
// يقدر المساعد يربط سؤال العميل الحالي بسياق ما قبله، مثل: "زوّده" بعد
// ما سأل عن منتج معيّن). نتعامل معه كبيانات غير موثوقة تماماً مثل رسالة
// العميل نفسها:
//   - نقبل فقط الأدوار المعروفة (user / assistant)
//   - نُعقّم كل رسالة بنفس طريقة رسالة العميل (لا HTML، طول محدود)
//   - نحدّ عدد الأسطر المقبولة من السجل لمنع تضخيم الطلب (وبالتالي التكلفة)
//     أو محاولة إغراق النموذج بسياق طويل مصطنع
const MAX_HISTORY_TURNS = 12; // عدد الرسائل (وليس المحادثات) الأخيرة المقبولة
const MAX_HISTORY_MESSAGE_LENGTH = 600;

export function sanitizeConversationHistory(rawHistory) {
  if (!Array.isArray(rawHistory)) return [];

  const cleaned = rawHistory
    .filter((item) => item && (item.role === 'user' || item.role === 'assistant'))
    .slice(-MAX_HISTORY_TURNS)
    .map((item) => ({
      role: item.role === 'assistant' ? 'model' : 'user',
      text: sanitizePlainText(String(item.message || item.text || ''), MAX_HISTORY_MESSAGE_LENGTH),
    }))
    .filter((item) => item.text.length > 0);

  // Gemini يشترط أن تبدأ المحادثة بدور "user" - نحذف أي رسائل "model" في
  // بداية السجل (مثل رسالة ترحيب آلية) قد تتسبب بخطأ 400 من الـ API.
  const firstUserIndex = cleaned.findIndex((item) => item.role === 'user');
  return firstUserIndex === -1 ? [] : cleaned.slice(firstUserIndex);
}
