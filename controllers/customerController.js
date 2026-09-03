import { HttpError } from '../security/rbac.js';
import { syncCatalogToStorefront } from '../services/catalog/catalogSyncService.js';
import { syncOrderTracking } from '../services/realtime/realtimeSyncService.js';
import { sendFcmNotification } from '../services/notifications/providers/fcmProvider.js';
import { extractCoordsFromUrl, calculateDistance, calculateDeliveryFee } from '../services/geo/geoUtils.js';
import { syncNewOrderToLegacyApi } from '../services/legacySync/tidbSyncService.js';
import { assertOrderRateLimitOk } from '../services/orders/orderRateLimiter.js';
import {
  ALLOWED_DELIVERY_CENTER_LAT,
  ALLOWED_DELIVERY_CENTER_LNG,
  MAX_ALLOWED_DELIVERY_RADIUS_KM,
  MIN_CART_VALUE,
  MAX_QTY_PER_ITEM,
  MAX_TOTAL_QTY,
} from '../config/constants.js';

// ========================================================
// 🛒 تحكم العميل: السلة، الجلسة، وإنشاء الطلبات
// ⭐ تم توسيعه بتاريخ 2026-07-21 لينقل منطق api.php (check_customer_session,
// verify_cart_live, create_order, get_user_orders) إلى الـ Worker.
// كل دالة موثّقة بالأصل المقابل لها في api.php ليسهل مراجعتها ومقارنتها.
// ========================================================

export async function addToCart({ env, user, body }) {
  // ⭐ إصلاح: quantity كانت تُحفظ كما وصلت من العميل بدون أي تحقق - قيمة
  // سالبة أو صفرية أو نصية غير رقمية كانت تُكتب مباشرة بجدول user_cart (قد
  // تُعرض لاحقاً بواجهة السلة بشكل خاطئ/مربك). create_order لا يثق بهذا
  // الجدول أصلاً (يعيد التحقق من الكمية بالكامل من body.local_cart)، لكن
  // عدم التحقق عند الكتابة يبقى خطأ بحد ذاته. نفس حد MAX_QTY_PER_ITEM
  // المستخدم لاحقاً بإنشاء الطلب، حفاظاً على قيمة واحدة متسقة.
  const qty = parseInt(body.quantity, 10);
  const safeQty = Number.isFinite(qty) && qty > 0 ? Math.min(qty, MAX_QTY_PER_ITEM) : 1;

  await env.DB.prepare(
    `INSERT INTO user_cart (customer_id, product_id, merchant_id, quantity, size_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(customer_id, product_id, size_id)
     DO UPDATE SET quantity = quantity + excluded.quantity`
  )
    .bind(user.user_id, body.product_id, body.merchant_id, safeQty, body.size_id || null)
    .run();

  return { message: 'تمت الإضافة للسلة' };
}

export async function getCart({ env, user }) {
  const cart = await env.DB.prepare(`SELECT * FROM user_cart WHERE customer_id = ?`)
    .bind(user.user_id)
    .all();
  return { data: cart.results };
}

// ========================================================
// ⭐ إضافة: check_customer_session
// مطابقة لـ api.php case 'check_customer_session' (جدول customers الجديد بـ D1)
// ملاحظة: في api.php هذا الأكشن "معفى" (public) من التحقق من التوكن ويرجع
// {loggedIn:false} بهدوء بدل خطأ 401 لو ما فيه توكن. هنا الأكشن يتطلب دور
// customer (نفس بقية أكشنات العميل)، فلو التوكن غايب/غير صالح يرجع خطأ 401
// من index.js مباشرة بدل {loggedIn:false} — والنتيجة النهائية بالواجهة
// الأمامية نفسها (تسجيل خروج تلقائي)، لأن app.js يتعامل مع الحالتين بنفس الشكل.
// ========================================================
export async function checkCustomerSession({ env, user }) {
  const row = await env.DB.prepare(
    `SELECT id, full_name, phone, address, is_active FROM customers WHERE id = ?`
  )
    .bind(user.user_id)
    .first();

  if (!row || (row.is_active !== null && row.is_active !== undefined && Number(row.is_active) === 0)) {
    return { loggedIn: false };
  }

  const needsProfileUpdate = String(row.full_name || '').startsWith('عميل');
  return { loggedIn: true, customer: row, needs_profile_update: needsProfileUpdate };
}

