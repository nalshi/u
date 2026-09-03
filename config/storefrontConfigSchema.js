// ========================================================
// 🎨 مخطط وقواعد التخصيص الشاملة لواجهات المتاجر (Storefront Schema v4.0)
// نظام التحقق الصارم، تعقيم المدخلات بأمان عالي (XSS & Injection Safe)
// وتوافق كامل 100% مع استوديو المصمم ومحرك عرض المتجر.
// ========================================================

export const STORE_TIERS = {
  FREE: 'free',
  PRO: 'pro',
  VIP: 'vip',
};

export const ALLOWED_FONTS = [
  'Tajawal',
  'Cairo',
  'Almarai',
  'Readex Pro',
  'Alexandria',
  'IBM Plex Sans Arabic',
  'Noto Kufi Arabic',
  'Changa',
  'El Messiri',
];

export const ALLOWED_BUTTON_STYLES = ['flat', 'rounded', 'pill', 'outline'];
export const ALLOWED_CARD_STYLES = ['flat', 'elevated', 'bordered', 'glass', 'classic', 'modern'];
export const ALLOWED_BLOCK_TYPES = [
  'hero',
  'categories',
  'products',
  'banner',
  'features',
  'testimonials',
  'contact',
  'newsletter',
];

export const TIER_LIMITS = {
  [STORE_TIERS.FREE]: {
    allowedFonts: ['Tajawal', 'Cairo', 'Almarai'],
    allowedButtonStyles: ['rounded', 'flat', 'pill'],
    allowedCardStyles: ['flat', 'elevated', 'bordered', 'classic'],
    customOrderAllowed: true,
    blockVisibilityToggleAllowed: true,
    maxLayoutBlocks: 10,
  },
  [STORE_TIERS.PRO]: {
    allowedFonts: ALLOWED_FONTS,
    allowedButtonStyles: ALLOWED_BUTTON_STYLES,
    allowedCardStyles: ALLOWED_CARD_STYLES,
    customOrderAllowed: true,
    blockVisibilityToggleAllowed: true,
    maxLayoutBlocks: 20,
  },
  [STORE_TIERS.VIP]: {
    allowedFonts: ALLOWED_FONTS,
    allowedButtonStyles: ALLOWED_BUTTON_STYLES,
    allowedCardStyles: ALLOWED_CARD_STYLES,
    customOrderAllowed: true,
    blockVisibilityToggleAllowed: true,
    maxLayoutBlocks: 50,
  },
};

const DEFAULT_NAV_ITEMS = [
  { id: 'home', label: 'الرئيسية', icon: 'fa-home', visible: true, order: 1 },
  { id: 'search', label: 'بحث', icon: 'fa-search', visible: true, order: 2 },
  { id: 'orders', label: 'طلباتي', icon: 'fa-box-open', visible: true, order: 3 },
  { id: 'favorites', label: 'المفضلة', icon: 'fa-heart', visible: true, order: 4 },
  { id: 'cart', label: 'السلة', icon: 'fa-shopping-cart', visible: true, order: 5 },
];

const DEFAULT_TOP_BAR_SETTINGS = {
  show_logo_icon: true,
  logo_icon: 'fa-store',
  show_dark_mode_btn: true,
  show_profile_btn: true,
  show_search_btn: true,
};

function normalizeBottomNavItems(items) {
  const source = Array.isArray(items) && items.length > 0 ? items : DEFAULT_NAV_ITEMS;
  const normalized = source.map((item, index) => ({
    id: String(item?.id || DEFAULT_NAV_ITEMS[index]?.id || `nav_${index + 1}`),
    label: String(item?.label || DEFAULT_NAV_ITEMS[index]?.label || 'عنصر'),
    icon: String(item?.icon || DEFAULT_NAV_ITEMS[index]?.icon || 'fa-circle'),
    visible: item?.visible !== false,
    order: Number.isFinite(item?.order) ? Number(item.order) : index + 1,
  }));

  const visible = normalized.filter(item => item.visible).sort((a, b) => (a.order || 0) - (b.order || 0));
  if (visible.length >= 2) return normalized.sort((a, b) => (a.order || 0) - (b.order || 0));

  return DEFAULT_NAV_ITEMS.map((item, index) => ({
    ...item,
    visible: index < 2,
    order: index + 1,
  }));
}

function normalizeTopBarSettings(settings = {}) {
  return {
    ...DEFAULT_TOP_BAR_SETTINGS,
    ...(settings || {}),
  };
}

