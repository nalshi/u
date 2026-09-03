// ========================================================
// 🔧 أدوات ترميز عامة (Base64 / PEM) - مشتركة بين كل الخدمات
// ========================================================

// ⭐ إصلاح أداء حرج (استهلاك وقت المعالج/CPU time): كانت هذه الدالة تبني
// سلسلة نصية بعملية += متكررة لكل بايت على حدة (binary += ...). السلاسل
// النصية بجافاسكربت غير قابلة للتعديل (immutable)، فكل += قد ينسخ كامل
// المحتوى السابق فعلياً بمحركات JS كثيرة - أداء تربيعي O(n²) تقريباً مع
// حجم البيانات. لصورة منتج حقيقية (مئات الكيلوبايتات لعدة ميغابايتات) هذا
// يستهلك مللي ثوانٍ كثيرة من وقت المعالج بسهولة - وخطة Cloudflare Workers
// المجانية تمنح 10ms فقط لكامل الطلب! صورة واحدة كبيرة كانت كافية لتفشل
// الطلب بالكامل بخطأ "تجاوز حدود الموارد". الحل: معالجة البيانات على
// دفعات (chunks) بدل بايت بايت - عدد عمليات ضم السلاسل ينخفض من ملايين
// إلى مئات فقط لنفس حجم الصورة.
export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK_SIZE = 8192;
  const chunks = [];
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK_SIZE)));
  }
  return btoa(chunks.join(''));
}

export function base64UrlEncode(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export function base64UrlDecodeToString(str) {
  return atob(str.replace(/-/g, '+').replace(/_/g, '/'));
}

export function base64UrlToBytes(str) {
  const bin = base64UrlDecodeToString(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
