import { resolveCategoryChain } from '../services/categories/categoryService.js';
import { uploadProductImage } from '../services/images/imageService.js';
import { syncCatalogToStorefront } from '../services/catalog/catalogSyncService.js';
import { HttpError } from '../security/rbac.js';
import { ACTIVE_ORDER_STATUSES } from '../config/constants.js';

// ========================================================
// 🏪 تحكم المنتجات (تاجر فقط)
// ========================================================

// ⭐ إصلاح أمني (ثغرة IDOR): معرّف المنتج قد يأتي من العميل (تعديل منتج
// موجود)، ويُستخدم لاحقاً كجزء من مسار ملف الصورة على GitHub (راجع
// imageService.js). بدون قيد صارم على شكله، كان بالإمكان تمرير معرّف يحتوي
// "/" أو ".." لتحويل مسار رفع الصورة لمكان آخر تماماً بمستودع GitHub
// (اجتياز مسار). نقصر الشكل المقبول على نفس صيغة المعرّفات التي يولّدها
// النظام نفسه (حروف/أرقام/شرطات فقط) لإغلاق هذا المسار نهائياً.
const PRODUCT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export async function saveProduct({ env, ctx, user, body, uploadedImageFile }) {
  let pid;
  if (body.id) {
    if (!PRODUCT_ID_PATTERN.test(String(body.id))) {
      throw new HttpError('معرّف المنتج غير صالح.', 400);
    }
    pid = String(body.id);
  } else {
    pid = 'PROD-' + crypto.randomUUID();
  }

  let finalCategoryId = null;
  if (body.category_id === 'NEW_CHAIN') {
    let chainNames;
    try {
      chainNames = JSON.parse(body.category_chain_names || '[]');
    } catch (e) {
      throw new HttpError('صيغة سلسلة الفئات (category_chain_names) غير صالحة.', 400);
    }
    finalCategoryId = await resolveCategoryChain(env, user.user_id, chainNames, body.category_anchor_id || 0);
  } else if (body.category_id) {
    finalCategoryId = parseInt(body.category_id) || null;
  }

  let imageUrl = body.existing_image || null;
  if (uploadedImageFile) {
    imageUrl = await uploadProductImage(env, user.username, pid, uploadedImageFile);
  }

  // ⭐ إصلاح أمني (ثغرة IDOR/Broken Access Control): كانت جملة الـ UPSERT
  // تحلّ التعارض بالاعتماد فقط على "id" بدون أي تحقق من ملكية الصف
  // الموجود مسبقاً. لو أرسل تاجر A معرّف منتج يخصّ تاجر B فعلياً (معرّفات
  // المنتجات ليست سرّية - تظهر بواجهة المتجر العامة وبالسلة)، كانت جملة
  // ON CONFLICT تُنفّذ DO UPDATE على صف B مباشرة (تغيّر اسمه/سعره/صورته/
  // توفره) رغم أن merchant_id لصف B يبقى كما هو (لأنه غير موجود أصلاً
  // بقائمة SET). الحل: نضيف شرط WHERE على نفس جملة DO UPDATE يقصر التحديث
  // فقط على الحالة التي يتطابق فيها merchant_id للصف الموجود مسبقاً مع
  // merchant_id الذي نحاول الإدراج به (أي التاجر الحالي نفسه) - فتصير
  // محاولة "استيلاء" على منتج تاجر آخر بلا أي تأثير على الإطلاق (0 صفوف
  // متأثرة) بدل تنفيذها بصمت.
  // ⭐ إصلاح: parseFloat(x) || 0 يسمح بمرور قيم سالبة (مثلاً "-100") لأن أي
  // رقم غير صفري "truthy" بجافاسكربت - فقط الصفر/NaN كانا يُستبدلان بـ 0.
  // سعر أو كمية سالبة تكسر حسابات السلة/المخزون لاحقاً (verifyCartLive،
  // خصم المخزون). نقيّد كل قيمة رقمية بحدها الأدنى المنطقي صراحة.
  const safePrice = Math.max(0, parseFloat(body.price) || 0);
  const safeCostPrice = Math.max(0, parseFloat(body.cost_price) || 0);
  const safeDiscount = Math.min(100, Math.max(0, parseFloat(body.discount) || 0));
  const safeQuantity = Math.max(0, parseInt(body.quantity, 10) || 0);

  const result = await env.DB.prepare(
    `INSERT INTO products (id, merchant_id, name, description, price, cost_price, discount, image, quantity, quantity_type, currency, category_id, options, is_available, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
     name=excluded.name, description=excluded.description, price=excluded.price, cost_price=excluded.cost_price,
     discount=excluded.discount, image=excluded.image, quantity=excluded.quantity, quantity_type=excluded.quantity_type,
     currency=excluded.currency, category_id=excluded.category_id, options=excluded.options,
     is_available=excluded.is_available, updated_at=excluded.updated_at
     WHERE products.merchant_id = excluded.merchant_id`
  )
    .bind(
      pid,
      user.user_id,
      body.name,
      body.mainDescription || body.description || '',
      safePrice,
      safeCostPrice,
      safeDiscount,
      imageUrl,
      safeQuantity,
      body.quantity_type || 'tracked',
      body.currency || 'YER',
      finalCategoryId,
      body.sizes || JSON.stringify(body.options || []),
      body.isAvailable === '0' ? 0 : 1,
      Date.now()
    )
    .run();

  if (!result.meta || result.meta.changes === 0) {
    throw new HttpError('لا يمكنك تعديل منتج لا يخصك.', 403);
  }

  // ⭐ تحسين أداء/موارد: كانت SELECT * تجلب كل الأعمدة (بما فيها cost_price
  // الحساس وmerchant_id/updated_at غير المستخدمين هنا) لكل منتج، رغم أن
  // syncCatalogToStorefront (راجع catalogSyncService.js) يقرأ فقط 13 عمود
  // محدد. لا يقلل هذا "rows_read" المحسوبة بفوترة D1 (نفس عدد الصفوف)، لكنه
  // يقلل حجم البيانات المنقولة من D1 وحجم JSON الذي يعالجه الـ Worker لكل
  // صف - أهم شيء بخطة مجانية سقفها 10ms وقت معالج لكامل الطلب.
  const allProducts = await env.DB.prepare(
    `SELECT id, name, description, price, discount, image, category_id, options, features,
            quantity, quantity_type, is_available, currency
     FROM products WHERE merchant_id = ? AND is_available = 1`
  )
    .bind(user.user_id)
    .all();
  ctx.waitUntil(syncCatalogToStorefront(env, user.username, user.user_id, allProducts.results));

  // ⭐ تحديث الـ Durable Object (In-Memory Cache) وبث التحديث لحظياً للداشبورد
  try {
    const savedProduct = await env.DB.prepare(
      `SELECT * FROM products WHERE id = ? AND merchant_id = ?`
    ).bind(pid, user.user_id).first();
    
    if (savedProduct && env.MERCHANT_SESSION) {
      const doId = env.MERCHANT_SESSION.idFromName(`merchant_${user.user_id}`);
      const doStub = env.MERCHANT_SESSION.get(doId);
      
      // لا نستخدم await لتجنب تأخير الرد على العميل
      ctx.waitUntil(
        doStub.fetch('http://internal/sync-product', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ product: savedProduct })
        })
      );
    }
  } catch (err) {
    console.error('Failed to sync product to DO:', err);
  }

  return {
    message: 'تم حفظ المنتج بنجاح (وجاري تحديث المتجر للزبائن)',
    product_id: pid,
    image: imageUrl,
  };
}

