import { HttpError } from '../security/rbac.js';
import { generateAiReplyForMerchant } from './aiAssistantController.js';
import { sanitizeCustomerMessage } from '../services/ai/sanitize.js';
import { assertRateLimitOk } from '../services/ai/rateLimiter.js';

// ========================================================
// 📱 ربط المساعد الذكي بواتساب - كل تاجر يربط رقمه الخاص
// (WhatsApp Cloud API الرسمي من Meta - وليس مكتبات غير رسمية، لأن
// Cloudflare Workers لا تدعم اتصال دائم (socket) تحتاجه تلك المكتبات).
//
// المعمارية:
//  - كل تاجر يسوي حساب Meta Developer + WhatsApp Business App خاص فيه
//    (خارج نطاق هذا الكود تماماً)، وياخذ منه: phone_number_id + access_token.
//  - يدخل هالبيانات هنا (نفس مبدأ إعدادات المساعد الذكي الموجودة مسبقاً).
//  - نولّد له تلقائياً verify_token فريد + رابط Webhook واحد ثابت، يدخلهم
//    بلوحة تحكم تطبيق Meta الخاص فيه (مرة وحدة فقط).
//  - Webhook واحد بالكامل (نفس الرابط لكل التجار) يستقبل كل الرسائل، ويعرف
//    "لأي تاجر تعود هذي الرسالة" عن طريق phone_number_id المرفق بكل حمولة
//    واردة من Meta - هذا هو مفتاح الفصل بين التجار (multi-tenant).
// ========================================================

const GRAPH_API_VERSION = 'v20.0';

function maskToken(token) {
  if (!token) return '';
  const clean = String(token);
  if (clean.length <= 6) return '••••••';
  return `${clean.slice(0, 4)}••••${clean.slice(-4)}`;
}

async function ensureWhatsappTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS merchant_whatsapp_settings (
      merchant_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      phone_number_id TEXT,
      display_phone_number TEXT,
      access_token TEXT,
      app_secret TEXT,
      verify_token TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`
  ).run();
  // فهارس فريدة منفصلة (وليس ضمن CREATE TABLE) حتى تعمل مع IF NOT EXISTS
  // بأمان حتى لو الجدول كان موجوداً مسبقاً بدونها.
  await env.DB.prepare(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_phone_number_id
     ON merchant_whatsapp_settings(phone_number_id) WHERE phone_number_id IS NOT NULL`
  ).run();
  await env.DB.prepare(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_verify_token
     ON merchant_whatsapp_settings(verify_token)`
  ).run();

  // جدول منفصل لمنع معالجة نفس رسالة واتساب أكثر من مرة (Meta تعيد إرسال
  // الحدث لو ما استلمت رد 200 خلال مهلة قصيرة - نفس فكرة idempotency_keys
  // المستخدمة بالطلبات، لكن بمفتاح مختلف: معرّف رسالة واتساب wamid).
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS whatsapp_processed_messages (
      wamid TEXT PRIMARY KEY,
      processed_at INTEGER NOT NULL
    )`
  ).run();

  // سجل مختصر لآخر رسائل كل محادثة (تاجر+رقم عميل) حتى يقدر المساعد يربط
  // الرسالة الحالية بسياق ما قبلها، تماماً مثل history المُرسل من ودجت الويب،
  // لكن هنا لازم نحفظه إحنا لأن واتساب ما يرسل سجل المحادثة مع كل رسالة.
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS whatsapp_conversations (
      conversation_key TEXT PRIMARY KEY,
      history_json TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    )`
  ).run();
}

// --------------------------------------------------------
// 🔎 جلب إعدادات واتساب الخاصة بالتاجر الحالي (للوحة التاجر)
// ينشئ verify_token تلقائياً أول مرة يفتح فيها التاجر هذي الصفحة
// --------------------------------------------------------
export async function getWhatsappConfig({ env, user, request }) {
  await ensureWhatsappTable(env);
  const merchantId = String(user.user_id);

  let row = await env.DB.prepare(
    `SELECT enabled, phone_number_id, display_phone_number, access_token, verify_token
     FROM merchant_whatsapp_settings WHERE merchant_id = ?`
  )
    .bind(merchantId)
    .first();

  if (!row) {
    // أول زيارة للتاجر لهذي الصفحة: نجهّز له verify_token فريد فوراً حتى
    // يقدر يبدأ إعداد الـ Webhook بتطبيق Meta الخاص فيه من نفس اللحظة.
    const verifyToken = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO merchant_whatsapp_settings (merchant_id, enabled, verify_token, updated_at)
       VALUES (?, 0, ?, ?)`
    )
      .bind(merchantId, verifyToken, Date.now())
      .run();
    row = { enabled: 0, phone_number_id: '', display_phone_number: '', access_token: '', verify_token: verifyToken };
  }

  const url = new URL(request.url);
  const webhookUrl = `${url.origin}/webhooks/whatsapp`;

  return {
    data: {
      enabled: !!row.enabled,
      phone_number_id: row.phone_number_id || '',
      display_phone_number: row.display_phone_number || '',
      access_token_masked: maskToken(row.access_token),
      has_access_token: !!row.access_token,
      verify_token: row.verify_token,
      webhook_url: webhookUrl,
    },
  };
}

