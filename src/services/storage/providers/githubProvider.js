// ========================================================
// 🐙 مزود التخزين: GitHub (Storage Provider)
// طبقة منخفضة المستوى فقط: "ارفع ملف" أو "اعمل كوميت لعدة ملفات".
// لا تعرف شيء عن صور أو منتجات أو كتالوج - هذا مقصود، حتى لو
// تغيّر مزود التخزين لاحقاً (R2 / S3) نلمس هذا الملف فقط.
// ========================================================

const GITHUB_API = 'https://api.github.com';

function githubHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Cloudflare-Worker',
  };
}

// رفع/تحديث ملف واحد عبر Contents API (مناسب للصور)
export async function putSingleFile(env, path, base64Content, commitMessage) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`;
  const headers = githubHeaders(env);

  let sha;
  const existing = await fetch(url, { headers });
  if (existing.ok) {
    sha = (await existing.json()).sha;
  }

  const res = await fetch(url, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ message: commitMessage, content: base64Content, sha }),
  });
  if (!res.ok) throw new Error('فشل رفع الملف إلى GitHub: ' + (await res.text()));

  return `https://cdn.jsdelivr.net/gh/${owner}/${repo}@main/${path}`;
}

// كوميت واحد ذرّي لعدة ملفات دفعة واحدة عبر Git Trees API (مناسب لكتالوج المتجر)
// ⭐ إصلاح (أخطاء منطقية + سباق تزامن): كانت كل استدعاءات fetch هنا بلا أي
// تحقق من res.ok - فشل أي خطوة (توكن منتهي، تعارض تحديث، خطأ GitHub مؤقت)
// كان يعني قراءة JSON خطأ (مثل {message:"Not Found"}) والمتابعة بمحاولة
// الوصول لحقول غير موجودة (refRes.object.sha إلخ)، فيرمي TypeError غامضاً
// بدل رسالة خطأ واضحة، **ويستمر بمحاولة الخطوات التالية ببيانات فاسدة**
// (استهلاك subrequests إضافية بلا فائدة). الأهم: لو وصل طلبان متزامنان
// (تاجر بتبويبين، أو تحديثان سريعان متتاليان) من isolates مختلفة (راجع
// تعليق syncQueue.js - الطابور لا يُسلسل عبر isolates متعددة)، كلاهما يقرأ
// نفس "أحدث كوميت" كأساس، وتحديث الـ ref الثاني يُرفض من GitHub (409/422،
// non-fast-forward) بصمت تام سابقاً - فيختفي تحديث كتالوج كامل بدون أي أثر.
// الحل: تحقق res.ok صريح بكل خطوة + إعادة محاولة كاملة (قراءة أحدث كوميت
// من جديد وإعادة البناء) لو فشل تحديث الـ ref تحديداً بسبب تعارض.
export async function commitMultipleFiles(env, files, commitMessage) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const apiBase = `${GITHUB_API}/repos/${owner}/${repo}`;
  const headers = githubHeaders(env);

  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const refRes = await fetch(`${apiBase}/git/ref/heads/main`, { headers });
    if (!refRes.ok) throw new Error('فشل قراءة أحدث كوميت من GitHub: ' + (await refRes.text()));
    const refData = await refRes.json();
    const latestCommitSha = refData.object.sha;

    const commitRes = await fetch(`${apiBase}/git/commits/${latestCommitSha}`, { headers });
    if (!commitRes.ok) throw new Error('فشل قراءة تفاصيل الكوميت من GitHub: ' + (await commitRes.text()));
    const commitData = await commitRes.json();
    const baseTreeSha = commitData.tree.sha;

    const treeRes = await fetch(`${apiBase}/git/trees`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
      }),
    });
    if (!treeRes.ok) throw new Error('فشل إنشاء شجرة الملفات على GitHub: ' + (await treeRes.text()));
    const treeData = await treeRes.json();

    const newCommitRes = await fetch(`${apiBase}/git/commits`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: commitMessage, tree: treeData.sha, parents: [latestCommitSha] }),
    });
    if (!newCommitRes.ok) throw new Error('فشل إنشاء الكوميت على GitHub: ' + (await newCommitRes.text()));
    const newCommitData = await newCommitRes.json();

    const updateRefRes = await fetch(`${apiBase}/git/refs/heads/main`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ sha: newCommitData.sha }),
    });

    if (updateRefRes.ok) {
      // نرجّع الـ SHA حتى يقدر المستدعي يطابقه مع نشر Vercel المرتبط بهذا
      // الكوميت بالضبط (بدل انتظار أعمى بدون معرفة أي نشر يخص أي تحديث).
      return newCommitData.sha;
    }

    // تعارض تحديث (409/422 عادة) = تاجر/كوميت آخر سبقنا بين قراءة الـ ref
    // وتحديثه. نعيد المحاولة كاملة (قراءة أحدث ref من جديد) بدل فشل صامت.
    const isConflict = updateRefRes.status === 409 || updateRefRes.status === 422;
    if (!isConflict || attempt === MAX_ATTEMPTS) {
      throw new Error('فشل تحديث فرع GitHub الرئيسي: ' + (await updateRefRes.text()));
    }
    console.warn(`[GitHub] تعارض تحديث الفرع، إعادة محاولة ${attempt}/${MAX_ATTEMPTS}...`);
  }
}