// ========================================================
// ⭐ إضافة: verify_cart_live
// مطابقة لـ api.php case 'verify_cart_live'، لكن تقرأ من جدول products بـ D1
// فقط (بدون الدعم العكسي لجدول merchant_listings القديم، لأنه غير موجود بـ D1
// أصلاً — منتجات الـ D1 كلها بالنظام الجديد فقط).
// ========================================================
export async function verifyCartLive({ env, body }) {
  const cartItems = body.items || [];
  if (!cartItems.length) return { can_proceed: true };

  const changes = [];
  const newCart = [];
  let canProceed = true;

  for (const item of cartItems) {
    const productId = item.product_id || item.listing_id;

    const dbItem = await env.DB.prepare(
      `SELECT price, quantity, quantity_type, is_available, discount, options FROM products WHERE id = ?`
    )
      .bind(productId)
      .first();

    if (!dbItem || Number(dbItem.is_available) === 0) {
      changes.push(`المنتج '${item.name}' نفد أو تم إخفاؤه. تم حذفه من سلتك.`);
      canProceed = false;
      continue;
    }

    let availableQty = parseInt(dbItem.quantity) || 0;
    let qtyType = dbItem.quantity_type;
    let basePrice = parseFloat(dbItem.price) || 0;

    const sizeId = item.size_id || null;
    if (sizeId && dbItem.options) {
      let options = [];
      try {
        options = JSON.parse(dbItem.options) || [];
      } catch (e) {
        options = [];
      }
      const opt = options.find((o) => o && o.id === sizeId);
      if (!opt) {
        changes.push(`المقاس أو الخيار المختار لـ '${item.name}' لم يعد متوفراً.`);
        canProceed = false;
        continue;
      }
      if (opt.custom_price !== undefined && opt.custom_price !== null && opt.custom_price !== '') {
        basePrice = parseFloat(opt.custom_price);
      }
      if ((opt.quantity_type || 'tracked') === 'tracked') {
        availableQty = parseInt(opt.quantity) || 0;
        qtyType = 'tracked';
      } else {
        qtyType = 'unlimited';
      }
    }

    const realPrice = basePrice * (1 - parseFloat(dbItem.discount || 0) / 100);
    if (Math.abs(realPrice - parseFloat(item.price)) > 1) {
      changes.push(`تغير سعر '${item.name}' من ${item.price} إلى ${realPrice}.`);
      item.price = realPrice;
      canProceed = false;
    }

    if (qtyType === 'tracked' && availableQty < item.qty) {
      changes.push(`الكمية المتاحة من '${item.name}' هي ${availableQty} فقط.`);
      item.qty = availableQty;
      if (item.qty <= 0) continue;
      canProceed = false;
    }

    newCart.push(item);
  }

  return { can_proceed: canProceed, changes, new_cart: newCart };
}

// ========================================================
// ⭐ إعادة بناء كاملة: create_order
// مطابقة لمنطق api.php case 'create_order' خطوة بخطوة (نفس الرسائل ونفس
// الأرقام)، مع فروقات مقصودة موثّقة أدناه بعلامة ⚠️.
//
// ⚠️ فرق جوهري عن api.php: PDO/TiDB يدعم معاملة حقيقية (BEGIN/COMMIT) مع
// قفل صفوف (SELECT ... FOR UPDATE) عبر كل التجار دفعة واحدة. D1 (SQLite على
// Cloudflare) ما يدعم هذا النمط من القفل التفاعلي. لذلك هنا كل عملية تُنفَّذ
// بأوامر منفصلة متتالية (sequential)، وبيانات المخزون تُقرأ وتُحدَّث لكل تاجر
// على حدة مباشرة قبل الاستخدام لتقليل فرصة "race condition"، لكن هذا ليس
// ضماناً معاملاتياً كاملاً بنفس قوة PDO transaction + FOR UPDATE. تحت ضغط
// طلبات متزامنة جداً على نفس المنتج، احتمال نادر لتضارب بسيط يبقى موجوداً.
// ========================================================
export async function createOrder({ env, ctx, user, body }) {
  const customerId = user.user_id;

  // ⭐ إصلاح: لا يوجد حد لمعدل استدعاء create_order لكل عميل (راجع تعليق
  // orderRateLimiter.js). نتحقق أولاً، قبل أي عمل آخر (حتى قبل idempotency)
  // حتى يكون الرفض رخيصاً وسريعاً بدون أي كتابة إضافية على D1.
  await assertOrderRateLimitOk(env, customerId);

  // 1) منع التكرار (Idempotency)
  const idempotencyKey = (body.idempotency_key || '').toString().trim();
  if (idempotencyKey) {
    const existing = await env.DB.prepare(
      `SELECT response_data FROM idempotency_keys WHERE key_token = ?`
    )
      .bind(idempotencyKey)
      .first();

    if (existing) {
      if (existing.response_data === 'processing') {
        return { message: 'طلبك قيد المعالجة حالياً، يرجى الانتظار...' };
      }
      try {
        return JSON.parse(existing.response_data);
      } catch (e) {
        return { message: 'تم استلام طلبك بنجاح (تأكيد مكرر).' };
      }
    }
    try {
      await env.DB.prepare(
        `INSERT INTO idempotency_keys (key_token, response_data) VALUES (?, 'processing')`
      )
        .bind(idempotencyKey)
        .run();
    } catch (e) {
      // مفتاح مكرر أُدرج للتو من طلب متزامن آخر
      return { message: 'تم استلام طلبك بنجاح (تم تجاهل الطلب المكرر).' };
    }
  }

  try {
    const result = await processOrderCreation({ env, ctx, user, body, customerId });

    if (idempotencyKey) {
      await env.DB.prepare(`UPDATE idempotency_keys SET response_data = ? WHERE key_token = ?`)
        .bind(JSON.stringify(result), idempotencyKey)
        .run();
    }

    return result;
  } catch (err) {
    // فشل الطلب: نحذف مفتاح idempotency حتى يقدر العميل يعيد المحاولة
    if (idempotencyKey) {
      await env.DB.prepare(`DELETE FROM idempotency_keys WHERE key_token = ? AND response_data = 'processing'`)
        .bind(idempotencyKey)
        .run()
        .catch(() => {});
    }
    throw err;
  }
}

