// ========================================================
// 🔄 مزامنة إعدادات التاجر مع النظام القديم (api.php / TiDB)
// موجودة كموديول مستقل حتى تقدر تحذفها بسهولة يوم يصير
// الانتقال الكامل لـ D1 بدون أي اعتماد على api.php
// ========================================================

export async function syncMerchantSettingsToLegacyApi(env, merchantId, storeName, storeType, settingsJson) {
  try {
    if (!env.API_PHP_URL || !env.INTERNAL_SYNC_KEY) return;
    await fetch(env.API_PHP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Key': env.INTERNAL_SYNC_KEY },
      body: JSON.stringify({
        action: 'worker_sync_settings',
        id: merchantId,
        store_name: storeName,
        store_type: storeType,
        settings: settingsJson,
      }),
    });
  } catch (e) {
    console.error('TiDB write-through failed:', e);
  }
}

// ⭐ إضافة: مزامنة التذكرة (طلب جديد أو مدموج) إلى TiDB القديمة فوراً بعد إنشائها/تحديثها
// في D1، حتى يقدر نظام موافقة/رفض/تحديث حالة الطلب في api.php (وتطبيقا المندوب والزبون
// اللذان لا يزالان يقرآن من TiDB مباشرة) يشوفوها فوراً. best-effort ولا توقف إنشاء الطلب.
export async function syncNewOrderToLegacyApi(env, ticket) {
  try {
    if (!env.API_PHP_URL || !env.INTERNAL_SYNC_KEY) return;
    await fetch(env.API_PHP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Key': env.INTERNAL_SYNC_KEY },
      body: JSON.stringify({
        action: 'worker_sync_new_order',
        ticket_id: ticket.ticket_id,
        order_group_id: ticket.order_group_id,
        merchant_id: ticket.merchant_id,
        customer_id: ticket.customer_id,
        status: ticket.status,
        delivery_code: ticket.delivery_code,
        ticket_data: ticket.ticket_data,
      }),
    });
  } catch (e) {
    console.error('TiDB order write-through failed:', e);
  }
}
