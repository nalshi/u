import { syncOrderTracking } from '../services/realtime/realtimeSyncService.js';
import {
  notifyOrderStatusUpdate,
  notifyMerchantOrderUpdate,
  notifyOrderCompleted,
} from '../services/notifications/notificationService.js';
import { HttpError } from '../security/rbac.js';
import { syncCatalogToStorefront } from '../services/catalog/catalogSyncService.js';
import { ORDER_STATUSES } from '../config/constants.js';

const VALID_ORDER_STATUSES = Object.values(ORDER_STATUSES);

// ========================================================
// 📦 تحكم طلبات التاجر - دورة حياة الطلب كاملة على D1
// ========================================================

// 📦 طلبات نشطة (live_tickets) + مؤرشفة (orders_archive) - كلها من D1 الآن.
export async function getOrders({ env, user, body }) {
  const filter = body?.filter === 'archived' ? 'archived' : 'active';

  if (filter === 'active') {
    return getMerchantOrders({ env, user });
  }

  // ⭐ نفس إصلاح getStats: orders_archive تكبر بلا حد مع الوقت (كل طلب
  // مكتمل يُضاف إليها للأبد) - نفس المخاطر تماماً (rows_read + وقت معالج)
  // بدون حد أقصى. حد افتراضي سخي (200 أحدث طلب) يغطي أي تصفّح واقعي.
  const limit = Math.min(Math.max(parseInt(body?.limit, 10) || 200, 1), 200);

  const archives = await env.DB.prepare(
    `SELECT ticket_id as id, final_status as status, archived_at as created_at, archived_data, total_amount
     FROM orders_archive WHERE merchant_id = ? ORDER BY archived_at DESC LIMIT ?`
  )
    .bind(user.user_id, limit)
    .all();

  const orders = (archives.results || []).map((arc) => {
    let data = {};
    try {
      data = JSON.parse(arc.archived_data || '{}');
    } catch (e) {
      data = {};
    }
    const cust = data.customer || {};
    return {
      id: arc.id,
      total_amount: arc.total_amount,
      status: arc.status,
      created_at: arc.created_at,
      customer_name: cust.name || 'عميل',
      items: data.items || [],
    };
  });

  return { data: orders };
}

// 📦 الطلبات النشطة (live_tickets) فقط
export async function getMerchantOrders({ env, user }) {
  // ⭐ تحقق دفاعي: هذا الجدول محدود طبيعياً (الطلبات المكتملة تُنقل فوراً
  // لـ orders_archive وتُحذف من هنا)، لكن نضيف حداً أعلى احتياطياً - أي
  // خلل مستقبلي بمنطق الأرشفة، أو تراكم غير متوقع، لن يكسر لوحة التاجر.
  const tickets = await env.DB.prepare(
    `SELECT ticket_id as id, order_group_id, status, created_at, delivery_code, delivery_agent_id, ticket_data
     FROM live_tickets WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 200`
  )
    .bind(user.user_id)
    .all();

  const orders = (tickets.results || []).map((t) => {
    let data = {};
    try {
      data = JSON.parse(t.ticket_data || '{}');
    } catch (e) {
      data = {};
    }
    if (!data || typeof data !== 'object') data = {};

    const fin = data.financials || {};
    const cust = data.customer || {};

    return {
      id: t.id,
      order_group_id: t.order_group_id,
      total_amount: fin.grand_total ?? 0,
      currency: fin.currency || 'YER',
      delivery_fee: fin.delivery_fee ?? 0,
      delivery_address_text: cust.address_text || 'عنوان غير محدد',
      delivery_gps_link: cust.gps_link || '',
      status: t.status,
      created_at: t.created_at,
      delivery_code: t.delivery_code || '',
      customer_name: cust.name || 'عميل',
      customer_phone: cust.phone || '',
      items: data.items || [],
      is_agent_assigned: t.delivery_agent_id !== null && t.delivery_agent_id !== undefined,
    };
  });

  return { data: orders };
}