async function processOrderCreation({ env, ctx, user, body, customerId }) {
  // 2) بيانات العميل والموقع الجغرافي
  const cData = body.customer || {};
  const rawAddress = cData.address || '';
  const customerGpsLink = (cData.gps || '').toString().trim();

  let detailsPart = '';
  if (rawAddress.includes('| التفاصيل:')) {
    detailsPart = (rawAddress.split('| التفاصيل:')[1] || '').trim();
  } else {
    detailsPart = rawAddress.replace(`رابط الموقع: ${customerGpsLink}`, '').trim();
  }
  if (detailsPart.length > 255) detailsPart = detailsPart.slice(0, 252) + '...';

  const custDb = await env.DB.prepare(`SELECT full_name, address, phone FROM customers WHERE id = ?`)
    .bind(customerId)
    .first();

  const finalName = (cData.name || '').toString().trim() || (custDb && custDb.full_name) || '';

  let finalAddress;
  if (customerGpsLink) {
    finalAddress = `رابط الموقع: ${customerGpsLink}`;
    if (detailsPart) finalAddress += ` | التفاصيل: ${detailsPart}`;
  } else if (custDb && custDb.address) {
    // ⭐ إصلاح (2026-08-01): الرجوع للعنوان المحفوظ سابقاً يعتمد فقط على
    // عدم وجود رابط GPS بالطلب الحالي، بدون أي علاقة بوجود detailsPart.
    // قبل التعديل: لو detailsPart غير فاضي لكن customerGpsLink فاضي (فشل
    // استخلاص الرابط من الواجهة)، كان يتجاهل العنوان المحفوظ ويرفض الطلب
    // برسالة "يرجى تحديد الموقع" حتى لو المستخدم عنده عنوان صحيح محفوظ.
    finalAddress = custDb.address;
  } else {
    finalAddress = '';
  }

  if (!finalName || finalName.startsWith('عميل')) {
    throw new HttpError('يجب إدخال اسمك الحقيقي في حسابك أولاً لإتمام الطلب.', 400);
  }
  if (!finalAddress || !finalAddress.includes('http')) {
    throw new HttpError('الرجاء تحديد عنوان التوصيل الدقيق على الخريطة وكتابة وصف للموقع 📍', 400);
  }

  const customerCoords = extractCoordsFromUrl(customerGpsLink);
  if (!customerCoords) {
    throw new HttpError('الرجاء تحديد موقع دقيق على الخريطة لتتمكن من إتمام الطلب.', 400);
  }

  const distFromCenter = calculateDistance(
    ALLOWED_DELIVERY_CENTER_LAT,
    ALLOWED_DELIVERY_CENTER_LNG,
    customerCoords.lat,
    customerCoords.lng
  );
  if (distFromCenter > MAX_ALLOWED_DELIVERY_RADIUS_KM) {
    throw new HttpError('عذراً، موقعك يقع خارج نطاق التغطية المسموح لخدمة التوصيل.', 400);
  }

  // 3) التحقق المبدئي من السلة + التجميع حسب التاجر
  const cartItems = Array.isArray(body.local_cart) ? body.local_cart : [];
  if (!cartItems.length) {
    throw new HttpError('سلة المشتريات فارغة أو تم إرسال الطلب بالفعل!', 400);
  }

  let totalRequestedQty = 0;
  const groupedByMerchant = {};

  for (const cItem of cartItems) {
    const qty = parseInt(cItem.qty) || 0;
    if (qty <= 0) throw new HttpError('الكمية المطلوبة لأحد المنتجات غير صالحة.', 400);
    if (qty > MAX_QTY_PER_ITEM) {
      throw new HttpError(`عذراً، لا يمكنك طلب أكثر من ${MAX_QTY_PER_ITEM} وحدة من نفس المنتج.`, 400);
    }
    totalRequestedQty += qty;

    let mId = cItem.merchant_id || cItem.user_id || cItem.merchant_username || null;
    if (mId === 'null' || mId === 'undefined' || mId === '') mId = null;

    if (!mId) {
      const productId = cItem.product_id || cItem.listing_id || cItem.id || null;
      if (productId) {
        const row = await env.DB.prepare(`SELECT merchant_id FROM products WHERE id = ?`)
          .bind(productId)
          .first();
        if (row) mId = row.merchant_id;
      }
    }

    if (!mId) {
      throw new HttpError(`عذراً، المنتج '${cItem.name || 'غير معروف'}' لم يعد متاحاً. يرجى حذفه من السلة.`, 400);
    }

    cItem.merchant_id = mId;
    if (!groupedByMerchant[mId]) groupedByMerchant[mId] = [];
    groupedByMerchant[mId].push(cItem);
  }

  if (totalRequestedQty > MAX_TOTAL_QTY) {
    throw new HttpError('تجاوزت الحد الأقصى لإجمالي المنتجات المسموح بها في الطلب الواحد.', 400);
  }

  // 4) جلب بيانات التجار + حساب رسوم التوصيل
  const merchantDetails = {};
  const merchantLocations = {};
  const rawMerchantIds = Object.keys(groupedByMerchant);

  for (const rawMId of rawMerchantIds) {
    const mInfo = await env.DB.prepare(
      `SELECT id, username, store_name, settings FROM users WHERE id = ? OR username = ?`
    )
      .bind(rawMId, rawMId)
      .first();

    if (!mInfo) {
      throw new HttpError(`المتجر غير موجود أو غير متاح حالياً (المعرف: ${rawMId}). يرجى إزالة منتجاته من السلة.`, 400);
    }

    const actualMId = mInfo.id;
    if (String(rawMId) !== String(actualMId)) {
      groupedByMerchant[actualMId] = groupedByMerchant[rawMId];
      delete groupedByMerchant[rawMId];
    }

    merchantDetails[actualMId] = mInfo;
    let mSettings = {};
    try {
      mSettings = mInfo.settings ? JSON.parse(mInfo.settings) : {};
    } catch (e) {
      mSettings = {};
    }
    const mCoords = extractCoordsFromUrl(mSettings.location);
    if (mCoords) merchantLocations[actualMId] = mCoords;
  }

  const merchantCount = Object.keys(groupedByMerchant).length;
  let totalDeliveryFee;
  if (customerCoords && Object.keys(merchantLocations).length > 0) {
    let routeDistance = 0;
    const locations = Object.values(merchantLocations);
    for (let i = 0; i < locations.length - 1; i++) {
      routeDistance += calculateDistance(locations[i].lat, locations[i].lng, locations[i + 1].lat, locations[i + 1].lng);
    }
    const lastMerchant = locations[locations.length - 1];
    routeDistance += calculateDistance(lastMerchant.lat, lastMerchant.lng, customerCoords.lat, customerCoords.lng);

    const calculatedBaseFee = calculateDeliveryFee(routeDistance);
    totalDeliveryFee = calculatedBaseFee + (merchantCount - 1) * 300;
  } else {
    totalDeliveryFee = 1500 + (merchantCount - 1) * 500;
  }

  const feePerOrder = merchantCount > 0 ? Math.ceil(totalDeliveryFee / merchantCount / 50) * 50 : totalDeliveryFee;

  // 5) التحقق الصارم من الأسعار والمخزون (من D1 مباشرة - نفس دور TiDB بـ api.php)
  const preparedSubOrders = {};
  let overallCartTotal = 0;

  for (const merchantId of Object.keys(groupedByMerchant)) {
    const items = groupedByMerchant[merchantId];
    const mInfo = merchantDetails[merchantId];
    let mSettings = {};
    try {
      mSettings = mInfo.settings ? JSON.parse(mInfo.settings) : {};
    } catch (e) {
      mSettings = {};
    }

    const productIds = items.map((i) => i.product_id || i.listing_id || i.id).filter(Boolean);
    if (!productIds.length) continue;

    const placeholders = productIds.map(() => '?').join(',');
    const productsRes = await env.DB.prepare(
      `SELECT * FROM products WHERE merchant_id = ? AND id IN (${placeholders})`
    )
      .bind(merchantId, ...productIds)
      .all();

    const productsById = {};
    for (const row of productsRes.results || []) {
      try {
        row.options = JSON.parse(row.options || '[]');
      } catch (e) {
        row.options = [];
      }
      productsById[row.id] = row;
    }

    // ⭐ كل منتج له عملته الخاصة (currency على مستوى المنتج نفسه)، لذلك نجمّع
    // عناصر هذا التاجر حسب العملة بدل جمعها كلها في إجمالي واحد. هذا يمنع
    // خلط أسعار منتجات بعملات مختلفة (مثلاً YER و USD بنفس متجر التاجر) داخل
    // نفس الإجمالي، وكل مجموعة عملة تصبح "طلب فرعي" (تذكرة) مستقلة بحسابها
    // الخاص لاحقاً.
    const itemsByCurrency = {};
    let merchantItemCount = 0; // إجمالي عدد القطع لكل عملات التاجر معاً (لعتبة الشحن المجاني بعدد القطع)

    for (const item of items) {
      const productId = item.product_id || item.listing_id || item.id;
      const product = productsById[productId];

      if (!product) {
        throw new HttpError(`المنتج '${item.name}' نفد أو تم حذفه من متجر ${mInfo.store_name || ''}.`, 400);
      }
      if (Number(product.is_available) === 0) {
        throw new HttpError(`المنتج '${product.name}' غير متاح حالياً للطلب.`, 400);
      }

      const currency = product.currency || 'YER';
      const qty = parseInt(item.qty) || 0;
      merchantItemCount += qty;

      let availableQty = parseInt(product.quantity) || 0;
      let qtyType = product.quantity_type || 'tracked';
      const itemOptionId = item.size_id || null;
      let optionInfo = null;
      let itemImage = product.image;
      let basePrice = parseFloat(product.price) || 0;

      if (itemOptionId && Array.isArray(product.options) && product.options.length) {
        const opt = product.options.find((o) => o && o.id === itemOptionId);
        if (!opt) {
          throw new HttpError(`الخيار المختار للمنتج '${product.name}' لم يعد متوفراً.`, 400);
        }
        optionInfo = opt.name || null;
        if (opt.custom_price !== undefined && opt.custom_price !== null && opt.custom_price !== '') {
          basePrice = parseFloat(opt.custom_price);
        }
        if (opt.quantity_type === 'tracked') {
          availableQty = parseInt(opt.quantity) || 0;
          qtyType = 'tracked';
        } else {
          qtyType = 'unlimited';
        }
        if (opt.image) itemImage = opt.image;
      }

      if (qtyType === 'tracked' && availableQty < qty) {
        throw new HttpError(`عذراً، الكمية المطلوبة من '${product.name}' غير كافية بالمخزون (المتاح: ${availableQty}).`, 400);
      }

      const finalSecurePrice = basePrice * (1 - parseFloat(product.discount || 0) / 100);

      if (!itemsByCurrency[currency]) {
        itemsByCurrency[currency] = { items: [], totalProductsPrice: 0 };
      }
      itemsByCurrency[currency].totalProductsPrice += finalSecurePrice * qty;
      itemsByCurrency[currency].items.push({
        product_id: product.id,
        listing_id: product.id,
        size_id: itemOptionId,
        product_name: product.name,
        size_info: optionInfo,
        quantity: qty,
        price: finalSecurePrice,
        cost_price: product.cost_price || 0,
        image: itemImage,
        qty_type: qtyType,
        current_db_qty: availableQty,
        options_raw: product.options || [],
      });
    }

    // الحد الأدنى للسلة (MIN_CART_VALUE) وعتبة الشحن المجاني بالقيمة محسوبة
    // بعملة YER (عملة رسوم التوصيل الأساسية)، فنستخدم فقط إجمالي منتجات YER
    // لهذا التاجر لهذا الغرض تحديداً — لا نخلطها بعملات أخرى.
    const yerSubtotal = itemsByCurrency['YER']?.totalProductsPrice || 0;

    // ⭐ إصلاح (2026-07-26): كان overallCartTotal يجمع فقط yerSubtotal،
    // فيتجاهل تماماً أي عملة ثانية (مثلاً USD). النتيجة: طلب كله بعملة
    // غير اليمني يفضل overallCartTotal = 0 عنده ويُرفض دايماً بغض النظر
    // عن قيمته الفعلية، وطلب مختلط (يمني + دولار) يُحسب فيه جزء اليمني
    // فقط فيُرفض رغم أن القيمة الكلية أكبر من الحد الأدنى. نجمع هنا كل
    // مجموعات العملات (وليس فقط YER) لغرض فحص الحد الأدنى تحديداً - أما
    // yerSubtotal نفسه يبقى بدون أي تغيير لحساب رسوم التوصيل/الشحن
    // المجاني أدناه، لأنها مرتبطة بعملة اليمني تحديداً وصحيحة كما هي.
    const merchantAllCurrenciesTotal = Object.values(itemsByCurrency).reduce(
      (sum, group) => sum + group.totalProductsPrice,
      0
    );
    overallCartTotal += merchantAllCurrenciesTotal;

    let actualDeliveryFee = feePerOrder;
    if (mSettings.free_shipping_enabled === true || mSettings.free_shipping_enabled === 'true') {
      const fType = mSettings.free_shipping_type || 'always';
      const fThresh = parseFloat(mSettings.free_shipping_threshold || 0);
      if (fType === 'always') actualDeliveryFee = 0;
      else if (fType === 'order_value' && yerSubtotal >= fThresh) actualDeliveryFee = 0;
      else if (fType === 'item_count' && merchantItemCount >= fThresh) actualDeliveryFee = 0;
    }

    // كل عملة تصبح طلب فرعي (تذكرة) مستقل بحسابه الخاص. رسوم التوصيل (وهي
    // بعملة YER دائماً) تُضاف فقط لمجموعة عملة YER إن وُجدت، وليس لكل عملة
    // على حدة، حتى لا تُحتسب أكثر من مرة على نفس الطلب.
    for (const [currency, group] of Object.entries(itemsByCurrency)) {
      const deliveryFeeForGroup = currency === 'YER' ? actualDeliveryFee : 0;
      const grandTotal = currency === 'YER' ? group.totalProductsPrice + deliveryFeeForGroup : group.totalProductsPrice;

      preparedSubOrders[`${merchantId}::${currency}`] = {
        merchantId,
        merchantInfo: mInfo,
        financials: {
          products_total: group.totalProductsPrice,
          delivery_fee: deliveryFeeForGroup,
          grand_total: grandTotal,
          currency,
          delivery_currency: 'YER',
        },
        items: group.items,
      };
    }
  }

  if (overallCartTotal < MIN_CART_VALUE) {
    throw new HttpError(
      `عذراً، الحد الأدنى لإتمام الطلب هو ${MIN_CART_VALUE}. قيمة منتجاتك الحالية: ${Math.round(overallCartTotal)}.`,
      400
    );
  }

  const newOrderGroupId = 'GRP-' + crypto.randomUUID();
  let isOrderMerged = false;
  const createdTickets = [];

  // 6) إنشاء/دمج التذاكر بـ live_tickets (D1)
  await env.DB.prepare(`UPDATE customers SET full_name = ?, address = ? WHERE id = ?`)
    .bind(finalName, finalAddress, customerId)
    .run();

  for (const subKey of Object.keys(preparedSubOrders)) {
    const subOrder = preparedSubOrders[subKey];
    const merchantId = subOrder.merchantId;
    const mInfo = subOrder.merchantInfo;
    const mUsername = mInfo.username;
    const subCurrency = subOrder.financials.currency;

    // ⭐ يجب أن نبحث عن تذكرة سابقة بنفس عملة هذا الطلب الفرعي تحديداً، وإلا
    // قد يُدمَج طلب بعملة USD مع تذكرة سابقة بعملة YER لنفس التاجر فيختلط
    // الحساب. لذلك نجلب كل التذاكر المعلّقة لهذا التاجر ونفلتر بالعملة.
    const candidateTickets = await env.DB.prepare(
      `SELECT ticket_id, order_group_id, ticket_data, status, delivery_code FROM live_tickets
       WHERE customer_id = ? AND merchant_id = ?
       AND status IN ('pending_merchant_approval', 'pending_delivery_acceptance')
       AND delivery_agent_id IS NULL`
    )
      .bind(customerId, merchantId)
      .all();

    let existingTicket = null;
    for (const cand of candidateTickets.results || []) {
      let candData = {};
      try {
        candData = JSON.parse(cand.ticket_data) || {};
      } catch (e) {
        candData = {};
      }
      if ((candData.financials?.currency || 'YER') === subCurrency) {
        existingTicket = cand;
        break;
      }
    }

    if (existingTicket) {
      let existingData = {};
      try {
        existingData = JSON.parse(existingTicket.ticket_data) || {};
      } catch (e) {
        existingData = {};
      }
      const oldItems = existingData.items || [];

      for (const newItem of subOrder.items) {
        const found = oldItems.find(
          (o) => String(o.product_id) === String(newItem.product_id) && String(o.size_id || '') === String(newItem.size_id || '')
        );
        if (found) {
          found.quantity += newItem.quantity;
        } else {
          const cleanItem = { ...newItem };
          delete cleanItem.qty_type;
          delete cleanItem.current_db_qty;
          delete cleanItem.options_raw;
          oldItems.push(cleanItem);
        }
      }

      existingData.items = oldItems;
      existingData.financials = existingData.financials || {};
      existingData.financials.products_total = (existingData.financials.products_total || 0) + subOrder.financials.products_total;
      if (subOrder.financials.currency === 'YER') {
        existingData.financials.grand_total = existingData.financials.products_total + (existingData.financials.delivery_fee || 0);
      } else {
        existingData.financials.grand_total = existingData.financials.products_total;
      }

      const ticketId = existingTicket.ticket_id;
      const updatedTicketDataStr = JSON.stringify(existingData);
      await env.DB.prepare(`UPDATE live_tickets SET ticket_data = ? WHERE ticket_id = ?`)
        .bind(updatedTicketDataStr, ticketId)
        .run();
      isOrderMerged = true;

      // ⭐ إصلاح: syncNewOrderToLegacyApi كانت معرّفة بالكامل بـ
      // tidbSyncService.js لكن غير مستدعاة من أي مكان بالمشروع، فكانت كل
      // الطلبات الجديدة/المدموجة تبقى غير مرئية لنظام api.php القديم
      // (وبالتالي لتطبيقي المندوب والزبون القديمين اللذين يقرآن من TiDB
      // مباشرة). best-effort بالخلفية، لا تُعطّل رد العميل.
      ctx.waitUntil(
        syncNewOrderToLegacyApi(env, {
          ticket_id: ticketId,
          order_group_id: existingTicket.order_group_id,
          merchant_id: merchantId,
          customer_id: customerId,
          status: existingTicket.status,
          delivery_code: existingTicket.delivery_code,
          ticket_data: updatedTicketDataStr,
        })
      );

      createdTickets.push({
        ticket_id: ticketId,
        merchant_id: merchantId,
        merchant_username: mUsername,
        status: existingTicket.status,
        original_items_to_deduct: subOrder.items,
      });
    } else {
      // ⭐ إصلاح أمني: Math.random() ليس مولّداً عشوائياً آمناً تشفيرياً
      // (قابل للتنبؤ نظرياً)، وكود التسليم هنا يُستخدم كتحقق أمني بسيط عند
      // استلام الطلب فعلياً. نستخدم crypto.getRandomValues المتاح أصلاً
      // بهذي البيئة (Web Crypto API) بدلاً منه.
      const deliveryCode = 1000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 9000);
      const ticketId = 'TCK-' + crypto.randomUUID();
      const finalStatus = 'pending_merchant_approval';

      const cleanItemsList = subOrder.items.map((it) => {
        const clean = { ...it };
        delete clean.qty_type;
        delete clean.current_db_qty;
        delete clean.options_raw;
        return clean;
      });

      const ticketPayload = {
        customer: {
          id: customerId,
          name: finalName,
          phone: (custDb && custDb.phone) || '',
          address_text: finalAddress,
          gps_link: customerGpsLink,
        },
        merchant: {
          id: merchantId,
          name: mInfo.store_name || 'المتجر',
        },
        financials: subOrder.financials,
        items: cleanItemsList,
        order_group_id: newOrderGroupId,
      };

      const ticketDataStr = JSON.stringify(ticketPayload);
      await env.DB.prepare(
        `INSERT INTO live_tickets (ticket_id, order_group_id, merchant_id, customer_id, status, delivery_code, ticket_data)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(ticketId, newOrderGroupId, merchantId, customerId, finalStatus, deliveryCode, ticketDataStr)
        .run();

      ctx.waitUntil(
        syncNewOrderToLegacyApi(env, {
          ticket_id: ticketId,
          order_group_id: newOrderGroupId,
          merchant_id: merchantId,
          customer_id: customerId,
          status: finalStatus,
          delivery_code: deliveryCode,
          ticket_data: ticketDataStr,
        })
      );

      createdTickets.push({
        ticket_id: ticketId,
        merchant_id: merchantId,
        merchant_username: mUsername,
        status: finalStatus,
        original_items_to_deduct: subOrder.items,
      });
    }
  }

  await env.DB.prepare(`DELETE FROM user_cart WHERE customer_id = ?`).bind(customerId).run();

  // 7) خصم المخزون من D1 + مزامنة الكاش والإشعارات (خلفية - لا تُعطّل الرد)
  for (const tick of createdTickets) {
    ctx.waitUntil(deductStockAndNotify(env, tick));
  }

  const successMsg = isOrderMerged
    ? 'تم دمج المنتجات الجديدة لطلبك السابق بنجاح! 🛍️'
    : 'تم استلام طلبك وبانتظار موافقة التاجر لتجهيزه!';

  return { message: successMsg };
}

// خصم المخزون + مزامنة كاش المتجر (GitHub) + إشارة Firebase + إشعار FCM للتاجر.
// نُفّذ بالخلفية عبر ctx.waitUntil حتى لا ينتظرها العميل (مطابقة لروح
// "Post-Processing" بـ api.php التي تُرسل الرد للعميل قبل هذه الخطوات).
async function deductStockAndNotify(env, tick) {
  try {
    // ⭐ نتتبع هل "انتهت الكمية" فعلياً لأي منتج ضمن هذا الطلب (وصلت لصفر)،
    // لأن الشراء بحد ذاته لا يجب أن يستدعي مزامنة GitHub في كل مرة — فقط
    // عندما يصبح المنتج (أو الخيار) غير متوفر فعلاً، حتى نقلل عدد الكوميتات
    // غير الضرورية على المستودع ونمسح الكاش فقط عند الحاجة الحقيقية.
    let stockDepleted = false;

    for (const item of tick.original_items_to_deduct) {
      if (item.qty_type !== 'tracked') continue;
      const pid = item.product_id;

      if (item.size_id) {
        const options = item.options_raw || [];
        let totalRemainingQty = 0;
        for (const opt of options) {
          if (opt && opt.id === item.size_id) {
            opt.quantity = Math.max(0, (parseInt(opt.quantity) || 0) - item.quantity);
          }
          totalRemainingQty += parseInt(opt && opt.quantity) || 0;
        }
        await env.DB.prepare(`UPDATE products SET quantity = ?, options = ?, updated_at = ? WHERE id = ? AND merchant_id = ?`)
          .bind(totalRemainingQty, JSON.stringify(options), Date.now(), pid, tick.merchant_id)
          .run();
        if (totalRemainingQty <= 0) stockDepleted = true;
      } else {
        await env.DB.prepare(`UPDATE products SET quantity = MAX(quantity - ?, 0), updated_at = ? WHERE id = ? AND merchant_id = ?`)
          .bind(item.quantity, Date.now(), pid, tick.merchant_id)
          .run();

        const row = await env.DB.prepare(`SELECT quantity FROM products WHERE id = ? AND merchant_id = ?`)
          .bind(pid, tick.merchant_id)
          .first();
        if (row && (parseInt(row.quantity, 10) || 0) <= 0) stockDepleted = true;
      }
    }

    // 🐙 مزامنة كاش المتجر على GitHub (نفس آلية saveProduct/deleteProduct) —
    // فقط عندما تنتهي كمية أحد المنتجات، وليس عند كل عملية شراء عادية.
    if (stockDepleted) {
      try {
        const remaining = await env.DB.prepare(`SELECT * FROM products WHERE merchant_id = ? AND is_available = 1`)
          .bind(tick.merchant_id)
          .all();
        await syncCatalogToStorefront(env, tick.merchant_username, tick.merchant_id, remaining.results || []);
      } catch (e) {
        console.error('Catalog sync after order failed:', e);
      }
    }

    // إشارة Firebase (لأغراض التتبع للزبون/المندوب) + تحديث لوحة التاجر اللحظية عبر DO
    try {
      await syncOrderTracking(env, tick.ticket_id, tick.status, tick.merchant_username);
      
      // ⭐ تحديث الـ Durable Object (In-Memory Cache) للطلبات النشطة
      if (env.MERCHANT_SESSION) {
        const orderRecord = await env.DB.prepare(
          `SELECT * FROM live_tickets WHERE ticket_id = ? AND merchant_id = ?`
        ).bind(tick.ticket_id, tick.merchant_id).first();
        
        if (orderRecord) {
          const doId = env.MERCHANT_SESSION.idFromName(`merchant_${tick.merchant_id}`);
          const doStub = env.MERCHANT_SESSION.get(doId);
          let data = {};
          try { data = JSON.parse(orderRecord.ticket_data || '{}'); } catch (e) { data = {}; }
          const cust = data.customer || {};
          const fin = data.financials || {};
          
          const orderObj = {
            id: orderRecord.ticket_id,
            order_group_id: orderRecord.order_group_id,
            total_amount: fin.grand_total ?? 0,
            currency: fin.currency || 'YER',
            delivery_fee: fin.delivery_fee ?? 0,
            delivery_address_text: cust.address_text || 'عنوان غير محدد',
            delivery_gps_link: cust.gps_link || '',
            status: orderRecord.status,
            created_at: orderRecord.created_at,
            delivery_code: orderRecord.delivery_code || '',
            customer_name: cust.name || 'عميل',
            customer_phone: cust.phone || '',
            items: data.items || [],
            is_agent_assigned: orderRecord.delivery_agent_id !== null && orderRecord.delivery_agent_id !== undefined,
          };
          
          await doStub.fetch('http://internal/sync-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order: orderObj })
          });
        }
      }
    } catch (e) {
      console.error('Realtime sync failed:', e);
    }

    // إشعار FCM فوري للتاجر
    try {
      const merchantRow = await env.DB.prepare(`SELECT fcm_token, store_name FROM users WHERE id = ?`)
        .bind(tick.merchant_id)
        .first();
      if (merchantRow && merchantRow.fcm_token) {
        await sendFcmNotification(
          env,
          merchantRow.fcm_token,
          '🛍️ طلب جديد!',
          `لديك طلب جديد بانتظار الموافقة والتجهيز. رقم الطلب: ${String(tick.ticket_id).slice(0, 8)}`,
          { action: 'new_order', ticket_id: tick.ticket_id }
        );
      }
    } catch (e) {
      console.error('FCM notify failed:', e);
    }
  } catch (e) {
    console.error('deductStockAndNotify error:', e);
  }
}

// ========================================================
// ⭐ إضافة: get_user_orders
// ⚠️ نطاق مختلف عن api.php عمداً: هذا يرجّع فقط الطلبات "النشطة" الموجودة
// حالياً بجدول live_tickets على D1 (بالضبط نفس نطاق get_merchant_orders
// بالتاجر). الطلبات المؤرشفة (orders_archive) والطلبات القديمة جداً (النظام
// السابق: orders/order_items) موجودة فقط بـ TiDB ولم تُنقل لـ D1 إطلاقاً —
// فسجل الطلبات القديمة/المكتملة لن يظهر من هذا الأكشن. إذا كان "سجل الطلبات"
// (وليس فقط الطلبات الجارية) مطلوباً بالكامل، لازم يبقى على api.php حالياً،
// أو نبني مزامنة أرشفة كاملة لاحقاً كخطوة منفصلة.
// ========================================================
export async function getUserOrders({ env, user }) {
  const customerId = user.user_id;

  const tickets = await env.DB.prepare(
    `SELECT ticket_id as id, order_group_id, merchant_id, status, created_at, delivery_code, delivery_agent_id, ticket_data
     FROM live_tickets WHERE customer_id = ? ORDER BY created_at DESC`
  )
    .bind(customerId)
    .all();

  const groupedOrders = {};

  for (const t of tickets.results || []) {
    let data = {};
    try {
      data = JSON.parse(t.ticket_data || '{}');
    } catch (e) {
      data = {};
    }
    const fin = data.financials || {};
    const cust = data.customer || {};
    const merch = data.merchant || {};

    let agentName = null;
    let agentPhone = null;
    let isPrivate = false;
    if (t.delivery_agent_id) {
      const agent = await env.DB.prepare(`SELECT store_name, username, phone FROM users WHERE id = ?`)
        .bind(t.delivery_agent_id)
        .first();
      if (agent) {
        agentName = agent.store_name || agent.username;
        agentPhone = agent.phone || null;
      }
    }

    const order = {
      id: t.id || 'Unknown',
      order_group_id: t.order_group_id || 'Unknown',
      total_amount: fin.grand_total ?? 0,
      currency: fin.currency || 'YER',
      delivery_fee: fin.delivery_fee ?? 0,
      delivery_address_text: cust.address_text || 'عنوان غير محدد',
      status: t.status || 'pending',
      created_at: t.created_at,
      delivery_code: t.delivery_code || null,
      cancel_reason: null,
      merchant_id: t.merchant_id || merch.id || null,
      merchant_name: merch.name || 'متجر',
      customer_phone: cust.phone || '',
      delivery_agent_name: agentName,
      delivery_agent_phone: agentPhone,
      is_private_agent: isPrivate,
      items: Array.isArray(data.items) ? data.items : [],
    };

    const groupId = t.order_group_id || t.id;
    if (!groupedOrders[groupId]) {
      groupedOrders[groupId] = { group_id: groupId, created_at: t.created_at, sub_orders: [] };
    }
    groupedOrders[groupId].sub_orders.push(order);
  }

  const finalGroups = Object.values(groupedOrders).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  return { data: finalGroups };
}
