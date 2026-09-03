import * as customerController from './controllers/customerController.js';
import * as productController from './controllers/productController.js';
import * as orderController from './controllers/orderController.js';
import * as storeController from './controllers/storeController.js';
import * as syncController from './controllers/syncController.js';
import * as aiAssistantController from './controllers/aiAssistantController.js'; // ⭐ إضافة: المساعد الذكي
import * as whatsappController from './controllers/whatsappController.js'; // ⭐ إضافة: ربط المساعد الذكي بواتساب
import * as storefrontBuilderController from './controllers/storefrontBuilderController.js'; // 🎨 إضافة: مصمم المتجر
import { ROLES } from './config/constants.js';

// ========================================================
// 🗺️ جدول الأفعال المركزي (Action Registry)
// كل action مربوط بـ: الدالة المسؤولة + الأدوار المسموحة.
// إضافة action جديد = سطر واحد هنا + دالة بالـ controller المناسب.
// roles: [] تعني "أي مستخدم مسجّل دخول بغض النظر عن دوره".
// public: true تعني "لا يتطلب تسجيل دخول إطلاقاً".
// ========================================================
export const actionRegistry = {
  // 🛒 العميل
  add_to_cart: { handler: customerController.addToCart, roles: [ROLES.CUSTOMER] },
  get_cart: { handler: customerController.getCart, roles: [ROLES.CUSTOMER] },
  create_order: { handler: customerController.createOrder, roles: [ROLES.CUSTOMER] },
  // ⭐ إضافة (2026-07-21): منقولة من api.php لتكتمل هجرة مسار العميل للـ Worker
  check_customer_session: { handler: customerController.checkCustomerSession, roles: [ROLES.CUSTOMER] },
  verify_cart_live: { handler: customerController.verifyCartLive, roles: [ROLES.CUSTOMER] },
  get_user_orders: { handler: customerController.getUserOrders, roles: [ROLES.CUSTOMER] },

  // 🏪 المنتجات (تاجر فقط)
  save_product: { handler: productController.saveProduct, roles: [ROLES.MERCHANT] },
  list_products: { handler: productController.listProducts, roles: [ROLES.MERCHANT] },
  delete_product: { handler: productController.deleteProduct, roles: [ROLES.MERCHANT] },
  toggle_availability: { handler: productController.toggleAvailability, roles: [ROLES.MERCHANT] },

  // 📦 الطلبات (تاجر فقط)
  get_merchant_orders: { handler: orderController.getMerchantOrders, roles: [ROLES.MERCHANT] },
  update_order_status: { handler: orderController.updateOrderStatus, roles: [ROLES.MERCHANT] },
  // ⭐ إضافة: نقل دورة حياة الطلب كاملة إلى الـ Worker (بدل merchant_approve_order /
  // merchant_update_order_status / merchant_cancel_order / merchant_confirm_delivery_code
  // و get_orders بـ api.php).
  get_orders: { handler: orderController.getOrders, roles: [ROLES.MERCHANT] },
  cancel_order: { handler: orderController.cancelOrder, roles: [ROLES.MERCHANT] },
  confirm_delivery_code: { handler: orderController.confirmDeliveryCode, roles: [ROLES.MERCHANT] },
  // ⭐ إضافة: ترحيل get_stats من api.php القديم إلى الـ Worker - يقرأ من
  // sales_log مباشرة (باسم المنتج المخزَّن وقت البيع) بدل JOIN مع
  // products، عشان مبيعات المنتجات المحذوفة ما تختفي من الإحصائيات.
  get_stats: { handler: orderController.getStats, roles: [ROLES.MERCHANT] },

  // ⚙️ إعدادات المتجر
  get_merchant_settings: {
    handler: storeController.getMerchantSettings,
    roles: [ROLES.MERCHANT, ROLES.DELIVERY],
  },
  save_merchant_settings: { handler: storeController.saveMerchantSettings, roles: [ROLES.MERCHANT] },

  // 🤖 المساعد الذكي الخاص بكل تاجر (⭐ إضافة جديدة)
  // - get/save_ai_assistant_config: للتاجر فقط، عبر لوحة التاجر (JWT + دور MERCHANT)
  // - ai_chat: عام (public) - يستخدمه عميل المتجر من ودجت الدردشة بدون تسجيل دخول،
  //   ومحمي بدلاً من ذلك بتحديد المعدل (rate limiting) داخل الـ controller نفسه.
  get_ai_assistant_config: { handler: aiAssistantController.getAiAssistantConfig, roles: [ROLES.MERCHANT] },
  save_ai_assistant_config: { handler: aiAssistantController.saveAiAssistantConfig, roles: [ROLES.MERCHANT] },
  ai_chat: { handler: aiAssistantController.aiChat, roles: [], public: true },

  // 📱 ربط المساعد الذكي بواتساب (تاجر فقط، لوحة التاجر)
  // ⚠️ ملاحظة: استقبال رسائل واتساب الفعلية (الـ Webhook من Meta) لا يمر
  // من هنا إطلاقاً - له معالجة خاصة بمسار /webhooks/whatsapp داخل index.js
  get_whatsapp_config: { handler: whatsappController.getWhatsappConfig, roles: [ROLES.MERCHANT] },
  save_whatsapp_config: { handler: whatsappController.saveWhatsappConfig, roles: [ROLES.MERCHANT] },

  // 🎨 مصمم المتجر والتخصيص الكلي (Storefront Builder)
  get_storefront_config: { handler: storefrontBuilderController.getStorefrontConfig, roles: [], public: true },
  save_storefront_config: { handler: storefrontBuilderController.saveStorefrontConfig, roles: [ROLES.MERCHANT] },
  update_theme_config_file: { handler: storefrontBuilderController.saveStorefrontConfig, roles: [ROLES.MERCHANT] },
  get_storefront_themes: { handler: storefrontBuilderController.getStorefrontThemes, roles: [], public: true },

  // 🔄 عام / مزامنة
  sync_user: { handler: syncController.syncUser, roles: [], public: true },
  // ⭐ إضافة (2026-07-21): مزامنة داخلية من api.php - محمية بـ X-Internal-Key
  // وليس JWT، لذلك public:true (نفس نمط sync_user تماماً).
  sync_customer: { handler: syncController.syncCustomer, roles: [], public: true },
  // ⭐ إضافة: مزامنة عكسية لحالة التذكرة من api.php (نفس نمط sync_customer، محمي بمفتاح داخلي لا JWT)
  sync_ticket_status: { handler: syncController.syncTicketStatus, roles: [], public: true },
  save_fcm_token: { handler: syncController.saveFcmToken, roles: [] },
  get_firebase_config: { handler: syncController.getFirebaseConfig, roles: [] },
  get_categories_tree: { handler: syncController.getCategoriesTreeHandler, roles: [] },
  get_public_products: { handler: syncController.getPublicProducts, roles: [], public: true },
};