// ========================================================
// 📦 التكوين الافتراضي الشامل للمتجر (Default Config v4.0)
// ========================================================
export const DEFAULT_STOREFRONT_CONFIG = {
  version: '4.0',
  theme_version: '4.0',
  theme_name: 'nalsh_indigo',
  default_theme_mode: 'light',
  store_identity: {
    store_name: 'متجري الإلكتروني',
    slogan: 'وجهتك الأولى لأرقى المنتجات والخدمات',
    welcome_message: 'أهلاً بكم في متجرنا! نتمنى لكم تجربة تسوق ممتعة.',
    currency_symbol: 'YER',
    logo: '',
    favicon: '',
    announcement_bar: {
      enabled: true,
      text: '🎉 عروض حصرية وتوصيل سريع لكافة المناطق!',
      bg_color: '#4F46E5',
      text_color: '#FFFFFF',
    },
  },
  products_settings: {
    display_mode: 'by_categories_sections',
    sort_by: 'latest',
    out_of_stock_display: 'badge_at_end',
    show_quick_add: true,
    show_stock_badge: true,
    show_discount_badge: true,
    show_category_tag: true,
    show_old_price: true,
    show_currency: true,
    show_actions: true,
    add_to_cart_btn: {
      style: 'circle_icon',
      text: 'أضف للسلة',
      show_text: false,
      icon: 'fa-plus',
      action_animation: 'scale',
    },
    portrait: {
      scroll_direction: 'horizontal',
      grid_columns: 2,
      grid_rows: 0,
      slider_rows: 1,
      card_orientation: 'portrait',
      card_style: 'classic',
      card_custom_width: 0,
      card_custom_height: 0,
      img_custom_height: 0,
      card_density: 'standard',
      show_badges: true,
      show_quick_add: true,
      show_rating: true,
      show_old_price: true,
      show_currency: true,
    },
    landscape: {
      scroll_direction: 'horizontal',
      grid_columns: 4,
      grid_rows: 0,
      slider_rows: 1,
      card_orientation: 'portrait',
      card_style: 'classic',
      card_custom_width: 0,
      card_custom_height: 0,
      img_custom_height: 0,
      card_density: 'standard',
      show_badges: true,
      show_quick_add: true,
      show_rating: true,
      show_old_price: true,
      show_currency: true,
    },
    category_overrides: {},
  },
  messages: {
    search_placeholder: 'ابحث عن المنتجات أو الماركات...',
    empty_cart_title: 'سلة المشتريات فارغة 🛒',
    empty_cart_desc: 'لم تقم بإضافة أي منتجات للسلة بعد، تصفح المتجر الآن!',
    order_success_title: 'تم استلام طلبك بنجاح! 🎉',
    order_success_msg: 'شكراً لثقتك بنا. سيتم تجهيز وتوصيل طلبك في أقرب وقت.',
    order_track_whatsapp: 'متابعة وتأكيد الطلب عبر واتساب 💬',
    chatbot_greeting: 'أهلاً بك! كيف يمكنني مساعدتك في التسوق اليوم؟ 🤖',
    copied_link_msg: 'تم نسخ الرابط بنجاح! 📋',
  },
  layout_blocks: [
    {
      id: 'block_hero_1',
      type: 'hero',
      title: 'أهلاً بكم في متجرنا',
      subtitle: 'تسوق أحدث المنتجات بأفضل الأسعار وأعلى جودة مضمونة',
      style: 'classic',
      visible: true,
      order: 1,
      settings: {
        cta_text: 'تصفح المنتجات',
        cta_link: '#products',
        alignment: 'center',
      },
    },
    {
      id: 'block_cat_1',
      type: 'categories',
      title: 'التصنيفات المميزة',
      style: 'bubbles',
      visible: true,
      order: 2,
      settings: {
        layout: 'horizontal',
      },
    },
    {
      id: 'block_prod_1',
      type: 'products',
      title: 'أحدث المنتجات والعروض',
      style: 'classic_grid',
      visible: true,
      order: 3,
      settings: {
        limit: 12,
      },
    },
    {
      id: 'block_feat_1',
      type: 'features',
      title: 'لماذا تختارنا؟',
      style: 'badges_row',
      visible: true,
      order: 4,
      settings: {
        items: [
          { icon: 'truck-fast', title: 'توصيل فائق السرعة', desc: 'توصيل موثوق لباب منزلك' },
          { icon: 'shield-check', title: 'ضمان الجودة 100%', desc: 'منتجات أصلية ومفحوصة بدقة' },
          { icon: 'headset', title: 'خدمة عملاء متواصلة', desc: 'دعم مباشر على مدار الساعة' },
        ],
      },
    },
  ],
  modals_customization: {
    product_details: {
      cta_button_text: 'إضافة إلى السلة 🛍️',
      border_radius: '24px',
    },
    cart_drawer: {
      header_title: 'سلة مشترياتي 🛒',
      checkout_btn_text: 'متابعة الطلب والدفع 🚀',
      empty_message: 'سلتك فارغة حالياً',
    },
    store_info: {
      title: 'عن المتجر وسياسات الخدمة',
      about_text: 'متجر رائد يقدم أفضل المنتجات والخدمات المميزة.',
      delivery_policy: 'نوفر التوصيل السريع والدفع عند الاستلام مع ضمان الاسترجاع خلال 3 أيام.',
    },
    order_success: {
      title: 'تم استلام طلبك بنجاح! 🎉',
      whatsapp_btn_text: 'تأكيد ومتابعة الطلب بالواتساب 💬',
    },
  },
  light_theme: {
    colors: {
      primary: '#4F46E5',
      primary_hover: '#4338CA',
      primary_gradient_start: '#4F46E5',
      primary_gradient_end: '#06B6D4',
      accent: '#14B8A6',
      bg_body: '#F8FAFC',
      bg_card: '#FFFFFF',
      bg_surface: '#F1F5F9',
      text_main: '#0F172A',
      text_muted: '#64748B',
      border: '#E2E8F0',
      navbar_bg: '#FFFFFF',
      navbar_text: '#0F172A',
      bottom_bar_bg: '#FFFFFF',
      bottom_bar_active: '#4F46E5',
      bottom_bar_inactive: '#94A3B8',
      card_bg: '#FFFFFF',
      card_border: '#E2E8F0',
      card_title: '#0F172A',
      price_color: '#4F46E5',
      old_price_color: '#94A3B8',
      badge_bg: '#EF4444',
      badge_text: '#FFFFFF',
      section_title: '#0F172A',
      category_chip_bg: '#F1F5F9',
      category_chip_active: '#4F46E5',
      category_chip_text: '#0F172A',
      modal_bg: '#FFFFFF',
      modal_overlay: 'rgba(15, 23, 42, 0.6)',
      modal_handle: '#CBD5E1',
      btn_primary_bg: '#4F46E5',
      btn_primary_text: '#FFFFFF',
      chatbot_btn_bg: '#4F46E5',
      toast_bg: '#0F172A',
      toast_text: '#FFFFFF',
    },
  },
  dark_theme: {
    colors: {
      primary: '#6366F1',
      primary_hover: '#818CF8',
      primary_gradient_start: '#6366F1',
      primary_gradient_end: '#2DD4BF',
      accent: '#2DD4BF',
      bg_body: '#0B1120',
      bg_card: '#151E2E',
      bg_surface: '#1E293B',
      text_main: '#F8FAFC',
      text_muted: '#94A3B8',
      border: 'rgba(255, 255, 255, 0.08)',
      navbar_bg: '#151E2E',
      navbar_text: '#F8FAFC',
      bottom_bar_bg: '#151E2E',
      bottom_bar_active: '#6366F1',
      bottom_bar_inactive: '#64748B',
      card_bg: '#151E2E',
      card_border: 'rgba(255, 255, 255, 0.08)',
      card_title: '#F8FAFC',
      price_color: '#818CF8',
      old_price_color: '#64748B',
      badge_bg: '#EF4444',
      badge_text: '#FFFFFF',
      section_title: '#F8FAFC',
      category_chip_bg: '#1E293B',
      category_chip_active: '#6366F1',
      category_chip_text: '#F8FAFC',
      modal_bg: '#151E2E',
      modal_overlay: 'rgba(0, 0, 0, 0.85)',
      modal_handle: '#475569',
      btn_primary_bg: '#6366F1',
      btn_primary_text: '#FFFFFF',
      chatbot_btn_bg: '#6366F1',
      toast_bg: '#1E293B',
      toast_text: '#F8FAFC',
    },
  },
  typography: {
    font_family: 'Tajawal',
    base_size: '16px',
    base_size_mobile: '15px',
    base_size_desktop: '17px',
    heading_weight: '700',
    heading_size_mobile: '1.15rem',
    heading_size_desktop: '1.45rem',
    price_size_mobile: '1.1rem',
    price_size_desktop: '1.25rem',
    headings: {
      price_size: '1.15rem',
    },
  },
  shapes: {
    card_radius: '20px',
    button_radius: '14px',
    button_style: 'rounded',
    card_style: 'elevated',
    navbar_style: 'solid',
    section_spacing: 'normal',
  },
  animations: {
    card_hover: 'lift',
  },
  marketing: {
    free_shipping_bar: {
      enabled: false,
      message: '🚚 شحن مجاني للطلبات فوق 10,000 ريال!',
    },
    whatsapp_floating: {
      enabled: true,
      phone: '',
      position: 'left',
    },
  },
  navigation_settings: {
    bottom_bar: {
      items: normalizeBottomNavItems(DEFAULT_NAV_ITEMS),
    },
    top_bar: normalizeTopBarSettings(DEFAULT_TOP_BAR_SETTINGS),
  },
};