// --------------------------------------------------------
// 💾 حفظ إعدادات واتساب (تاجر فقط، JWT + دور MERCHANT)
// --------------------------------------------------------
export async function saveWhatsappConfig({ env, user, body }) {
  await ensureWhatsappTable(env);
  const merchantId = String(user.user_id);

  const enabled = body.enabled === true || body.enabled === 'true' || body.enabled === 1 ? 1 : 0;
  const phoneNumberId = String(body.phone_number_id || '').trim();
  const displayPhoneNumber = String(body.display_phone_number || '').trim().slice(0, 32);
  // access_token اختياري بكل حفظة: لو ما أرسل التاجر قيمة جديدة (ترك الحقل
  // فاضي لأنه معبّى مسبقاً بنص مقنّع بالواجهة)، نبقي القيمة القديمة كما هي.
  const newAccessToken = typeof body.access_token === 'string' ? body.access_token.trim() : '';
  const newAppSecret = typeof body.app_secret === 'string' ? body.app_secret.trim() : '';

  if (enabled && !phoneNumberId) {
    throw new HttpError('رقم phone_number_id مطلوب لتفعيل الربط', 400);
  }

  const existing = await env.DB.prepare(
    `SELECT access_token, app_secret, verify_token FROM merchant_whatsapp_settings WHERE merchant_id = ?`
  )
    .bind(merchantId)
    .first();

  const verifyToken = existing?.verify_token || crypto.randomUUID();
  const accessToken = newAccessToken || existing?.access_token || '';
  const appSecret = newAppSecret || existing?.app_secret || '';

  if (enabled && !accessToken) {
    throw new HttpError('access_token مطلوب لتفعيل الربط', 400);
  }
  // ⭐ إصلاح أمني: بدون app_secret، يتعذّر التحقق من توقيع Meta على أي
  // Webhook وارد (راجع verifyMetaSignature)، مما يسمح لأي طرف يعرف
  // phone_number_id (ليس سرّياً) بإرسال أحداث واتساب مزوّرة باسم هذا
  // التاجر - فتُستهلك حصة Gemini الخاصة به، بل وتُرسل ردود فعلية من رقم
  // واتساب حسابه الحقيقي (access_token صالح) لأي جهة يختارها المهاجم.
  // نفس الإلزام المطبّق أصلاً على access_token.
  if (enabled && !appSecret) {
    throw new HttpError('app_secret مطلوب لتفعيل الربط (لحماية الرابط من الأحداث المزوّرة)', 400);
  }

  try {
    await env.DB.prepare(
      `INSERT INTO merchant_whatsapp_settings
         (merchant_id, enabled, phone_number_id, display_phone_number, access_token, app_secret, verify_token, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(merchant_id) DO UPDATE SET
         enabled = excluded.enabled,
         phone_number_id = excluded.phone_number_id,
         display_phone_number = excluded.display_phone_number,
         access_token = excluded.access_token,
         app_secret = excluded.app_secret,
         updated_at = excluded.updated_at`
    )
      .bind(merchantId, enabled, phoneNumberId || null, displayPhoneNumber, accessToken, appSecret, verifyToken, Date.now())
      .run();
  } catch (error) {
    // انتهاك فهرس phone_number_id الفريد = رقم مربوط مسبقاً بحساب تاجر آخر
    if (String(error?.message || '').includes('UNIQUE')) {
      throw new HttpError('رقم الواتساب هذا مربوط مسبقاً بحساب تاجر آخر على نالش', 409);
    }
    throw error;
  }

  return {
    message: enabled ? 'تم ربط المساعد الذكي بواتساب بنجاح ✅' : 'تم حفظ الإعدادات (الربط متوقف حالياً)',
    data: { enabled: !!enabled, phone_number_id: phoneNumberId, display_phone_number: displayPhoneNumber },
  };
}

