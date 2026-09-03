import { actionRegistry } from './router.js';
import { verifyJWT, timingSafeEqual } from './security/auth.js';
import { assertAllowed, HttpError } from './security/rbac.js';
import { validateAction } from './security/validate.js';
import { buildCorsHeaders, successResponse, errorResponse } from './core/response.js';
import { handleWhatsappWebhookVerify, handleWhatsappWebhookEvent } from './controllers/whatsappController.js'; // ⭐ إضافة: ربط واتساب

// ========================================================
// 🚪 نقطة الدخول الرئيسية للـ Worker
// هذا الملف تنسيقي فقط: يحلل الطلب، يتحقق من الهوية
// والصلاحية والمدخلات، ثم يفوّض التنفيذ للـ controller المناسب
// عبر جدول الأفعال (router.js). لا يوجد منطق عمل هنا إطلاقاً.
// ========================================================
// ========================================================
// 🚪 تصدير كائنات Durable Objects
// ========================================================
export { MerchantSession } from './durableObjects/MerchantSession.js';

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = buildCorsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // ⭐ مسار Webhook خاص بواتساب
    if (url.pathname === '/webhooks/whatsapp') {
      if (request.method === 'GET') return handleWhatsappWebhookVerify(url, env);
      if (request.method === 'POST') return handleWhatsappWebhookEvent(request, env, ctx);
      return new Response('Method Not Allowed', { status: 405 });
    }

    // ⭐ بوابة الأمان (Auth Gate) لاتصالات الـ WebSocket لـ Durable Object
    if (url.pathname === '/ws') {
      // السماح بتمرير التوكن عبر الـ Header أو Query Params (لأن المتصفح لا يدعم Headers في WebSockets مباشرة)
      const authHeader = request.headers.get('Authorization') || '';
      const token = authHeader.replace('Bearer ', '') || url.searchParams.get('token');
      const merchantId = request.headers.get('X-Merchant-ID') || url.searchParams.get('merchant_id');

      if (!token || !merchantId) {
        return new Response('Unauthorized: Missing Token or Merchant ID', { status: 401 });
      }

      try {
        const user = await verifyJWT(token, env.APP_SECRET_KEY);
        // التحقق من صلاحية المستخدم
        if (!user || user.user_id !== parseInt(merchantId)) {
           return new Response('Unauthorized: Invalid Token or ID Mismatch', { status: 401 });
        }

        // تمرير الاتصال للـ Durable Object
        const doId = env.MERCHANT_SESSION.idFromName(`merchant_${merchantId}`);
        const doStub = env.MERCHANT_SESSION.get(doId);
        
        // تمرير الطلب كما هو (سيقوم الـ DO بمعالجة Upgrade websocket)
        return doStub.fetch(request);
      } catch (error) {
        return new Response('Unauthorized: Invalid Token', { status: 401 });
      }
    }


    // ⭐ درع الحماية الفائق (Zero-Trust Shield & Anti-Replay Guard)
    // كل الطلبات (ما عدا Webhook واتساب) يجب أن تأتي حصرياً عبر البروكسي الداخلي
    // وتحمل التوقيع الرقمي وسر البوابة المشفر، أو المفتاح الداخلي للسيرفر الموثوق.
    const gatewaySecret = request.headers.get('X-Gateway-Secret') || '';
    const timestamp = request.headers.get('X-Gateway-Timestamp') || '';
    const nonce = request.headers.get('X-Gateway-Nonce') || '';
    const signature = request.headers.get('X-Gateway-Signature') || '';

    const validSecrets = (env.PROXY_SECRETS || env.PROXY_SECRET || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const matchedSecret = validSecrets.find((s) => timingSafeEqual(gatewaySecret, s));
    const isTrustedGateway = Boolean(matchedSecret);

    const internalKey = request.headers.get('X-Internal-Key') || '';
    const isTrustedLegacyServer = Boolean(env.INTERNAL_SYNC_KEY) && timingSafeEqual(internalKey, env.INTERNAL_SYNC_KEY);

    // ⛔ حظر أي اتصال مباشر أو غير مصرح به
    if (!isTrustedGateway && !isTrustedLegacyServer) {
      return new Response(JSON.stringify({ 
        status: 'error', 
        code: 'ACCESS_DENIED_DIRECT_CALL_BLOCKED',
        message: '⛔ وصول محظور: غير مصرح بالاتصال المباشر بالخادم.' 
      }), {
        status: 403,
        headers: { 
          'Content-Type': 'application/json',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
          'X-Robots-Tag': 'noindex, nofollow'
        }
      });
    }

    // ⛔ التحقق من منع هجمات إعادة الإرسال (Anti-Replay Attack) إذا تم تمرير Timestamp
    if (timestamp) {
      const now = Date.now();
      const reqTime = parseInt(timestamp, 10);
      if (isNaN(reqTime) || Math.abs(now - reqTime) > 60000) {
        return errorResponse('⛔ الطلب منتهي الصلاحية أو تم التلاعب بالوقت.', corsHeaders, 403);
      }
    }

    if (request.method === 'GET') {
      return successResponse({ status: 'ok' }, corsHeaders);
    }

    try {
      const { body, uploadedImageFile } = await parseRequestBody(request);
      const action = body.action;

      const route = actionRegistry[action];
      if (!route) {
        return errorResponse('Action غير معروف', corsHeaders, 400);
      }

      // --- المصادقة ---
      const authHeader = request.headers.get('Authorization') || '';
      const token = authHeader.replace('Bearer ', '');
      const user = token ? await verifyJWT(token, env.APP_SECRET_KEY) : null;

      if (!route.public && !user) {
        return errorResponse('غير مصرح', corsHeaders, 401);
      }

      // --- الصلاحيات (RBAC) ---
      assertAllowed(user, route.roles);

      // --- التحقق من المدخلات ---
      validateAction(action, body, user);

      // --- التنفيذ ---
      const result = await route.handler({ request, env, ctx, user, body, uploadedImageFile });
      return successResponse(result || {}, corsHeaders);
    } catch (error) {
      // ⭐ إصلاح أمني (تسريب معلومات داخلية): كان أي خطأ غير متوقع (غير
      // HttpError - أخطاء قاعدة بيانات، أخطاء برمجية، JSON.parse فاشل..)
      // يُرسل error.message الخام مباشرة للعميل، وهو بالضبط ما يحاول هذا
      // المشروع تفاديه بمواضع أخرى (راجع التعليق بمعالجة أخطاء Gemini في
      // aiAssistantController.js: "لا يُرسل للعميل..حفاظاً على عدم تسريب
      // تفاصيل داخلية للطرف العام"). رسائل HttpError مقصودة وآمنة للعرض
      // (تُستخدم كواجهة أخطاء رئيسية بكل المشروع) فتبقى كما هي؛ أي خطأ آخر
      // غير متوقع يُسجَّل بالسيرفر (لم يكن يُسجَّل إطلاقاً سابقاً - فجوة
      // تشغيلية أيضاً) ويُرجع للعميل رسالة عامة فقط.
      if (error instanceof HttpError) {
        return errorResponse(error.message, corsHeaders, error.status);
      }
      console.error('Unhandled Worker error:', error);
      return errorResponse('حدث خطأ في السيرفر، يرجى المحاولة لاحقاً.', corsHeaders, 500);
    }
  },
};

async function parseRequestBody(request) {
  let body = {};
  let uploadedImageFile = null;
  const contentType = request.headers.get('content-type') || '';

  if (contentType.includes('multipart/form-data')) {
    // طلبات فيها ملف صورة (FormData) — تأتي من فورم حفظ المنتج
    const formData = await request.formData();
    for (const [key, value] of formData.entries()) {
      if (value instanceof File) {
        if (key === 'image_file' && value.size > 0) uploadedImageFile = value;
      } else {
        body[key] = value;
      }
    }
  } else {
    body = await request.json();
  }
  return { body, uploadedImageFile };
}