export async function listProducts({ env, user }) {
  const myProducts = await env.DB.prepare(
    `SELECT * FROM products WHERE merchant_id = ? ORDER BY updated_at DESC`
  )
    .bind(user.user_id)
    .all();

  const data = myProducts.results.map((p) => {
    try {
      p.options = JSON.parse(p.options || '[]');
    } catch (e) {
      p.options = [];
    }
    return p;
  });
  return { data };
}

export async function deleteProduct({ env, ctx, user, body }) {
  const pid = body.id;

  // ⭐ إصلاح: كان الفحص (هل ضمن طلب نشط؟) والحذف عبارة عن خطوتين منفصلتين
  // (SELECT ثم DELETE)، وبينهما نافذة زمنية يقدر فيها زبون يُنشئ طلب جديد
  // لنفس المنتج (create_order) بعد ما ينجح الفحص وقبل ما يُنفَّذ الحذف
  // فعلياً — فيُحذف منتج أصبح للتو ضمن طلب نشط، رغم "نجاح" الفحص الأمني.
  // الحل: ندمج الفحص داخل جملة DELETE نفسها عبر NOT EXISTS، فتصير عملية
  // واحدة ذرّية على مستوى قاعدة البيانات ولا توجد نافذة تصادم إطلاقاً.
  //
  // ⭐ إصلاح ثانٍ (2026-07-26): كان الفحص يستخدم
  // `ticket_data LIKE '%"product_id":"<pid>"%'` - لكن D1 يفرض حد صارم:
  // أقصى طول لنمط LIKE/GLOB هو 50 بايت فقط (راجع حدود D1 الرسمية). بما
  // أن pid وحده ("PROD-" + UUID) طوله ~41 حرف، النمط الكامل يتجاوز الـ 50
  // بايت بسهولة فيطلع خطأ "LIKE or GLOB pattern too complex" عند كل
  // عملية حذف. الحل: نستبدل LIKE بمطابقة دقيقة عبر دوال JSON (json_each/
  // json_extract) المتوفرة في D1 - ما فيها هذا الحد، وهي أدق لأنها تطابق
  // قيمة product_id كاملة داخل مصفوفة items وليس نص فرعي عشوائي.
  const statusList = ACTIVE_ORDER_STATUSES.map((s) => `'${s}'`).join(',');
  const deleteResult = await env.DB.prepare(
    `DELETE FROM products
     WHERE id = ? AND merchant_id = ?
     AND NOT EXISTS (
       SELECT 1 FROM live_tickets, json_each(json_extract(live_tickets.ticket_data, '$.items')) AS item
       WHERE live_tickets.merchant_id = ?
       AND live_tickets.status IN (${statusList})
       AND json_extract(item.value, '$.product_id') = ?
     )`
  )
    .bind(pid, user.user_id, user.user_id, pid)
    .run();

  const deleted = (deleteResult.meta && deleteResult.meta.changes) || 0;

  if (deleted === 0) {
    // لم يُحذف شيء: إما أن المنتج غير موجود أصلاً لهذا التاجر، أو أنه
    // ضمن طلب نشط حالياً (بما فيه طلب استجد بعد الفحص الأول). نميّز
    // بينهما فقط لأجل رسالة واضحة للتاجر - هذا الفحص هنا للعرض فقط
    // ولا يؤثر على ذرّية الحذف نفسه أعلاه.
    const stillExists = await env.DB.prepare(`SELECT id FROM products WHERE id = ? AND merchant_id = ?`)
      .bind(pid, user.user_id)
      .first();

    if (stillExists) {
      throw new HttpError(
        'لا يمكنك حذف هذا المنتج حالياً لأنه ضمن طلب نشط لزبون. أنهِ الطلب أو ألغِه أولاً.',
        409
      );
    }
    throw new HttpError('المنتج غير موجود.', 404);
  }

  const remainingProducts = await env.DB.prepare(
    `SELECT id, name, description, price, discount, image, category_id, options, features,
            quantity, quantity_type, is_available, currency
     FROM products WHERE merchant_id = ? AND is_available = 1`
  )
    .bind(user.user_id)
    .all();
  ctx.waitUntil(syncCatalogToStorefront(env, user.username, user.user_id, remainingProducts.results));

  return { message: 'تم حذف المنتج نهائياً بنجاح' };
}

export async function toggleAvailability({ env, ctx, user, body }) {
  const pid = body.id;
  const reqStatus = parseInt(body.isAvailable) ? 1 : 0;

  await env.DB.prepare(
    `UPDATE products SET is_available = ?, updated_at = ? WHERE id = ? AND merchant_id = ?`
  )
    .bind(reqStatus, Date.now(), pid, user.user_id)
    .run();

  const visibleProducts = await env.DB.prepare(
    `SELECT id, name, description, price, discount, image, category_id, options, features,
            quantity, quantity_type, is_available, currency
     FROM products WHERE merchant_id = ? AND is_available = 1`
  )
    .bind(user.user_id)
    .all();
  ctx.waitUntil(syncCatalogToStorefront(env, user.username, user.user_id, visibleProducts.results));

  return { message: 'تم تحديث حالة عرض المنتج (إخفاء/إظهار) بنجاح' };
}
