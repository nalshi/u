import { HttpError } from '../security/rbac.js';
import {
  DEFAULT_STOREFRONT_CONFIG,
  THEME_PRESETS,
  TIER_LIMITS,
  STORE_TIERS,
  sanitizeStorefrontConfig,
} from '../config/storefrontConfigSchema.js';
import { syncStorefrontConfigToGitHub } from '../services/store/storefrontConfigSyncService.js';

// ========================================================
// 🎨 تحكم مصمم المتجر (Storefront Builder Controller)
// ========================================================

/**
 * جلب تكوين المتجر المخصص
 * متاح للتاجر أو لزوار المتجر عبر username / store_id
 */
export async function getStorefrontConfig({ env, user, body }) {
  let targetUserId = user?.user_id;
  let targetUsername = user?.username || body?.username;

  if (body?.merchant_id || body?.store_id) {
    targetUserId = Number(body.merchant_id || body.store_id);
  }

  let row = null;
  if (targetUserId) {
    row = await env.DB.prepare(
      `SELECT id, username, store_name, store_type, settings, storefront_config, plan_type FROM users WHERE id = ?`
    )
      .bind(targetUserId)
      .first()
      .catch(async () => {
        // Fallback في حال لم يُضف عمود storefront_config أو plan_type بعد
        return await env.DB.prepare(
          `SELECT id, username, store_name, store_type, settings FROM users WHERE id = ?`
        )
          .bind(targetUserId)
          .first();
      });
  } else if (targetUsername) {
    row = await env.DB.prepare(
      `SELECT id, username, store_name, store_type, settings, storefront_config, plan_type FROM users WHERE username = ?`
    )
      .bind(targetUsername)
      .first()
      .catch(async () => {
        return await env.DB.prepare(
          `SELECT id, username, store_name, store_type, settings FROM users WHERE username = ?`
        )
          .bind(targetUsername)
          .first();
      });
  }

  let userTier = STORE_TIERS.FREE;
  let savedConfig = null;

  if (row) {
    let settingsObj = {};
    try {
      settingsObj = row.settings ? JSON.parse(row.settings) : {};
    } catch (e) {
      settingsObj = {};
    }

    userTier = row.plan_type || settingsObj.plan_type || settingsObj.tier || STORE_TIERS.FREE;

    if (row.storefront_config) {
      try {
        savedConfig = typeof row.storefront_config === 'string'
          ? JSON.parse(row.storefront_config)
          : row.storefront_config;
      } catch (e) {
        savedConfig = null;
      }
    }
  }

  // دمج التكوين المحفوظ مع الافتراضي لضمان اكتمال كل الحقول
  const activeConfig = savedConfig || DEFAULT_STOREFRONT_CONFIG;
  const { sanitizedConfig } = sanitizeStorefrontConfig(activeConfig, userTier);

  // الحفاظ على updated_at الأصلي المحفوظ في D1 (sanitizeStorefrontConfig يولّد توقيتاً جديداً نتجنّبه هنا)
  if (activeConfig.updated_at) {
    sanitizedConfig.updated_at = activeConfig.updated_at;
  }

  return {
    data: {
      config: sanitizedConfig,
      tier: userTier,
      tier_limits: TIER_LIMITS[userTier] || TIER_LIMITS[STORE_TIERS.FREE],
      store_info: row
        ? {
            id: row.id,
            username: row.username,
            store_name: row.store_name,
            store_type: row.store_type,
          }
        : null,
    },
  };
}

/**
 * حفظ التخصيص الجديد للمتجر (تاجر مسجّل فقط)
 */
export async function saveStorefrontConfig({ env, ctx, user, body }) {
  if (!user || !user.user_id) {
    throw new HttpError('غير مصرح', 401);
  }

  const rawConfig = body.config;
  if (!rawConfig || typeof rawConfig !== 'object') {
    throw new HttpError('بيانات التخصيص (config) غير صالحة أو مفقودة.', 400);
  }

  // معرفة باقة التاجر الحالية
  const userRow = await env.DB.prepare(`SELECT id, username, settings, plan_type FROM users WHERE id = ?`)
    .bind(user.user_id)
    .first()
    .catch(async () => {
      return await env.DB.prepare(`SELECT id, username, settings FROM users WHERE id = ?`)
        .bind(user.user_id)
        .first();
    });

  if (!userRow) {
    throw new HttpError('المستخدم غير موجود', 404);
  }

  let settingsObj = {};
  try {
    settingsObj = userRow.settings ? JSON.parse(userRow.settings) : {};
  } catch (e) {
    settingsObj = {};
  }

  const userTier = userRow.plan_type || settingsObj.plan_type || settingsObj.tier || STORE_TIERS.FREE;

  // فحص وتنقية التكوين وتطبيق قواعد الباقة
  const { sanitizedConfig, notices } = sanitizeStorefrontConfig(rawConfig, userTier);
  const configJson = JSON.stringify(sanitizedConfig);

  // تحديث قاعدة البيانات D1
  try {
    await env.DB.prepare(`UPDATE users SET storefront_config = ? WHERE id = ?`)
      .bind(configJson, user.user_id)
      .run();
  } catch (dbErr) {
    // إذا لم يكن العمود موجوداً بعد، نخزنه مؤقتاً داخل حقل settings كـ fallback آمن
    settingsObj.storefront_config = sanitizedConfig;
    await env.DB.prepare(`UPDATE users SET settings = ? WHERE id = ?`)
      .bind(JSON.stringify(settingsObj), user.user_id)
      .run();
  }

  // مزامنة اسم المتجر في قاعدة البيانات إن تم تعديله من الاستوديو
  if (sanitizedConfig?.store_identity?.store_name) {
    try {
      await env.DB.prepare(`UPDATE users SET store_name = ? WHERE id = ?`)
        .bind(sanitizedConfig.store_identity.store_name, user.user_id)
        .run();
    } catch (e) {}
  }

  // مزامنة GitHub و Cloudflare Cache والمانيفست
  const syncPromise = syncStorefrontConfigToGitHub(env, userRow.username, sanitizedConfig, userRow);
  if (ctx && ctx.waitUntil) {
    ctx.waitUntil(syncPromise);
  } else {
    syncPromise.catch((err) => console.error('Storefront direct sync error:', err));
  }

  let message = 'تم حفظ ونشر تصميم المتجر بنجاح 🎨';
  if (notices.length > 0) {
    message += ` (ملاحظة: ${notices[0]})`;
  }

  return {
    message,
    status: 'success',
    notices,
    config: sanitizedConfig,
    tier: userTier,
  };
}

/**
 * جلب قائمة الثيمات الجاهزة
 */
export async function getStorefrontThemes() {
  return {
    data: {
      themes: THEME_PRESETS,
    },
  };
}
