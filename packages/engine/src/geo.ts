import type { CircleZone, LngLat, PolygonZone, Zone } from '@trina/contracts';

const R = 6_371_008.8; // mean Earth radius, metres
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** Great-circle distance in metres between [lng, lat] points. */
export function haversineM(a: LngLat, b: LngLat): number {
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing from a to b, degrees 0..360 (0 = north). */
export function bearingDeg(a: LngLat, b: LngLat): number {
  const φ1 = toRad(a[1]);
  const φ2 = toRad(b[1]);
  const Δλ = toRad(b[0] - a[0]);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Point reached by travelling `distanceM` from `origin` on `bearing` degrees. */
export function destinationPoint(origin: LngLat, bearing: number, distanceM: number): LngLat {
  const δ = distanceM / R;
  const θ = toRad(bearing);
  const φ1 = toRad(origin[1]);
  const λ1 = toRad(origin[0]);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return [round6(((toDeg(λ2) + 540) % 360) - 180), round6(toDeg(φ2))];
}

export const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Accuracy-aware circle test: inside if distance ≤ radius + min(accuracy, accCap).
 * Fixes worse than `maxAccuracyM` never count as inside.
 */
export function inCircle(p: LngLat, accuracyM: number, zone: CircleZone, maxAccuracyM = 50, accCap = 25): boolean {
  if (accuracyM > maxAccuracyM) return false;
  return haversineM(p, zone.center) <= zone.radiusM + Math.min(accuracyM, accCap);
}

/** Ray-casting point-in-polygon on lng/lat (fine at neighbourhood scale). */
export function pointInPolygon(p: LngLat, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    const intersect = yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Approximate distance (m) from a point to a polygon ring's edges (0 if inside). */
export function distanceToPolygonM(p: LngLat, ring: LngLat[]): number {
  if (pointInPolygon(p, ring)) return 0;
  let min = Infinity;
  for (let i = 0; i < ring.length - 1; i++) min = Math.min(min, distanceToSegmentM(p, ring[i]!, ring[i + 1]!));
  return min;
}

/** Distance from point to segment using a local equirectangular projection. */
export function distanceToSegmentM(p: LngLat, a: LngLat, b: LngLat): number {
  const kx = Math.cos(toRad(p[1])) * 111_320;
  const ky = 110_540;
  const ax = (a[0] - p[0]) * kx;
  const ay = (a[1] - p[1]) * ky;
  const bx = (b[0] - p[0]) * kx;
  const by = (b[1] - p[1]) * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** Distance outside a zone in metres (0 if inside). */
export function distanceOutsideZoneM(p: LngLat, zone: Zone): number {
  if (zone.type === 'circle') return Math.max(0, haversineM(p, zone.center) - zone.radiusM);
  return distanceToPolygonM(p, zone.coordinates[0]);
}

export function polygonIsClosed(ring: LngLat[]): boolean {
  const a = ring[0];
  const b = ring[ring.length - 1];
  return !!a && !!b && a[0] === b[0] && a[1] === b[1];
}

function segmentsIntersect(p1: LngLat, p2: LngLat, p3: LngLat, p4: LngLat): boolean {
  const d = (a: LngLat, b: LngLat, c: LngLat) => (c[0] - a[0]) * (b[1] - a[1]) - (b[0] - a[0]) * (c[1] - a[1]);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

export function polygonSelfIntersects(ring: LngLat[]): boolean {
  const n = ring.length - 1; // closed ring
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsIntersect(ring[i]!, ring[i + 1]!, ring[j]!, ring[j + 1]!)) return true;
    }
  }
  return false;
}

export function zoneCenter(zone: Zone): LngLat {
  if (zone.type === 'circle') return zone.center;
  const pts = zone.coordinates[0].slice(0, -1);
  const lng = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const lat = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  return [round6(lng), round6(lat)];
}

/** Douglas–Peucker simplification (tolerance in metres). */
export function simplifyLine(points: LngLat[], toleranceM: number): LngLat[] {
  if (points.length <= 2) return points.slice();
  let maxD = 0;
  let idx = 0;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  for (let i = 1; i < points.length - 1; i++) {
    const d = distanceToSegmentM(points[i]!, first, last);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= toleranceM) return [first, last];
  const left = simplifyLine(points.slice(0, idx + 1), toleranceM);
  const right = simplifyLine(points.slice(idx), toleranceM);
  return [...left.slice(0, -1), ...right];
}

export function bboxOf(points: LngLat[], bufferM = 0): [number, number, number, number] {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const [lng, lat] of points) {
    minLng = Math.min(minLng, lng);
    minLat = Math.min(minLat, lat);
    maxLng = Math.max(maxLng, lng);
    maxLat = Math.max(maxLat, lat);
  }
  const dLat = bufferM / 110_540;
  const dLng = bufferM / (111_320 * Math.cos(toRad((minLat + maxLat) / 2)));
  return [round6(minLng - dLng), round6(minLat - dLat), round6(maxLng + dLng), round6(maxLat + dLat)];
}

export type { PolygonZone };
