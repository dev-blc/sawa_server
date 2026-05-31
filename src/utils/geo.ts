/** City centroids for distance when exact GPS is not stored yet. */
const CITY_COORDS: Record<string, { lat: number; lng: number }> = {
  bangalore: { lat: 12.9716, lng: 77.5946 },
  bengaluru: { lat: 12.9716, lng: 77.5946 },
  chennai: { lat: 13.0827, lng: 80.2707 },
  'new delhi': { lat: 28.6139, lng: 77.209 },
  delhi: { lat: 28.6139, lng: 77.209 },
  mumbai: { lat: 19.076, lng: 72.8777 },
  gurgaon: { lat: 28.4595, lng: 77.0266 },
  gurugram: { lat: 28.4595, lng: 77.0266 },
  noida: { lat: 28.5355, lng: 77.391 },
  hyderabad: { lat: 17.385, lng: 78.4867 },
  goa: { lat: 15.2993, lng: 74.124 },
};

export type GeoPoint = { lat: number; lng: number };

export function cityCentroid(city?: string | null): GeoPoint | null {
  if (!city) return null;
  const lower = city.trim().toLowerCase();
  if (!lower || lower === 'unknown') return null;

  for (const [key, coords] of Object.entries(CITY_COORDS)) {
    if (lower.includes(key)) return coords;
  }
  return null;
}

export function coupleCoordinates(couple: {
  locationLatitude?: number | null;
  locationLongitude?: number | null;
  locationCity?: string | null;
}): GeoPoint | null {
  const lat = couple.locationLatitude;
  const lng = couple.locationLongitude;
  if (
    lat != null &&
    lng != null &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  ) {
    return { lat, lng };
  }
  return cityCentroid(couple.locationCity);
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance in kilometres. */
export function distanceKmBetween(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function formatDistanceLabel(km: number | null | undefined): string {
  if (km == null || !Number.isFinite(km)) return 'Nearby';
  if (km < 0.5) return 'Less than 1 km away';
  if (km < 1) return `${Math.round(km * 1000)} m away`;
  if (km < 10) return `${km.toFixed(1)} km away`;
  return `${Math.round(km)} km away`;
}

export function distanceLabelBetween(
  viewer: {
    locationLatitude?: number | null;
    locationLongitude?: number | null;
    locationCity?: string | null;
  },
  other: {
    locationLatitude?: number | null;
    locationLongitude?: number | null;
    locationCity?: string | null;
  },
): string {
  const from = coupleCoordinates(viewer);
  const to = coupleCoordinates(other);
  if (!from || !to) return 'Nearby';
  return formatDistanceLabel(distanceKmBetween(from, to));
}
