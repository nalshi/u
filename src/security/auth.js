import { base64UrlDecodeToString, base64UrlToBytes } from '../core/encoding.js';

// ========================================================
// 🛡️ مقارنة بطول/زمن ثابت (Constant-Time Compare)
// تُستخدم لمقارنة أي سر/مفتاح داخلي (مثل X-Internal-Key) بدل `!==`
// العادية، حتى لا يكشف فرق التوقيت بين المحاولات الصحيحة والخاطئة أي
// معلومة عن مدى تطابق الأحرف (Timing Attack). نفس المبدأ المستخدم أصلاً
// بتحقق توقيع واتساب (whatsappController.js).
// ========================================================
export function timingSafeEqual(a, b) {
  const strA = String(a || '');
  const strB = String(b || '');
  if (strA.length !== strB.length) return false;
  let diff = 0;
  for (let i = 0; i < strA.length; i++) diff |= strA.charCodeAt(i) ^ strB.charCodeAt(i);
  return diff === 0;
}

// ========================================================
// 🛡️ التوقيع الرقمي والتحقق من بصمة الطلب (HMAC-SHA256)
// ========================================================
export async function generateHmacSignature(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyHmacSignature(secret, message, expectedSignature) {
  if (!secret || !message || !expectedSignature) return false;
  try {
    const actualSignature = await generateHmacSignature(secret, message);
    return timingSafeEqual(actualSignature, expectedSignature);
  } catch (e) {
    return false;
  }
}

// ========================================================
// 🛡️ التحقق من JWT (Web Crypto API)
// تحسينات أمنية مقارنة بالنسخة الأصلية:
//  1) رفض أي alg غير HS256 صراحة (منع هجوم alg=none / تبديل الخوارزمية)
//  2) رفض أي توكن بدون exp صريح (لا نسمح بتوكن "أبدي")
//  3) رفض أي توكن بدون user_id أو role (حماية من payload ناقص)
// ========================================================
export async function verifyJWT(token, secretKey) {
  try {
    if (!token || !secretKey) return null;

    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, signatureB64] = parts;

    const header = JSON.parse(base64UrlDecodeToString(headerB64));
    if (header.alg !== 'HS256') return null;

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secretKey),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const dataToVerify = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const sigBytes = base64UrlToBytes(signatureB64);

    const isValid = await crypto.subtle.verify('HMAC', key, sigBytes, dataToVerify);
    if (!isValid) return null;

    const payload = JSON.parse(base64UrlDecodeToString(payloadB64));

    if (!payload.exp) return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!payload.user_id || !payload.role) return null;

    return payload; // { user_id, role, username, ... }
  } catch (e) {
    return null;
  }
}
