// ========================================================
// ⭐ إضافة (2026-07-21): أدوات جغرافية مشتركة لحساب المسافة ورسوم التوصيل.
// منسوخة حرفياً (نفس الأرقام والصيغ) من دوال api.php:
// extract_coords_from_url / calculate_distance / calculate_delivery_fee
// حتى يطابق create_order بالـ Worker نفس نتائج api.php تماماً.
// ========================================================

export function extractCoordsFromUrl(url) {
  if (!url) return null;
  let match = url.match(/@?(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (match) return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };
  match = url.match(/q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (match) return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };
  return null;
}

export function calculateDistance(lat1, lon1, lat2, lon2) {
  const earthRadius = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadius * c;
}

export function calculateDeliveryFee(distanceKm) {
  const baseFee = 300;
  const feePerKm = 100;
  const roundingFactor = 50;
  const totalFee = baseFee + distanceKm * feePerKm;
  return Math.ceil(totalFee / roundingFactor) * roundingFactor;
}