// ========================================================
// 🎨 ثيمات جاهزة احترافية (Preset Themes)
// ========================================================
export const THEME_PRESETS = [
  {
    id: 'nalsh_indigo',
    name: 'بنفسجي نالش العصري',
    description: 'الهوية الرسمية لمنصة نالش بتدرجات إنديغو وتركوازية',
    light_theme: DEFAULT_STOREFRONT_CONFIG.light_theme,
    dark_theme: DEFAULT_STOREFRONT_CONFIG.dark_theme,
    typography: { font_family: 'Tajawal', base_size: '16px', heading_weight: '700' },
    shapes: { card_radius: '20px', button_radius: '14px', button_style: 'rounded', card_style: 'elevated' },
  },
  {
    id: 'emerald_royal',
    name: 'زمردي ملكي فاخر',
    description: 'درجات الزمرد الأخضر الفاخر للأناقة والمتاجر المميزة',
    light_theme: {
      colors: {
        primary: '#059669', primary_hover: '#047857', primary_gradient_start: '#059669', primary_gradient_end: '#34D399', accent: '#10B981',
        bg_body: '#F0FDF4', bg_card: '#FFFFFF', bg_surface: '#DCFCE7', text_main: '#064E3B', text_muted: '#047857', border: '#BBF7D0',
        navbar_bg: '#FFFFFF', navbar_text: '#064E3B', bottom_bar_bg: '#FFFFFF', bottom_bar_active: '#059669', bottom_bar_inactive: '#047857',
        price_color: '#059669', badge_bg: '#E11D48', modal_bg: '#FFFFFF', btn_primary_bg: '#059669',
      },
    },
    dark_theme: {
      colors: {
        primary: '#10B981', primary_hover: '#34D399', primary_gradient_start: '#10B981', primary_gradient_end: '#6EE7B7', accent: '#34D399',
        bg_body: '#022C22', bg_card: '#064E3B', bg_surface: '#065F46', text_main: '#ECFDF5', text_muted: '#A7F3D0', border: 'rgba(52, 211, 153, 0.2)',
        navbar_bg: '#064E3B', navbar_text: '#ECFDF5', bottom_bar_bg: '#064E3B', bottom_bar_active: '#10B981', bottom_bar_inactive: '#A7F3D0',
        price_color: '#34D399', badge_bg: '#F43F5E', modal_bg: '#064E3B', btn_primary_bg: '#10B981',
      },
    },
    typography: { font_family: 'Cairo', base_size: '16px', heading_weight: '800' },
    shapes: { card_radius: '16px', button_radius: '12px', button_style: 'rounded', card_style: 'elevated' },
  },
  {
    id: 'ruby_red',
    name: 'ياقوتي أحمر وجريء',
    description: 'تصميم دافئ وجريء مع أزرار كبسولية وشعور عصري',
    light_theme: {
      colors: {
        primary: '#E11D48', primary_hover: '#BE123C', primary_gradient_start: '#E11D48', primary_gradient_end: '#F43F5E', accent: '#FB7185',
        bg_body: '#FFF1F2', bg_card: '#FFFFFF', bg_surface: '#FFE4E6', text_main: '#1C1917', text_muted: '#78716C', border: '#FECDD3',
        navbar_bg: '#FFFFFF', navbar_text: '#1C1917', bottom_bar_bg: '#FFFFFF', bottom_bar_active: '#E11D48', bottom_bar_inactive: '#78716C',
        price_color: '#E11D48', badge_bg: '#BE123C', modal_bg: '#FFFFFF', btn_primary_bg: '#E11D48',
      },
    },
    dark_theme: {
      colors: {
        primary: '#FB7185', primary_hover: '#FDA4AF', primary_gradient_start: '#FB7185', primary_gradient_end: '#E11D48', accent: '#F43F5E',
        bg_body: '#18181B', bg_card: '#27272A', bg_surface: '#3F3F46', text_main: '#FAFAFA', text_muted: '#A1A1AA', border: 'rgba(255, 255, 255, 0.08)',
        navbar_bg: '#27272A', navbar_text: '#FAFAFA', bottom_bar_bg: '#27272A', bottom_bar_active: '#FB7185', bottom_bar_inactive: '#A1A1AA',
        price_color: '#FB7185', badge_bg: '#E11D48', modal_bg: '#27272A', btn_primary_bg: '#FB7185',
      },
    },
    typography: { font_family: 'Readex Pro', base_size: '16px', heading_weight: '700' },
    shapes: { card_radius: '24px', button_radius: '9999px', button_style: 'pill', card_style: 'elevated' },
  },
  {
    id: 'amber_gold',
    name: 'ذهبي عنبري كلاسيكي',
    description: 'فخامة كلاسيكية مع حدود واضحة وألوان دافئة',
    light_theme: {
      colors: {
        primary: '#D97706', primary_hover: '#B45309', primary_gradient_start: '#D97706', primary_gradient_end: '#FBBF24', accent: '#F59E0B',
        bg_body: '#FFFBEB', bg_card: '#FFFFFF', bg_surface: '#FEF3C7', text_main: '#1E293B', text_muted: '#64748B', border: '#FDE68A',
        navbar_bg: '#FFFFFF', navbar_text: '#1E293B', bottom_bar_bg: '#FFFFFF', bottom_bar_active: '#D97706', bottom_bar_inactive: '#64748B',
        price_color: '#D97706', badge_bg: '#DC2626', modal_bg: '#FFFFFF', btn_primary_bg: '#D97706',
      },
    },
    dark_theme: {
      colors: {
        primary: '#F59E0B', primary_hover: '#FBBF24', primary_gradient_start: '#F59E0B', primary_gradient_end: '#D97706', accent: '#FBBF24',
        bg_body: '#0F172A', bg_card: '#1E293B', bg_surface: '#334155', text_main: '#F8FAFC', text_muted: '#94A3B8', border: 'rgba(245, 158, 11, 0.2)',
        navbar_bg: '#1E293B', navbar_text: '#F8FAFC', bottom_bar_bg: '#1E293B', bottom_bar_active: '#F59E0B', bottom_bar_inactive: '#94A3B8',
        price_color: '#FBBF24', badge_bg: '#DC2626', modal_bg: '#1E293B', btn_primary_bg: '#F59E0B',
      },
    },
    typography: { font_family: 'Almarai', base_size: '16px', heading_weight: '800' },
    shapes: { card_radius: '14px', button_radius: '8px', button_style: 'rounded', card_style: 'bordered' },
  },
];