// ✅ تحديث حالة عامة (موافقة التاجر، خرج للتوصيل، ...) - يغطي merchant_approve_order
// و merchant_update_order_status القديمتين معاً بأكشن واحد موحّد.
export async function updateOrderStatus({ env, ctx, user, body }) {
  if (!body.ticket_id || !body.status) throw new HttpError('ticket_id و status مطلوبان', 400);
  // ⭐ إصلاح: كانت أي قيمة نصية تُقبل بدون تحقق وتُكتب مباشرة بعمود status،
  // رغم أن باقي النظام (ACTIVE_ORDER_STATUSES، منطق الأرشفة، تطبيقا الزبون
  // والمندوب) يفترض أن القيمة دائماً إحدى حالات ORDER_STATUSES المعروفة.
  if (!VALID_ORDER_STATUSES.includes(body.status)) {
    throw new HttpError('قيمة status غير معروفة.', 400);
  }

  const result = await env.DB.prepare(`UPDATE live_tickets SET status = ? WHERE ticket_id = ? AND merchant_id = ?`)
    .bind(body.status, body.ticket_id, user.user_id)
    .run();

  if (!result.meta || result.meta.changes === 0) {
    throw new HttpError('الطلب غير موجود أو لا يخصك.', 404);
  }

  const order = await env.DB.prepare(
    `SELECT * FROM live_tickets WHERE ticket_id = ? AND merchant_id = ?`
  )
    .bind(body.ticket_id, user.user_id)
    .first();

  if (order) {
    ctx.waitUntil(syncOrderTracking(env, body.ticket_id, body.status, user.username));
    ctx.waitUntil(notifyOrderStatusUpdate(env, order.customer_id, body.status, body.ticket_id));
    ctx.waitUntil(notifyMerchantOrderUpdate(env, user.user_id, body.status, body.ticket_id));

    if (env.MERCHANT_SESSION) {
      try {
        const doId = env.MERCHANT_SESSION.idFromName(`merchant_${user.user_id}`);
        const doStub = env.MERCHANT_SESSION.get(doId);
        let data = {};
        try { data = JSON.parse(order.ticket_data || '{}'); } catch (e) { data = {}; }
        const cust = data.customer || {};
        const fin = data.financials || {};
        
        const orderObj = {
          id: order.ticket_id,
          order_group_id: order.order_group_id,
          total_amount: fin.grand_total ?? 0,
          currency: fin.currency || 'YER',
          delivery_fee: fin.delivery_fee ?? 0,
          delivery_address_text: cust.address_text || 'عنوان غير محدد',
          delivery_gps_link: cust.gps_link || '',
          status: order.status,
          created_at: order.created_at,
          delivery_code: order.delivery_code || '',
          customer_name: cust.name || 'عميل',
          customer_phone: cust.phone || '',
          items: data.items || [],
          is_agent_assigned: order.delivery_agent_id !== null && order.delivery_agent_id !== undefined,
        };
        
        ctx.waitUntil(
          doStub.fetch('http://internal/sync-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order: orderObj })
          })
        );
      } catch (e) { console.error('DO sync error:', e); }
    }
  }

  return { message: 'تم تحديث حالة الطلب' };
}

