// ========================================================
// 🗂️ خدمة الفئات (Categories)
// ========================================================

export async function resolveCategoryChain(env, merchantId, chainNames, anchorId) {
  let parentId = anchorId ? parseInt(anchorId) : 0;

  // ⭐ إصلاح: anchorId يأتي من العميل (body.category_anchor_id) بدون أي
  // تحقق من ملكيته. لو أُرسل معرّف فئة تخص تاجراً آخر، كانت تُنشأ فئة جديدة
  // بـ parent_id يشير لصف لا يملكه هذا التاجر - لا يكشف ولا يعدّل بيانات
  // التاجر الآخر (getCategoriesTree يفلتر حسب الملكية أصلاً)، لكنها فئة
  // "يتيمة" فعلياً بشجرة هذا التاجر (تلوّث بيانات). نتحقق أن anchorId يخص
  // هذا التاجر فعلاً (أو فئة عامة مشتركة user_id IS NULL) قبل استخدامه،
  // وإلا نبدأ من الجذر بدل تجاهل المشكلة بصمت.
  if (parentId) {
    const anchorRow = await env.DB.prepare(
      `SELECT id FROM categories WHERE id = ? AND (user_id = ? OR user_id IS NULL)`
    )
      .bind(parentId, merchantId)
      .first();
    if (!anchorRow) parentId = 0;
  }

  let finalId = parentId;

  for (const name of chainNames) {
    const cleanName = String(name).trim();
    if (!cleanName) continue;

    const existing = await env.DB.prepare(
      `SELECT id FROM categories WHERE name = ? AND parent_id = ? AND user_id = ?`
    )
      .bind(cleanName, parentId, merchantId)
      .first();

    if (!existing) {
      const insertRes = await env.DB.prepare(
        `INSERT INTO categories (name, parent_id, user_id, created_at) VALUES (?, ?, ?, ?)`
      )
        .bind(cleanName, parentId, merchantId, Date.now())
        .run();
      finalId = insertRes.meta.last_row_id;
    } else {
      finalId = existing.id;
    }
    parentId = finalId;
  }
  return finalId;
}

export async function getCategoriesTree(env, merchantId) {
  const cats = await env.DB.prepare(
    `SELECT id, name, parent_id FROM categories WHERE user_id = ? OR user_id IS NULL ORDER BY parent_id, name`
  )
    .bind(merchantId)
    .all();
  return cats.results;
}
