const isValidCoordinate = (point) =>
  point && Number.isFinite(point.lat) && Number.isFinite(point.lng) &&
  Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180;

function distanceKm(from, to) {
  const EARTH_RADIUS_KM = 6371, toRadians = Math.PI / 180;
  const latDelta = (to.lat - from.lat) * toRadians, lngDelta = (to.lng - from.lng) * toRadians;
  const a = Math.sin(latDelta / 2) ** 2 +
    Math.cos(from.lat * toRadians) * Math.cos(to.lat * toRadians) * Math.sin(lngDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

module.exports = { isValidCoordinate, distanceKm };
