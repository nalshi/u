// ========================================================
// ☁️ مزود مسح الكاش: Cloudflare Cache Purge
// ⚠️ ملاحظة مهمة (2026-07-24): جرّبنا "مسح روابط محددة" (purge by URL)
// وطلعت الاستجابة "success" دائماً لكن الكاش الفعلي ما ينمسح — على الأغلب
// بسبب Cache Rule بمفتاح كاش مخصص (Custom Cache Key) على الـ Zone يخلي
// مفتاح الكاش الداخلي مختلف عن الرابط الظاهري، فمسح رابط بعينه ما يطابقه.
// تم التأكيد يدويًا إن "Purge Everything" هو الوحيد اللي يشتغل فعليًا على
// هذا الـ Zone، فتحوّلنا له بدل مسح الروابط الفردية.
//
// ⚙️ متغيرات بيئة مطلوبة (secrets/vars على الـ Worker):
//   - CLOUDFLARE_API_TOKEN  : توكن بصلاحية "Cache Purge" على الـ Zone فقط
//   - CLOUDFLARE_ZONE_ID    : معرّف الـ Zone الخاص بدومين واجهة المتجر
// إذا لم تكن مُهيأة، الدالة تتجاهل العملية بصمت (نفس نمط باقي
// المزامنات الخلفية بالمشروع) حتى لا تكسر مزامنة GitHub الأساسية.
// ⚠️ حد Cloudflare لـ Purge Everything على الخطة المجانية: 5 طلبات/دقيقة
// (مشترك مع باقي أنواع الـ purge غير purge-by-URL). لو صار عندك رفع
// منتجات متكرر جداً بفارق ثوانٍ، ممكن تشوف أخطاء 429 - وهذا متوقع ومقبول
// بما إن الموقع متجر واحد صغير.
// ========================================================

const CF_API = 'https://api.cloudflare.com/client/v4';

export async function purgeCloudflareCache(env, urls) {
  try {
    if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ZONE_ID) {
      console.warn('Cloudflare Cache Purge skipped: CLOUDFLARE_API_TOKEN or CLOUDFLARE_ZONE_ID missing');
      return;
    }

    const res = await fetch(`${CF_API}/zones/${env.CLOUDFLARE_ZONE_ID}/purge_cache`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ purge_everything: true }),
    });

    if (!res.ok) {
      console.error('Cloudflare Cache Purge failed:', await res.text());
    } else {
      console.log('Cloudflare Cache Purge success: purge_everything');
    }
  } catch (error) {
    console.error('Cloudflare Cache Purge Error:', error);
  }
}

// يبني روابط ملفات متجر تاجر معيّن على دومين واجهة المتجر (STOREFRONT_BASE_URL)
// حتى نمسح فقط روابط هذا التاجر تحديداً (وليس كل الدومين).
export function buildStoreFileUrls(env, paths) {
  const base = (env.STOREFRONT_BASE_URL || '').replace(/\/+$/, '');
  if (!base) return [];
  return (paths || []).map((p) => `${base}/${String(p).replace(/^\/+/, '')}`);
}