// ❌ إلغاء الطلب - يعيد المخزون المحجوز (للمنتجات المتتبَّعة) ويحذف التذكرة.
export async function cancelOrder({ env, ctx, user, body }) {
  if (!body.ticket_id) throw new HttpError('ticket_id مطلوب', 400);

  const ticket = await env.DB.prepare(
    `SELECT ticket_id, ticket_data, status, customer_id FROM live_tickets WHERE ticket_id = ? AND merchant_id = ?`
  )
    .bind(body.ticket_id, user.user_id)
    .first();

  if (!ticket) throw new HttpError('الطلب غير موجود أو تم التعامل معه مسبقاً.', 404);

  // ⭐ إصلاح أمني (حماية من الطلبات المتكررة/المتزامنة): كان الحذف يحدث
  // بنهاية الدالة فقط، بعد حلقة كاملة تُعيد كل عنصر للمخزون. لو وصل طلبان
  // متزامنان (نقرة مزدوجة، إعادة محاولة الشبكة..) لنفس التذكرة، كان
  // الاثنان يجتازان الفحص أعلاه (لم تُحذف التذكرة بعد) وتُعاد كل الكمية
  // للمخزون مرتين. الحل: "نطالب" بالتذكرة أولاً بحذف شرطي ذري - فقط أول
  // طلب ينجح، والثاني يفشل بوضوح بدل تكرار إعادة المخزون بصمت.
  const claim = await env.DB.prepare(
    `DELETE FROM live_tickets WHERE ticket_id = ? AND merchant_id = ?`
  )
    .bind(body.ticket_id, user.user_id)
    .run();

  if (!claim.meta || claim.meta.changes === 0) {
    throw new HttpError('تم التعامل مع هذا الطلب بالفعل (ربما بطلب سابق متزامن).', 409);
  }

  let ticketData = {};
  try {
    ticketData = JSON.parse(ticket.ticket_data || '{}');
  } catch (e) {
    ticketData = {};
  }
  const items = ticketData.items || [];
  let inventoryChanged = false;

  for (const item of items) {
    const prod = await env.DB.prepare(`SELECT quantity, quantity_type, options FROM products WHERE id = ? AND merchant_id = ?`)
      .bind(item.product_id, user.user_id)
      .first();

    if (prod && prod.quantity_type === 'tracked') {
      inventoryChanged = true;
      if (item.size_id) {
        let options = [];
        try {
          options = JSON.parse(prod.options || '[]');
        } catch (e) {
          options = [];
        }
        let totalRemaining = 0;
        for (const opt of options) {
          if (opt.id === item.size_id) {
            opt.quantity = (parseInt(opt.quantity, 10) || 0) + item.quantity;
          }
          totalRemaining += parseInt(opt.quantity, 10) || 0;
        }
        await env.DB.prepare(`UPDATE products SET quantity = ?, options = ?, updated_at = ? WHERE id = ? AND merchant_id = ?`)
          .bind(totalRemaining, JSON.stringify(options), Date.now(), item.product_id, user.user_id)
          .run();
      } else {
        await env.DB.prepare(`UPDATE products SET quantity = quantity + ?, updated_at = ? WHERE id = ? AND merchant_id = ?`)
          .bind(item.quantity, Date.now(), item.product_id, user.user_id)
          .run();
      }
    }
  }

  ctx.waitUntil(syncOrderTracking(env, body.ticket_id, 'cancelled', user.username));
  // ⭐ إلغاء الطلب هو أيضاً "تغيير حالة من قبل التاجر"، فيجب أن يصل إشعار للعميل.
  ctx.waitUntil(notifyOrderStatusUpdate(env, ticket.customer_id, 'cancelled', body.ticket_id));

  // ⭐ تحديث الـ Durable Object
  if (env.MERCHANT_SESSION) {
    try {
      const doId = env.MERCHANT_SESSION.idFromName(`merchant_${user.user_id}`);
      const doStub = env.MERCHANT_SESSION.get(doId);
      ctx.waitUntil(
        doStub.fetch('http://internal/sync-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order: { ticket_id: body.ticket_id, status: 'cancelled' } })
        })
      );
    } catch (e) { console.error('DO sync error:', e); }
  }

  if (inventoryChanged) {
    // ⭐ إصلاح فعلي (خطأ منطقي): كان هذا الاستعلام الوحيد بالمشروع الذي يغذّي
    // syncCatalogToStorefront بدون شرط `is_available = 1` (كل نقاط المزامنة
    // الأخرى بـ productController.js تضيفه). النتيجة: إلغاء أي طلب كان يعيد
    // نشر كل منتجات التاجر بالكتالوج العام - **حتى المنتجات المخفية عمداً**
    // (is_available = 0) - لأن catalogSyncService.js ينسخ قيمة is_available
    // كما هي بدل تصفيتها. أضفنا نفس الشرط المستخدم بكل مكان آخر، مع نفس
    // تقليص الأعمدة (راجع تعليق saveProduct لتفاصيل سبب ذلك).
    const allProducts = await env.DB.prepare(
      `SELECT id, name, description, price, discount, image, category_id, options, features,
              quantity, quantity_type, is_available, currency
       FROM products WHERE merchant_id = ? AND is_available = 1`
    )
      .bind(user.user_id)
      .all();
    ctx.waitUntil(syncCatalogToStorefront(env, user.username, user.user_id, allProducts.results));
  }

  return { message: 'تم إلغاء الطلب بنجاح وإعادة المنتجات للمخزون.' };
}

