// ========================================================
// 📨 طبقة الردود الموحدة + CORS ديناميكي
// ========================================================

// ⚠️ أمان: بدل ما يكون Access-Control-Allow-Origin ثابت على '*' لكل الحالات،
// نقرأ قائمة الدومينات المسموحة من env.ALLOWED_ORIGINS (مفصولة بفواصل).
// لو ما ضُبطت بعد، نرجع لسلوك '*' القديم مؤقتاً حتى لا ينكسر شيء بالتطوير.
export function buildCorsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const allowOrigin =
    allowed.length === 0 ? '*' : allowed.includes(origin) ? origin : allowed[0];

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Internal-Key',
    Vary: 'Origin',
  };
}

export function jsonResponse(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

export function successResponse(data = {}, corsHeaders, status = 200) {
  return jsonResponse({ status: 'success', ...data }, status, corsHeaders);
}

export function errorResponse(message, corsHeaders, status = 400) {
  return jsonResponse({ status: 'error', message }, status, corsHeaders);
}