// --------------------------------------------------------
// ✅ التحقق من الـ Webhook (GET) - خطوة تأكيد Meta عند ربط الرابط أول مرة
// لا تمر عبر نظام action/JWT العادي إطلاقاً (راجع index.js)
// --------------------------------------------------------
export async function handleWhatsappWebhookVerify(url, env) {
  await ensureWhatsappTable(env);

  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge') || '';

  if (mode !== 'subscribe' || !token) {
    return new Response('Forbidden', { status: 403 });
  }

  // نبحث عن أي تاجر مسجّل بهذا verify_token بالذات (كل تاجر عنده تطبيق
  // Meta خاص فيه، وبالتالي verify_token خاص فيه هو أيضاً).
  const match = await env.DB.prepare(
    `SELECT merchant_id FROM merchant_whatsapp_settings WHERE verify_token = ?`
  )
    .bind(token)
    .first();

  if (!match) {
    return new Response('Forbidden', { status: 403 });
  }

  // Meta تشترط إرجاع قيمة hub.challenge كنص عادي خام (وليس JSON) بالضبط.
  return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
}

async function verifyMetaSignature(rawBody, signatureHeader, appSecret) {
  // ⭐ إصلاح أمني: كانت هذي الدالة "تسمح" (return true) لو ما كان فيه
  // app_secret، على اعتبار أن التوقيع "اختياري" حتى يُعدّه التاجر - لكن هذا
  // يعني عملياً أن أي حدث Webhook غير موقّع يُقبل كأنه توقيعه صحيح. الآن
  // saveWhatsappConfig تفرض app_secret إجبارياً عند التفعيل، فهذا المسار
  // (بلا app_secret) لا يجب أن يحدث لتاجر مفعّل أصلاً - ونرفض بأمان
  // (fail closed) بدل القبول لو حدث بأي شكل (بيانات قديمة قبل هذا الإصلاح مثلاً).
  if (!appSecret) return false;
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const computedHex = [...new Uint8Array(sigBuffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const providedHex = signatureHeader.slice('sha256='.length);

  // مقارنة بطول ثابت لتفادي timing attacks
  if (computedHex.length !== providedHex.length) return false;
  let diff = 0;
  for (let i = 0; i < computedHex.length; i++) diff |= computedHex.charCodeAt(i) ^ providedHex.charCodeAt(i);
  return diff === 0;
}

async function sendWhatsappTextMessage({ accessToken, phoneNumberId, to, text }) {
  const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { preview_url: false, body: text },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`WhatsApp send HTTP ${res.status}: ${errText.slice(0, 300)}`);
  }
}

const MAX_STORED_TURNS = 12;