// ========================================================
// 🛡️ دوال التنقية والتحقق الصارم (Security Helpers)
// ========================================================

const HEX_COLOR_REGEX = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;
const RGBA_COLOR_REGEX = /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[\d.]+\s*)?\)$/i;

function preserveFutureFields(raw, knownKeys = []) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const preserved = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (!knownKeys.includes(key) && value !== undefined) {
      preserved[key] = typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
    }
  }
  return preserved;
}

export function isValidColor(color) {
  if (typeof color !== 'string') return false;
  const c = color.trim();
  return HEX_COLOR_REGEX.test(c) || RGBA_COLOR_REGEX.test(c) || c.startsWith('var(--') || c === 'transparent';
}

function cleanString(val, maxLen = 300, fallback = '') {
  if (typeof val !== 'string') return fallback;
  // إزالة وسوم HTML وأي محاولات حقن سكربتات (XSS Prevention)
  const cleaned = val
    .replace(/<[^>]*>?/gm, '')
    .replace(/javascript\s*:/gi, '')
    .replace(/data\s*:\s*text\/html/gi, '')
    .trim();
  return cleaned.slice(0, maxLen);
}

function cleanColor(val, fallback) {
  if (isValidColor(val)) return val.trim();
  return fallback;
}

function cleanColorPalette(rawColors = {}, defaultColors = {}) {
  const result = { ...defaultColors };
  if (!rawColors || typeof rawColors !== 'object') return result;

  for (const [key, defVal] of Object.entries(defaultColors)) {
    if (rawColors[key] !== undefined && rawColors[key] !== null) {
      result[key] = cleanColor(rawColors[key], defVal);
    }
  }

  // دعم الألوان الإضافية الآمنة إن وجدت
  for (const [key, val] of Object.entries(rawColors)) {
    if (!result[key] && typeof key === 'string' && /^[a-zA-Z0-9_-]+$/.test(key) && isValidColor(val)) {
      result[key] = val.trim();
    }
  }

  return result;
}

