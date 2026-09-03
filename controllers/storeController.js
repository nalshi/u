import { HttpError } from '../security/rbac.js';
import { syncMerchantSettingsToLegacyApi } from '../services/legacySync/tidbSyncService.js';
import { syncStoreInfoToStorefront } from '../services/store/storeInfoSyncService.js';

// ========================================================
// ⚙️ تحكم إعدادات المتجر (اسم المتجر / السياسات)
// ========================================================

export async function getMerchantSettings({ env, user }) {
  const row = await env.DB.prepare(
    `SELECT id, username, store_name, phone, store_type, settings, created_at FROM users WHERE id = ?`
  )
    .bind(user.user_id)
    .first();
  if (!row) throw new HttpError('لم يتم العثور على بيانات الحساب.', 404);

  let settingsObj = {};
  try {
    settingsObj = row.settings ? JSON.parse(row.settings) : {};
  } catch (e) {
    settingsObj = {};
  }

  return {
    data: {
      ...row,
      settings: settingsObj,
      is_first_login: !row.store_name || row.store_name === row.username,
      data_fetched_at: Math.floor(Date.now() / 1000),
    },
  };
}

export async function saveMerchantSettings({ env, ctx, user, body }) {
  const storeName = (body.storeName || '').trim();
  const storeType = body.storeType || null;
  let newSettings;
  try {
    newSettings = typeof body.settings === 'string' ? JSON.parse(body.settings || '{}') : body.settings || {};
  } catch (e) {
    throw new HttpError('صيغة الإعدادات (settings) غير صالحة.', 400);
  }
  if (!storeName) throw new HttpError('اسم المتجر مطلوب ولا يمكن أن يكون فارغاً.', 400);

  const current = await env.DB.prepare(`SELECT settings, store_type, phone FROM users WHERE id = ?`)
    .bind(user.user_id)
    .first();
  let currentSettings = {};
  try {
    currentSettings = current?.settings ? JSON.parse(current.settings) : {};
  } catch (e) {
    currentSettings = {};
  }

  // فحص أمني: منع تغيير سياسة الشحن إن كان هناك طلبات نشطة حالياً
  const shippingChanged = ['free_shipping_enabled', 'free_shipping_type', 'free_shipping_threshold'].some(
    (k) => k in newSettings && newSettings[k] != (currentSettings[k] ?? null)
  );
  if (shippingChanged) {
    const activeCount = await env.DB.prepare(`SELECT COUNT(*) as c FROM live_tickets WHERE merchant_id = ?`)
      .bind(user.user_id)
      .first();
    if (activeCount && activeCount.c > 0) {
      throw new HttpError(
        `عذراً، لا يمكن تغيير سياسة التوصيل حالياً بسبب وجود ${activeCount.c} طلبات نشطة قيد التنفيذ.`,
        409
      );
    }
  }

  const finalSettings = { ...currentSettings, ...newSettings };
  if (!finalSettings.location) finalSettings.location = currentSettings.location || null;
  if (!finalSettings.phone) finalSettings.phone = currentSettings.phone || current?.phone || null;
  const finalStoreType = storeType || current?.store_type || null;
  const settingsJson = JSON.stringify(finalSettings);

  await env.DB.prepare(`UPDATE users SET store_name = ?, store_type = ?, settings = ? WHERE id = ?`)
    .bind(storeName, finalStoreType, settingsJson, user.user_id)
    .run();

  // ⚡ رد فوري للتاجر من D1، ثم مزامنة TiDB في الخلفية (لتطبيقي المندوب والإدارة)
  ctx.waitUntil(syncMerchantSettingsToLegacyApi(env, user.user_id, storeName, finalStoreType, settingsJson));

  // 🐙 رفع معلومات المتجر (info.json) إلى GitHub في الخلفية لتحديث واجهة المتجر العامة
  ctx.waitUntil(
    syncStoreInfoToStorefront(env, user.username, {
      id: user.user_id,
      store_name: storeName,
      store_type: finalStoreType,
      phone: finalSettings.phone,
      settings: finalSettings,
    })
  );

  // ⭐ تحديث الـ Durable Object للإعدادات
  if (env.MERCHANT_SESSION) {
    try {
      const doId = env.MERCHANT_SESSION.idFromName(`merchant_${user.user_id}`);
      const doStub = env.MERCHANT_SESSION.get(doId);
      ctx.waitUntil(
        doStub.fetch('http://internal/sync-settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings: finalSettings })
        })
      );
    } catch (err) {
      console.error('Failed to sync settings to DO:', err);
    }
  }

  return { message: 'تم حفظ الإعدادات وتحديث المتجر بنجاح ✅', updated_settings: finalSettings };
}
