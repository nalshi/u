import { HttpError } from '../security/rbac.js';
import { buildMasterSystemPrompt } from '../services/ai/systemPromptBuilder.js';
import { assertRateLimitOk } from '../services/ai/rateLimiter.js';
import {
  sanitizeBotName,
  sanitizeTone,
  sanitizeCustomRules,
  sanitizeCustomerMessage,
  sanitizeConversationHistory,
  sanitizePlainText,
  escapeHtml,
} from '../services/ai/sanitize.js';

// ========================================================
// 🤖 تحكم "المساعد الذكي الخاص بكل تاجر"
// ثلاث دوال:
//   - getAiAssistantConfig: يجلب إعدادات التاجر الحالية (للوحة التاجر)
//   - saveAiAssistantConfig: يحفظ إعدادات التاجر (محمي بـ JWT + دور MERCHANT)
//   - aiChat: مسار عام (public) يستخدمه عملاء المتجر لمحادثة المساعد
// ========================================================

const MAX_PRODUCTS_IN_PROMPT = 20;

// ========================================================
// 🤖 محرّك النموذج: Gemini 3.6 Flash (بدّلناه عن Workers AI بناءً على طلب
// التاجر). يحتاج سر جديد بالحساب:
//   wrangler secret put GEMINI_API_KEY
// (الحصول على المفتاح من: https://aistudio.google.com/apikey)
// ========================================================
const GEMINI_MODEL = 'gemini-3.6-flash';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// --------------------------------------------------------
// 🔍 استخراج كلمات بحث مفيدة من رسالة العميل لجلب المنتجات ذات الصلة
// فعلياً بدل الاعتماد فقط على "آخر المنتجات المحدَّثة". نتجاهل كلمات
// الوقف الشائعة (أدوات ربط/طلب) والكلمات القصيرة جداً، ونكتفي بعدد
// محدود من الكلمات لتفادي استعلامات SQL طويلة بلا داعٍ.
// --------------------------------------------------------
const SEARCH_STOPWORDS = new Set([
  'في', 'من', 'الى', 'إلى', 'على', 'عن', 'هل', 'ابغى', 'أبغى', 'اريد', 'أريد',
  'ابي', 'أبي', 'ابغا', 'ودي', 'ممكن', 'لو', 'سمحت', 'فيه', 'عندكم', 'متوفر',
  'متوفره', 'بكم', 'سعر', 'كم', 'وين', 'فين', 'هذا', 'هذه', 'ذا', 'شي', 'شيء',
  'كيف', 'ايش', 'إيش', 'وش', 'انا', 'أنا', 'انتوا', 'عندك', 'موجود', 'موجودة',
]);

// ⭐ إصلاح (2026-07-26): D1 يفرض حد صارم 50 بايت كحد أقصى لطول أي نمط
// LIKE/GLOB (راجع حدود D1 الرسمية). كنا نبني النمط بـ `%${term}%` بدون أي
// سقف على طول الكلمة نفسها - فلو كتب العميل كلمة طويلة (خصوصاً كلمات
// عربية، كل حرف منها بايتين UTF-8) يتجاوز النمط الناتج 50 بايت ويطلع
// "LIKE or GLOB pattern too complex" ويفشل المساعد الذكي بالكامل بدل ما
// يرد على العميل. الحل: نقص كل كلمة بحث إلى حد آمن بالبايتات (وليس
// بعدد الأحرف، لأن حرف عربي واحد قد يكون بايتين) قبل استخدامها بأي LIKE،
// بحيث يبقى النمط الكامل (شاملاً %% المحيطة) دايماً أقل من 50 بايت.
const MAX_LIKE_TERM_BYTES = 20; // + 2 بايت لعلامتي % = 22 بايت كحد أقصى للنمط، بأمان تحت حد D1 (50)

function truncateToByteLimit(str, maxBytes) {
  const bytes = new TextEncoder().encode(str);
  if (bytes.length <= maxBytes) return str;
  // نقص للحد المطلوب ثم نفكّ الترميز بتساهل (fatal: false) حتى لو قطعنا
  // بمنتصف حرف متعدد البايتات، ثم نتخلص من أي محارف بديلة (�) ناتجة عن
  // القطع الجزئي في النهاية.
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, maxBytes));
  return decoded.replace(/\uFFFD+$/, '');
}

function extractSearchTerms(message) {
  return String(message || '')
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((w) => w.length >= 2 && !SEARCH_STOPWORDS.has(w))
    .slice(0, 5)
    .map((w) => truncateToByteLimit(w, MAX_LIKE_TERM_BYTES));
}