// 📊 إحصائيات المبيعات (سجل sales_log كاملاً لهذا التاجر) - نقرأ من
// sales_log مباشرة بدون أي JOIN مع جدول products، حتى تبقى مبيعات
// المنتجات المحذوفة ظاهرة بالإحصائيات دائماً (الاسم مخزّن كـ snapshot
// وقت البيع، راجع confirmDeliveryCode بالأسفل).
export async function getStats({ env, user, body }) {
  // ⭐ إصلاح حرج (يكسر لوحة التاجر مع نمو المبيعات + استهلاك موارد مفرط):
  // كان هذا الاستعلام بلا أي LIMIT - يقرأ سجل مبيعات التاجر **بالكامل**
  // (كل عملية بيع منذ بداية المتجر) بكل استدعاء لتبويب الإحصائيات. لتاجر
  // نشط لفترة، هذا يعني آلاف/عشرات آلاف الصفوف تُقرأ وتُعالَج (JSON) بكل
  // فتح للتبويب - يستهلك rows_read من حصة D1 اليومية بسرعة، ويتجاوز بسهولة
  // سقف 10ms وقت معالج بخطة Cloudflare المجانية (فيفشل الطلب بخطأ تجاوز
  // الموارد كلما كبر سجل التاجر - عطل يزداد سوءاً مع نجاح المتجر بالذات).
  // الحل: حد أقصى افتراضي سخي (500 أحدث عملية) يغطي أي استخدام واقعي
  // للوحة إحصائيات، مع دعم body.limit لصفحات لاحقة إذا احتاجها الواجهة.
  const limit = Math.min(Math.max(parseInt(body?.limit, 10) || 500, 1), 500);

  const rows = await env.DB.prepare(
    `SELECT id, product_id, product_name, quantity, price_per_item, total_price, currency, created_at
     FROM sales_log WHERE user_id = ? AND type = 'sale' ORDER BY created_at DESC LIMIT ?`
  )
    .bind(user.user_id, limit)
    .all();

  const salesLog = (rows.results || []).map((r) => ({
    id: r.id,
    productId: r.product_id,
    productName: r.product_name || 'منتج محذوف',
    quantity: r.quantity,
    price_per_item: r.price_per_item,
    total_price: r.total_price,
    currency: r.currency,
    timestamp: r.created_at,
  }));

  return { data: { salesLog } };
}