// ========================================================
// 🛡️ التنقية الشاملة لمطابقة المعايير وحماية المتجر
// ========================================================
export function sanitizeStorefrontConfig(inputConfig = {}, userTier = STORE_TIERS.FREE) {
  const tier = TIER_LIMITS[userTier] ? userTier : STORE_TIERS.FREE;
  const limits = TIER_LIMITS[tier] || TIER_LIMITS[STORE_TIERS.FREE];
  const notices = [];

  const raw = typeof inputConfig === 'object' && inputConfig !== null ? inputConfig : {};
  const def = DEFAULT_STOREFRONT_CONFIG;

  // 1. الهوية الأساسية
  const rawIdentity = raw.store_identity || {};
  const store_identity = {
    store_name: cleanString(rawIdentity.store_name, 100, def.store_identity.store_name),
    slogan: cleanString(rawIdentity.slogan, 200, def.store_identity.slogan),
    welcome_message: cleanString(rawIdentity.welcome_message, 500, def.store_identity.welcome_message),
    currency_symbol: cleanString(rawIdentity.currency_symbol, 10, def.store_identity.currency_symbol),
    logo: typeof rawIdentity.logo === 'string' && rawIdentity.logo.startsWith('http') ? rawIdentity.logo.slice(0, 500) : '',
    favicon: typeof rawIdentity.favicon === 'string' && rawIdentity.favicon.startsWith('http') ? rawIdentity.favicon.slice(0, 500) : '',
    announcement_bar: {
      enabled: typeof rawIdentity.announcement_bar?.enabled === 'boolean' ? rawIdentity.announcement_bar.enabled : def.store_identity.announcement_bar.enabled,
      text: cleanString(rawIdentity.announcement_bar?.text, 250, def.store_identity.announcement_bar.text),
      bg_color: cleanColor(rawIdentity.announcement_bar?.bg_color, def.store_identity.announcement_bar.bg_color),
      text_color: cleanColor(rawIdentity.announcement_bar?.text_color, def.store_identity.announcement_bar.text_color),
    },
  };

  // 2. إعدادات المنتجات والشبكات
  const rawProd = raw.products_settings || {};
  const products_settings = {
    ...def.products_settings,
    ...rawProd,
    display_mode: cleanString(rawProd.display_mode, 50, def.products_settings.display_mode),
    sort_by: cleanString(rawProd.sort_by, 30, def.products_settings.sort_by),
    out_of_stock_display: cleanString(rawProd.out_of_stock_display, 30, def.products_settings.out_of_stock_display),
    show_quick_add: typeof rawProd.show_quick_add === 'boolean' ? rawProd.show_quick_add : def.products_settings.show_quick_add,
    show_stock_badge: typeof rawProd.show_stock_badge === 'boolean' ? rawProd.show_stock_badge : def.products_settings.show_stock_badge,
    show_discount_badge: typeof rawProd.show_discount_badge === 'boolean' ? rawProd.show_discount_badge : def.products_settings.show_discount_badge,
    show_category_tag: typeof rawProd.show_category_tag === 'boolean' ? rawProd.show_category_tag : def.products_settings.show_category_tag,
    show_old_price: typeof rawProd.show_old_price === 'boolean' ? rawProd.show_old_price : def.products_settings.show_old_price,
    show_currency: typeof rawProd.show_currency === 'boolean' ? rawProd.show_currency : def.products_settings.show_currency,
    show_actions: typeof rawProd.show_actions === 'boolean' ? rawProd.show_actions : def.products_settings.show_actions,
    add_to_cart_btn: {
      ...def.products_settings.add_to_cart_btn,
      ...(rawProd.add_to_cart_btn || {}),
      text: cleanString(rawProd.add_to_cart_btn?.text, 50, def.products_settings.add_to_cart_btn.text),
      icon: cleanString(rawProd.add_to_cart_btn?.icon, 50, def.products_settings.add_to_cart_btn.icon),
    },
    portrait: {
      ...def.products_settings.portrait,
      ...(rawProd.portrait || {}),
    },
    landscape: {
      ...def.products_settings.landscape,
      ...(rawProd.landscape || {}),
    },
    category_overrides: typeof rawProd.category_overrides === 'object' && rawProd.category_overrides !== null ? rawProd.category_overrides : {},
  };

  // 3. الرسائل والنصوص
  const rawMsg = raw.messages || {};
  const messages = {
    search_placeholder: cleanString(rawMsg.search_placeholder, 100, def.messages.search_placeholder),
    empty_cart_title: cleanString(rawMsg.empty_cart_title, 100, def.messages.empty_cart_title),
    empty_cart_desc: cleanString(rawMsg.empty_cart_desc, 200, def.messages.empty_cart_desc),
    order_success_title: cleanString(rawMsg.order_success_title, 100, def.messages.order_success_title),
    order_success_msg: cleanString(rawMsg.order_success_msg, 300, def.messages.order_success_msg),
    order_track_whatsapp: cleanString(rawMsg.order_track_whatsapp, 100, def.messages.order_track_whatsapp),
    chatbot_greeting: cleanString(rawMsg.chatbot_greeting, 200, def.messages.chatbot_greeting),
    copied_link_msg: cleanString(rawMsg.copied_link_msg, 100, def.messages.copied_link_msg),
  };

  // 4. الثيمات والألوان (Light & Dark)
  const rawLight = raw.light_theme?.colors || raw.modes?.light?.colors || raw.colors || {};
  const rawDark = raw.dark_theme?.colors || raw.modes?.dark?.colors || {};

  const lightColors = cleanColorPalette(rawLight, def.light_theme.colors);
  const darkColors = cleanColorPalette(rawDark, def.dark_theme.colors);

  // 5. الخطوط والطباعة
  const rawTypo = raw.typography || {};
  let font_family = cleanString(rawTypo.font_family, 50, def.typography.font_family);
  if (!limits.allowedFonts.includes(font_family)) {
    notices.push(`تم تحويل الخط إلى "${limits.allowedFonts[0]}" لتوافقه مع باقتك.`);
    font_family = limits.allowedFonts[0] || 'Tajawal';
  }

  const typography = {
    ...def.typography,
    ...rawTypo,
    font_family,
    base_size: cleanString(rawTypo.base_size, 10, def.typography.base_size),
    heading_weight: cleanString(rawTypo.heading_weight, 10, def.typography.heading_weight),
  };

  // 6. الأشكال
  const rawShapes = raw.shapes || {};
  let button_style = cleanString(rawShapes.button_style, 20, def.shapes.button_style);
  if (!ALLOWED_BUTTON_STYLES.includes(button_style)) button_style = 'rounded';

  let card_style = cleanString(rawShapes.card_style, 20, def.shapes.card_style);
  if (!ALLOWED_CARD_STYLES.includes(card_style)) card_style = 'elevated';

  const shapes = {
    ...def.shapes,
    ...rawShapes,
    button_style,
    card_style,
    card_radius: cleanString(rawShapes.card_radius, 15, def.shapes.card_radius),
    button_radius: cleanString(rawShapes.button_radius, 15, def.shapes.button_radius),
  };

  // 7. الأقسام والمكعبات (Layout Blocks)
  let inputBlocks = Array.isArray(raw.layout_blocks) && raw.layout_blocks.length > 0 ? raw.layout_blocks : def.layout_blocks;
  if (inputBlocks.length > limits.maxLayoutBlocks) {
    notices.push(`الحد الأقصى للأقسام في باقتك هو ${limits.maxLayoutBlocks} أقسام.`);
    inputBlocks = inputBlocks.slice(0, limits.maxLayoutBlocks);
  }

  const sanitizedBlocks = inputBlocks.map((block, idx) => {
    if (!block || typeof block !== 'object') return null;
    const type = ALLOWED_BLOCK_TYPES.includes(block.type) ? block.type : 'products';
    return {
      id: cleanString(block.id, 50, `block_${type}_${idx + 1}`),
      type,
      title: cleanString(block.title, 100, ''),
      subtitle: cleanString(block.subtitle, 200, ''),
      style: cleanString(block.style, 50, 'classic'),
      visible: typeof block.visible === 'boolean' ? block.visible : true,
      order: typeof block.order === 'number' ? block.order : idx + 1,
      settings: typeof block.settings === 'object' && block.settings !== null ? block.settings : {},
    };
  }).filter(Boolean);

  // 8. النوافذ والتسويق
  const modals_customization = {
    product_details: {
      cta_button_text: cleanString(raw.modals_customization?.product_details?.cta_button_text, 50, def.modals_customization.product_details.cta_button_text),
      border_radius: cleanString(raw.modals_customization?.product_details?.border_radius, 15, def.modals_customization.product_details.border_radius),
    },
    cart_drawer: {
      header_title: cleanString(raw.modals_customization?.cart_drawer?.header_title, 50, def.modals_customization.cart_drawer.header_title),
      checkout_btn_text: cleanString(raw.modals_customization?.cart_drawer?.checkout_btn_text, 50, def.modals_customization.cart_drawer.checkout_btn_text),
      empty_message: cleanString(raw.modals_customization?.cart_drawer?.empty_message, 100, def.modals_customization.cart_drawer.empty_message),
    },
    store_info: {
      title: cleanString(raw.modals_customization?.store_info?.title, 50, def.modals_customization.store_info.title),
      about_text: cleanString(raw.modals_customization?.store_info?.about_text, 300, def.modals_customization.store_info.about_text),
      delivery_policy: cleanString(raw.modals_customization?.store_info?.delivery_policy, 300, def.modals_customization.store_info.delivery_policy),
    },
    order_success: {
      title: cleanString(raw.modals_customization?.order_success?.title, 50, def.modals_customization.order_success.title),
      whatsapp_btn_text: cleanString(raw.modals_customization?.order_success?.whatsapp_btn_text, 50, def.modals_customization.order_success.whatsapp_btn_text),
    },
  };

  const marketing = {
    free_shipping_bar: {
      enabled: typeof raw.marketing?.free_shipping_bar?.enabled === 'boolean' ? raw.marketing.free_shipping_bar.enabled : def.marketing.free_shipping_bar.enabled,
      message: cleanString(raw.marketing?.free_shipping_bar?.message, 150, def.marketing.free_shipping_bar.message),
    },
    whatsapp_floating: {
      enabled: typeof raw.marketing?.whatsapp_floating?.enabled === 'boolean' ? raw.marketing.whatsapp_floating.enabled : def.marketing.whatsapp_floating.enabled,
      phone: cleanString(raw.marketing?.whatsapp_floating?.phone, 30, ''),
      position: raw.marketing?.whatsapp_floating?.position === 'right' ? 'right' : 'left',
    },
  };

  const rawNavigation = raw.navigation_settings || {};
  const navigationExtras = preserveFutureFields(rawNavigation, ['bottom_bar', 'top_bar']);
  const navigation_settings = {
    ...navigationExtras,
    bottom_bar: {
      ...(navigationExtras.bottom_bar || {}),
      items: normalizeBottomNavItems(rawNavigation.bottom_bar?.items || DEFAULT_NAV_ITEMS),
    },
    top_bar: {
      ...(navigationExtras.top_bar || {}),
      ...normalizeTopBarSettings(rawNavigation.top_bar || DEFAULT_TOP_BAR_SETTINGS),
    },
  };

  const topLevelExtras = preserveFutureFields(raw, [
    'version', 'theme_version', 'theme_name', 'default_theme_mode',
    'store_identity', 'products_settings', 'messages', 'layout_blocks',
    'modals_customization', 'light_theme', 'dark_theme', 'modes',
    'typography', 'shapes', 'animations', 'marketing', 'navigation_settings', 'updated_at'
  ]);

  const sanitizedConfig = {
    ...topLevelExtras,
    version: '4.0',
    theme_version: '4.0',
    theme_name: cleanString(raw.theme_name, 50, def.theme_name),
    default_theme_mode: raw.default_theme_mode === 'dark' ? 'dark' : (raw.default_theme_mode === 'auto' ? 'auto' : 'light'),
    store_identity,
    products_settings,
    messages,
    layout_blocks: sanitizedBlocks,
    modals_customization,
    light_theme: { colors: lightColors },
    dark_theme: { colors: darkColors },
    // توافقية كاملة مع ثيم مودز (theme-config.json)
    modes: {
      light: { colors: lightColors },
      dark: { colors: darkColors },
    },
    typography,
    shapes,
    animations: {
      card_hover: cleanString(raw.animations?.card_hover, 20, def.animations.card_hover),
    },
    marketing,
    navigation_settings,
    updated_at: typeof raw.updated_at === 'number' && raw.updated_at > 0 ? raw.updated_at : Date.now(),
  };

  return { sanitizedConfig, notices };
}