// --------------------------------------------------------
// جلب إعدادات المساعد الخاصة بالتاجر الحالي (يستخدمها التاجر عند فتح
// صفحة الإعدادات ليرى قيمه المحفوظة سابقاً)
// --------------------------------------------------------
export async function getAiAssistantConfig({ env, user }) {
  const row = await env.DB.prepare(
    `SELECT ai_enabled, bot_name, tone, custom_rules FROM merchant_ai_settings WHERE merchant_id = ?`
  )
    .bind(String(user.user_id))
    .first();

  if (!row) {
    return {
      data: { ai_enabled: false, bot_name: 'المساعد الذكي', tone: 'friendly', custom_rules: [] },
    };
  }

  let customRules = [];
  try {
    customRules = JSON.parse(row.custom_rules || '[]');
  } catch (e) {
    customRules = [];
  }

  return {
    data: {
      ai_enabled: !!row.ai_enabled,
      bot_name: row.bot_name,
      tone: row.tone,
      custom_rules: customRules,
    },
  };
}

// --------------------------------------------------------
// حفظ إعدادات المساعد (Prepared Statement فقط - لا دمج نصي بالـ SQL)
// --------------------------------------------------------
export async function saveAiAssistantConfig({ env, user, body }) {
  // 🧼 تعقيم كل حقل بمكانه الصحيح قبل أي تخزين
  const aiEnabled = body.ai_enabled === true || body.ai_enabled === 'true' || body.ai_enabled === 1 ? 1 : 0;
  const botName = sanitizeBotName(body.bot_name);
  const tone = sanitizeTone(body.tone);
  const customRules = sanitizeCustomRules(body.custom_rules); // مصفوفة أو نص متعدد الأسطر، كلاهما مدعوم

  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS merchant_ai_settings (
      merchant_id TEXT PRIMARY KEY,
      ai_enabled INTEGER NOT NULL DEFAULT 0,
      bot_name TEXT NOT NULL DEFAULT 'المساعد الذكي',
      tone TEXT NOT NULL DEFAULT 'friendly',
      custom_rules TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    )`
  ).run();

  await env.DB.prepare(
    `INSERT INTO merchant_ai_settings (merchant_id, ai_enabled, bot_name, tone, custom_rules, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(merchant_id) DO UPDATE SET
       ai_enabled = excluded.ai_enabled,
       bot_name = excluded.bot_name,
       tone = excluded.tone,
       custom_rules = excluded.custom_rules,
       updated_at = excluded.updated_at`
  )
    .bind(String(user.user_id), aiEnabled, botName, tone, JSON.stringify(customRules), Date.now())
    .run();

  return {
    message: 'تم حفظ إعدادات المساعد الذكي بنجاح ✅',
    data: { ai_enabled: !!aiEnabled, bot_name: botName, tone, custom_rules: customRules },
  };
}

// --------------------------------------------------------
// 🧠 "دماغ" المساعد الذكي المشترك: يأخذ رسالة عميل (مُعقَّمة مسبقاً) وسجل
// محادثة، ويرجع رد نصي جاهز. يُستخدم من مصدرين مختلفين:
//   1) aiChat: ودجت الدردشة على واجهة المتجر (public, JSON body)
//   2) whatsappController: رسائل واتساب الواردة لكل تاجر (webhook)
// بهذا الشكل، أي إصلاح مستقبلي (تغيير نموذج، تحسين البحث عن المنتجات..)
// ينعكس تلقائياً على القناتين معاً بدل تكراره بمكانين.
// --------------------------------------------------------
export async function generateAiReplyForMerchant({ env, merchantId, customerMessage, conversationHistory }) {
  // --- جلب إعدادات المساعد الخاصة بهذا التاجر (Prepared Statement) ---
  const settingsRow = await env.DB.prepare(
    `SELECT ai_enabled, bot_name, tone, custom_rules FROM merchant_ai_settings WHERE merchant_id = ?`
  )
    .bind(merchantId)
    .first();

  if (!settingsRow || !settingsRow.ai_enabled) {
    return {
      reply: 'عذراً، المساعد الذكي غير مفعّل حالياً لهذا المتجر. تواصل مباشرة مع المتجر للمساعدة.',
      bot_name: 'المساعد',
    };
  }

  let customRules = [];
  try {
    customRules = JSON.parse(settingsRow.custom_rules || '[]');
  } catch (e) {
    customRules = [];
  }

  // --- جلب اسم المتجر (Prepared Statement) ---
  const storeRow = await env.DB.prepare(`SELECT store_name, username FROM users WHERE id = ?`)
    .bind(merchantId)
    .first();
  const storeName = storeRow?.store_name || storeRow?.username || 'المتجر';

  // --- جلب المنتجات ذات الصلة برسالة العميل أولاً (Prepared Statement) ---
  // ⭐ إصلاح: كنا نجلب فقط آخر 20 منتج مُحدَّث بغض النظر عن سؤال العميل،
  // فلو كان للتاجر أكثر من 20 منتج، أي سؤال عن منتج غير موجود ضمن هذه
  // العشرين "الأحدث تحديثاً" كان يخلي النموذج (بحكم تعليماته الصارمة ضد
  // الاختلاق) يرد بأن المنتج "غير متوفر" رغم أنه موجود فعلاً في المتجر.
  // الحل: نبحث أولاً عن منتجات تُطابق كلمات رسالة العميل، ثم نكمل القائمة
  // بآخر المنتجات المحدَّثة، مع إزالة التكرار.
  // نضم آخر رسالة سابقة من العميل (إن وجدت) لاستخراج كلمات البحث، حتى لو
  // كانت رسالته الحالية رد متابعة قصير مثل "زوده" أو "بكم التوصيل له" بدون
  // ذكر اسم المنتج مرة أخرى - هذا هو المقصود بـ"ربط الرسائل السابقة".
  const lastUserTurn = [...conversationHistory].reverse().find((m) => m.role === 'user');
  const searchTerms = extractSearchTerms(
    lastUserTurn ? `${lastUserTurn.text} ${customerMessage}` : customerMessage
  );

  let matchedProducts = [];
  if (searchTerms.length > 0) {
    const likeClauses = searchTerms.map(() => `(name LIKE ? OR description LIKE ?)`).join(' OR ');
    const likeBinds = [];
    searchTerms.forEach((t) => likeBinds.push(`%${t}%`, `%${t}%`));

    const matchedResult = await env.DB.prepare(
      `SELECT id, name, price, discount, currency, quantity
       FROM products
       WHERE merchant_id = ? AND is_available = 1 AND (${likeClauses})
       ORDER BY updated_at DESC
       LIMIT ?`
    )
      .bind(merchantId, ...likeBinds, MAX_PRODUCTS_IN_PROMPT)
      .all();
    matchedProducts = matchedResult.results || [];
  }

  const recentResult = await env.DB.prepare(
    `SELECT id, name, price, discount, currency, quantity
     FROM products
     WHERE merchant_id = ? AND is_available = 1
     ORDER BY updated_at DESC
     LIMIT ?`
  )
    .bind(merchantId, MAX_PRODUCTS_IN_PROMPT)
    .all();

  const seenIds = new Set();
  const relevantProducts = [];
  for (const p of [...matchedProducts, ...(recentResult.results || [])]) {
    if (seenIds.has(p.id)) continue;
    seenIds.add(p.id);
    relevantProducts.push(p);
    if (relevantProducts.length >= MAX_PRODUCTS_IN_PROMPT) break;
  }

  const systemPrompt = buildMasterSystemPrompt({
    storeName,
    botName: settingsRow.bot_name,
    tone: settingsRow.tone,
    customRules,
    products: relevantProducts,
  });

  // --- استدعاء نموذج الذكاء الاصطناعي (Gemini 3.6 Flash عبر fetch مباشر) ---
  let aiReplyText;
  try {
    if (!env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY غير مضبوط (نفّذ: wrangler secret put GEMINI_API_KEY)');
    }

    const geminiRes = await fetch(GEMINI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        // ⭐ نُرسل سجل المحادثة السابق (المُعقَّم) قبل رسالة العميل الحالية،
        // حتى يقدر النموذج يفهم السياق المتصل (مثل الإشارة لمنتج ذُكر قبل
        // رسالتين) بدل معاملة كل رسالة وكأنها محادثة جديدة تماماً.
        contents: [
          ...conversationHistory.map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] })),
          { role: 'user', parts: [{ text: customerMessage }] },
        ],
        // ⭐ إصلاح جوهري: Gemini 3.6 Flash نموذج "تفكير" (thinking model) بشكل
        // افتراضي، وحد الـ maxOutputTokens في REST API يُحسب مشتركاً بين
        // "توكنات التفكير الداخلي" و"نص الرد الفعلي" معاً. كان الحد القديم
        // (400) يُستهلك بالكامل تقريباً في التفكير الداخلي، فيخرج النموذج
        // برد فارغ أو مقطوع منتصف الكلمة (finishReason: MAX_TOKENS بدون نص،
        // أو نص ناقص) - وهذا بالضبط سبب "الأجوبة الناقصة/غير المفهومة".
        // الحل: خفض عمق التفكير لأدنى مستوى (المهمة هنا محادثة مبيعات بسيطة
        // لا تحتاج تفكيراً عميقاً) + رفع الحد الأقصى ليتسع لرد كامل مريح.
        generationConfig: {
          maxOutputTokens: 2048,
          thinkingConfig: { thinkingLevel: 'low' },
        },
      }),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text().catch(() => '');
      throw new Error(`Gemini HTTP ${geminiRes.status}: ${errText.slice(0, 300)}`);
    }

    const geminiData = await geminiRes.json();
    // ⭐ نجمع كل أجزاء النص (parts) بدل الاكتفاء بالجزء الأول فقط، ونتجاهل أي
    // جزء يمثّل "تفكير داخلي" (thought: true) كطبقة دفاع إضافية - رغم أننا لا
    // نطلب إرجاع التفكير أصلاً (includeThoughts غير مفعّلة)، فبعض الردود قد
    // تحتوي أكثر من جزء نصي واحد.
    const parts = geminiData?.candidates?.[0]?.content?.parts || [];
    aiReplyText = parts
      .filter((p) => p && typeof p.text === 'string' && !p.thought)
      .map((p) => p.text)
      .join('')
      .trim();
  } catch (error) {
    // 🔍 تسجيل مؤقت لتشخيص سبب فشل استدعاء Gemini الفعلي - يظهر في
    // `wrangler tail` فقط (لا يُرسل للعميل، الرسالة العامة أدناه هي فقط اللي
    // يشوفها العميل، حفاظاً على عدم تسريب تفاصيل داخلية للطرف العام).
    console.error('❌ [ai_chat] فشل استدعاء Gemini API:', error && error.message, error);
    throw new HttpError('تعذّر الحصول على رد من المساعد الذكي حالياً، حاول لاحقاً.', 502);
  }

  if (!aiReplyText) {
    aiReplyText = 'عذراً، لم أستطع فهم طلبك، هل يمكنك إعادة صياغته؟';
  }

  // ⚠️ ملاحظة مهمة: هنا نُرجع نص "عادي" مُعقَّم فقط (بدون escapeHtml)، لأن
  // هذه الدالة تُستخدم من قناتين مختلفتين: ودجت الويب (يحتاج escapeHtml قبل
  // العرض بصفحة HTML) وواتساب (نص عادي، لو هربنا HTML هنا بيوصل للعميل حرفياً
  // "&amp;" بدل "&"). كل مستدعي يتحمل مسؤولية الهروب المناسب لقناته هو.
  const safeReply = sanitizePlainText(aiReplyText, 2000);

  return { reply: safeReply, bot_name: settingsRow.bot_name };
}

// --------------------------------------------------------
// مسار الدردشة العام الذي يستخدمه عملاء المتجر (بدون تسجيل دخول)
// --------------------------------------------------------
export async function aiChat({ request, env, ctx, body }) {
  const merchantId = String(body.merchant_id || '');
  if (!merchantId) throw new HttpError('معرّف المتجر مطلوب', 400);

  // 🚦 تحديد المعدل أولاً وقبل أي استعلام آخر - أرخص عملية ونوقف الهجوم مبكراً
  const clientIp = request.headers.get('CF-Connecting-IP') || '';
  await assertRateLimitOk(env, { merchantId, clientIp });

  // 🧼 تعقيم رسالة العميل قبل أي استخدام لها
  const customerMessage = sanitizeCustomerMessage(body.message);
  if (!customerMessage) throw new HttpError('الرسالة فارغة', 400);

  // 🧼 تعقيم سجل المحادثة السابق (اختياري) - يسمح للمساعد بربط الرسالة
  // الحالية بسياق ما قبلها بدل معاملة كل رسالة بمعزل تام عن سابقاتها
  const conversationHistory = sanitizeConversationHistory(body.history);

  const { reply, bot_name } = await generateAiReplyForMerchant({
    env,
    merchantId,
    customerMessage,
    conversationHistory,
  });

  // 🛡️ دفاع من الدرجة الثانية خاص بقناة الويب فقط: حتى لو التزم النموذج
  // بالتعليمات، نهرب أي HTML من رده قبل إرجاعه، لأن ودجت الدردشة يعرضه
  // داخل صفحة HTML بدون تعقيم إضافي.
  return { reply: escapeHtml(reply), bot_name: escapeHtml(bot_name) };
}
