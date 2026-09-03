// ========================================================
// 🔐 التحكم بالصلاحيات (RBAC) - مركزي بدل التكرار بكل دالة
// ========================================================

export class HttpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// allowedRoles = [] تعني: أي مستخدم مسجّل دخول (بدون قيد دور معيّن)
export function assertAllowed(user, allowedRoles) {
  if (!allowedRoles || allowedRoles.length === 0) return;
  if (!user || !allowedRoles.includes(user.role)) {
    throw new HttpError('غير مصرح لك بتنفيذ هذا الإجراء', 403);
  }
}