// ✅ تأكيد التسليم عبر الكود - يسجل المبيعات، يؤرشف الطلب، ويحذف التذكرة النشطة.
export async function confirmDeliveryCode({ env, ctx, user, body }) {
  const ticketId = body.ticket_id;
  const code = String(body.code || '');
  if (!ticketId || code.length !== 4) throw new HttpError('يرجى إدخال الكود المكون من 4 أرقام.', 400);

  const ticket = await env.DB.prepare(
    `SELECT delivery_code, status, ticket_data, customer_id, order_group_id FROM live_tickets WHERE ticket_id = ? AND merchant_id = ?`
  )
    .bind(ticketId, user.user_id)
    .first();

  if (!ticket) throw new HttpError('الطلب غير موجود أو تم تسليمه مسبقاً.', 404);
  if (ticket.status !== 'out_for_delivery') throw new HttpError("يجب أن يكون الطلب في حالة 'خرج للتوصيل' أولاً.", 400);

  let ticketData = {};
  try {
    ticketData = JSON.parse(ticket.ticket_data || '{}');
  } catch (e) {
    ticketData = {};
  }

  // ⭐ إصلاح أمني: كود التسليم 4 أرقام فقط (9000 احتمال) ولم يكن هناك أي حد
  // لعدد المحاولات - يمكن تخمينه بالكامل بمحاولات كافية. نسمح بعدد محاولات
  // معقول خلال نافذة زمنية قصيرة (يكفي لأخطاء الكتابة الحقيقية) ونرفض أي
  // محاولة إضافية مؤقتاً بعدها، فيصير التخمين الكامل غير عملي زمنياً. نخزّن
  // المحاولات ضمن ticket_data نفسه (بدون الحاجة لعمود/جدول جديد، بنفس نمط
  // بقية بيانات التذكرة المتغيّرة).
  const now = Date.now();
  const MAX_ATTEMPTS_PER_WINDOW = 5;
  const WINDOW_MS = 10 * 60 * 1000;
  const recentAttempts = (ticketData.delivery_attempts || []).filter((ts) => now - ts < WINDOW_MS);

  if (recentAttempts.length >= MAX_ATTEMPTS_PER_WINDOW) {
    throw new HttpError('عدد محاولات إدخال الكود كبير جداً. يرجى الانتظار قليلاً ثم المحاولة مجدداً.', 429);
  }

  if (String(ticket.delivery_code) !== code) {
    recentAttempts.push(now);
    ticketData.delivery_attempts = recentAttempts;
    await env.DB.prepare(`UPDATE live_tickets SET ticket_data = ? WHERE ticket_id = ?`)
      .bind(JSON.stringify(ticketData), ticketId)
      .run();
    throw new HttpError('كود التسليم غير صحيح. يرجى المراجعة مع العميل.', 400);
  }

  // ⭐ إصلاح أمني (حماية من الطلبات المتكررة/المتزامنة): كان حذف التذكرة
  // يحدث بنهاية الدالة، بعد إدراج سجلات المبيعات بالكامل. لو وصل طلبان
  // متزامنان بنفس الكود الصحيح (نقرة مزدوجة، إعادة محاولة الشبكة..)، كان
  // الاثنان يجتازان كل الفحوصات أعلاه (التذكرة لم تُحذف بعد) فتُسجَّل نفس
  // عملية البيع مرتين بـ sales_log (مضاعفة الإيراد بالإحصائيات) وبـ
  // orders_archive. نطالب بالتذكرة أولاً بحذف شرطي ذري - فقط أول طلب
  // ينجح، والثاني يفشل بوضوح بدل تكرار تسجيل البيع بصمت.
  const claim = await env.DB.prepare(
    `DELETE FROM live_tickets WHERE ticket_id = ? AND merchant_id = ? AND status = 'out_for_delivery'`
  )
    .bind(ticketId, user.user_id)
    .run();

  if (!claim.meta || claim.meta.changes === 0) {
    throw new HttpError('تم تأكيد تسليم هذا الطلب بالفعل (ربما بطلب سابق متزامن).', 409);
  }

  const items = ticketData.items || [];
  const currency = ticketData.financials?.currency || 'YER';
  const grandTotal = ticketData.financials?.grand_total || 0;

  for (const item of items) {
    const saleId = 'SALE-' + crypto.randomUUID();
    const totalPrice = item.price * item.quantity;
    const costAtSale = (item.cost_price || 0) * item.quantity;
    // ⭐ إصلاح: نخزّن اسم المنتج (snapshot) هنا وقت البيع بدل الاعتماد على
    // JOIN مع جدول products عند عرض الإحصائيات لاحقاً. لو التاجر حذف
    // المنتج بعدين، الإحصائيات القديمة كانت تختفي كلياً لأن الـ JOIN ما
    // يلقى صف المنتج. الاسم متوفر أصلاً بـ item.product_name من لحظة
    // إنشاء الطلب (createOrder بـ customerController.js)، فلا داعي لأي
    // استعلام إضافي على products هنا.
    await env.DB.prepare(
      `INSERT INTO sales_log (id, user_id, product_id, product_name, size_id, quantity, price_per_item, total_price, currency, type, cost_at_sale, order_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sale', ?, ?, ?)`
    )
      .bind(
        saleId,
        user.user_id,
        item.product_id,
        item.product_name || 'منتج',
        item.size_id || null,
        item.quantity,
        item.price,
        totalPrice,
        currency,
        costAtSale,
        ticketId,
        Date.now()
      )
      .run();
  }

  await env.DB.prepare(
    `INSERT INTO orders_archive (ticket_id, order_group_id, customer_id, merchant_id, final_status, total_amount, archived_data, archived_at)
     VALUES (?, ?, ?, ?, 'completed', ?, ?, ?)`
  )
    .bind(ticketId, ticket.order_group_id, ticket.customer_id, user.user_id, grandTotal, JSON.stringify(ticketData), Date.now())
    .run();

  ctx.waitUntil(syncOrderTracking(env, ticketId, 'completed', user.username));
  // ⭐ عند اتمام الطلب فعلياً، يصل إشعار صحيح للعميل (تم التسليم) وللتاجر
  // (توثيق المبلغ في رصيده) معاً.
  ctx.waitUntil(
    notifyOrderCompleted(env, {
      customerId: ticket.customer_id,
      merchantId: user.user_id,
      ticketId,
      grandTotal,
      currency,
    })
  );

  // ⭐ تحديث الـ Durable Object
  if (env.MERCHANT_SESSION) {
    try {
      const doId = env.MERCHANT_SESSION.idFromName(`merchant_${user.user_id}`);
      const doStub = env.MERCHANT_SESSION.get(doId);
      ctx.waitUntil(
        doStub.fetch('http://internal/sync-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order: { ticket_id: ticketId, status: 'completed' } })
        })
      );
    } catch (e) { console.error('DO sync error:', e); }
  }

  return { message: 'تم تأكيد التسليم بنجاح وتوثيق الأرباح في رصيدك!' };
}
