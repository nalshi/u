// ========================================================
// ▲ مزود انتظار نشر Vercel (Vercel Deployment Polling)
// ⚠️ السبب: المتجر منشور فعلياً على Vercel، وVercel يقرأ ملفات الكتالوج
// من نفس مستودع GitHub. أي كوميت جديد يخلي Vercel يبدأ "نشر" (Deployment)
// خاص فيه — بناء يأخذ من ثوانٍ لدقيقة أو أكثر، وليس فوري. لو مسحنا كاش
// Cloudflare قبل ما يصير هذا النشر "READY"، أول طلب بعد المسح يوصل
// لنسخة Vercel القديمة (النشر السابق) ويُعاد تخزينها بالكاش من جديد —
// فتوصل النتيجة "الكاش انمسح لكن القديم رجع"، بغض النظر عن أي تأخير
// ثابت (5 ثوانٍ قد تكفي أحياناً وما تكفي غيرها).
//
// الحل: بعد الكوميت، نطابق SHA الكوميت مع نشرات Vercel (حقل
// meta.githubCommitSha) ونستنى فعلياً لين تلقى النشر المطابق بحالة
// READY (أو تنتهي مهلة الانتظار)، وبعدها فقط نمسح كاش Cloudflare.
//
// ⚙️ متغيرات بيئة مطلوبة (secrets/vars على الـ Worker):
//   - VERCEL_TOKEN        : توكن Vercel (Account Settings > Tokens)
//   - VERCEL_PROJECT_ID   : معرّف مشروع Vercel (أو اسمه)
//   - VERCEL_TEAM_ID      : (اختياري) لو المشروع تحت فريق/منظمة
// إذا لم تكن مُهيأة، الدالة ترجع فوراً (best-effort) حتى لا تكسر بقية
// المزامنة - بنفس نمط مزودات الخلفية الأخرى بالمشروع.
// ========================================================

const VERCEL_API = 'https://api.vercel.com';
const POLL_INTERVAL_MS = 3000;
// ⭐ إصلاح توافق منصّة (Cloudflare Workers): كانت هذي القيمة 90000 (90
// ثانية). لكن مهام ctx.waitUntil() على Cloudflare Workers تشارك سقف وقت
// جدارية إجمالي قريب من 30 ثانية فقط لكامل المهمة الخلفية - وليس فقط
// "وقت المعالج" - وتُقطَع المهمة بالكامل من المنصّة نفسها لو تجاوزته، بغض
// النظر عن أي منطق مهلة داخلي بهذه الدالة. بما أن استدعاء GitHub
// (commitMultipleFiles) ومسح كاش Cloudflare يحدثان بنفس المهمة الخلفية
// (قبل وبعد هذا الانتظار على التوالي، راجع catalogSyncService.js)، كان
// انتظار 90 ثانية يعني قطع المهمة بالكامل من المنصّة **قبل** الوصول لسطر
// مسح الكاش إطلاقاً في أي نشر Vercel يأخذ أكثر من ~25 ثانية (وهو سيناريو
// شائع فعلياً حسب تعليق الدالة نفسها: "من ثوانٍ لدقيقة أو أكثر") - فيفشل
// مسح الكاش بصمت تام، ويبقى الزوار يرون نسخة قديمة من المتجر حتى تنتهي
// صلاحية الكاش طبيعياً. تقليل المهلة يضمن إتاحة وقت كافٍ لخطوة المسح
// دائماً (تبقى "أفضل جهد" تماماً كالسابق - المسح يحدث دائماً بعد المحاولة
// سواء نجح الانتظار أو انتهت مهلته الداخلية، لا تغيير بذلك المنطق).
const MAX_WAIT_MS = 15000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// يستنى لين نشر Vercel المرتبط بـ commitSha يصير READY، أو تنتهي المهلة.
// يرجع true لو تأكدنا إن النشر جاهز، false لو ما قدرنا نتأكد (فالمستدعي
// يقرر بنفسه هل يكمل بحذر أو لا - راجع catalogSyncService.js).
export async function waitForVercelDeployment(env, commitSha) {
  if (!env.VERCEL_TOKEN || !env.VERCEL_PROJECT_ID) {
    console.warn('Vercel deployment wait skipped: VERCEL_TOKEN or VERCEL_PROJECT_ID missing');
    return false;
  }
  if (!commitSha) {
    console.warn('Vercel deployment wait skipped: no commit SHA provided');
    return false;
  }

  const headers = { Authorization: `Bearer ${env.VERCEL_TOKEN}` };
  const teamQuery = env.VERCEL_TEAM_ID ? `&teamId=${env.VERCEL_TEAM_ID}` : '';
  const url = `${VERCEL_API}/v6/deployments?projectId=${env.VERCEL_PROJECT_ID}&limit=10${teamQuery}`;

  const startedAt = Date.now();

  while (Date.now() - startedAt < MAX_WAIT_MS) {
    try {
      const res = await fetch(url, { headers });
      if (res.ok) {
        const data = await res.json();
        const deployments = data.deployments || [];
        const match = deployments.find((d) => d.meta && d.meta.githubCommitSha === commitSha);

        if (match) {
          if (match.readyState === 'READY') {
            console.log(`[Vercel] Deployment ${match.uid} for commit ${commitSha} is READY`);
            return true;
          }
          if (match.readyState === 'ERROR' || match.readyState === 'CANCELED') {
            console.error(`[Vercel] Deployment ${match.uid} for commit ${commitSha} failed: ${match.readyState}`);
            return false;
          }
          // لسا BUILDING/QUEUED/INITIALIZING - نكمل الانتظار
        }
      } else {
        console.error('[Vercel] Deployment lookup failed:', await res.text());
      }
    } catch (error) {
      console.error('[Vercel] Deployment lookup error:', error);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  console.warn(`[Vercel] Timed out after ${MAX_WAIT_MS}ms waiting for commit ${commitSha} to deploy`);
  return false;
}