// --------------------------------------------------------
// 📩 استقبال أحداث واتساب الفعلية (POST) - رسائل العملاء الواردة
// لا تمر عبر نظام action/JWT العادي إطلاقاً (راجع index.js)
// --------------------------------------------------------
export async function handleWhatsappWebhookEvent(request, env, ctx) {
  await ensureWhatsappTable(env);

  const rawBody = await request.text();
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return new Response('EVENT_RECEIVED', { status: 200 }); // حمولة غير صالحة - نتجاهلها بهدوء
  }

  const entries = Array.isArray(payload?.entry) ? payload.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value;
      const messages = Array.isArray(value?.messages) ? value.messages : [];
      if (messages.length === 0) continue; // غالباً إشعار حالة تسليم/قراءة، وليس رسالة عميل

      const phoneNumberId = value?.metadata?.phone_number_id;
      if (!phoneNumberId) continue;

      const settingsRow = await env.DB.prepare(
        `SELECT merchant_id, enabled, access_token, app_secret FROM merchant_whatsapp_settings WHERE phone_number_id = ?`
      )
        .bind(phoneNumberId)
        .first();

      // دفاع إضافي (defense in depth): حتى لو وُجد صف قديم مفعّل بلا
      // app_secret (من قبل هذا الإصلاح)، نرفض معالجته بدل الاعتماد فقط على
      // verifyMetaSignature - فشل مغلق تماماً بغياب السرّ.
      if (!settingsRow || !settingsRow.enabled || !settingsRow.access_token || !settingsRow.app_secret) continue;

      // 🔐 تحقق من توقيع Meta (لو التاجر مفعّل app_secret بإعداداته)
      const signatureOk = await verifyMetaSignature(
        rawBody,
        request.headers.get('X-Hub-Signature-256'),
        settingsRow.app_secret
      );
      if (!signatureOk) continue; // حمولة مزوّرة - تجاهل تام بدون معالجة

      for (const msg of messages) {
        await processIncomingWhatsappMessage({ env, msg, settingsRow, phoneNumberId });
      }
    }
  }

  // Meta تشترط رد 200 سريع بغض النظر عن نتيجة المعالجة الداخلية، وإلا
  // تعتبر التسليم فاشل وتعيد إرسال نفس الحدث لاحقاً (مما يسبب ردوداً مكررة).
  return new Response('EVENT_RECEIVED', { status: 200 });
}

async function processIncomingWhatsappMessage({ env, msg, settingsRow, phoneNumberId }) {
  const wamid = msg?.id;
  if (!wamid) return;

  // 🛡️ منع المعالجة المكررة (إعادة إرسال من Meta لنفس الرسالة)
  try {
    await env.DB.prepare(`INSERT INTO whatsapp_processed_messages (wamid, processed_at) VALUES (?, ?)`)
      .bind(wamid, Date.now())
      .run();
  } catch (e) {
    return; // موجودة مسبقاً = تمت معالجتها قبل الآن، لا نكررها
  }

  // حالياً ندعم الرسائل النصية فقط
  const customerMessage = sanitizeCustomerMessage(msg?.text?.body || '');
  const customerWaId = msg?.from;
  if (!customerMessage || !customerWaId) return;

  const merchantId = String(settingsRow.merchant_id);

  try {
    await assertRateLimitOk(env, { merchantId, clientIp: `wa:${customerWaId}` });
  } catch (e) {
    return; // تجاوز حد الرسائل لهذا العميل - نتجاهل بهدوء بدون رد
  }

  const conversationKey = `${merchantId}:${customerWaId}`;
  const convoRow = await env.DB.prepare(
    `SELECT history_json FROM whatsapp_conversations WHERE conversation_key = ?`
  )
    .bind(conversationKey)
    .first();

  let history = [];
  try {
    history = convoRow ? JSON.parse(convoRow.history_json || '[]') : [];
  } catch (e) {
    history = [];
  }

  let reply = '';
  try {
    const result = await generateAiReplyForMerchant({
      env,
      merchantId,
      customerMessage,
      conversationHistory: history,
    });
    reply = result.reply;
  } catch (error) {
    console.error('❌ [whatsapp] فشل توليد رد المساعد الذكي:', error && error.message, error);
    reply = 'عذراً، حدث خطأ مؤقت. حاول بعد قليل أو تواصل مباشرة مع المتجر.';
  }

  // تحديث سجل المحادثة (نحتفظ فقط بآخر عدد محدود من الأدوار لتفادي تضخّم الصف)
  const updatedHistory = [
    ...history,
    { role: 'user', text: customerMessage },
    { role: 'model', text: reply },
  ].slice(-MAX_STORED_TURNS);

  await env.DB.prepare(
    `INSERT INTO whatsapp_conversations (conversation_key, history_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(conversation_key) DO UPDATE SET history_json = excluded.history_json, updated_at = excluded.updated_at`
  )
    .bind(conversationKey, JSON.stringify(updatedHistory), Date.now())
    .run();

  try {
    await sendWhatsappTextMessage({
      accessToken: settingsRow.access_token,
      phoneNumberId,
      to: customerWaId,
      text: reply,
    });
  } catch (error) {
    // فشل الإرسال (توكن منتهي/رقم غير صحيح..) - نسجّله فقط، لا يوجد طرف
    // آخر نرسل له الخطأ (العميل أصلاً ما وصله شي).
    console.error('❌ [whatsapp] فشل إرسال الرد عبر Graph API:', error && error.message, error);
  }
}
