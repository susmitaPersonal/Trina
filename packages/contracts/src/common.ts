import { z } from 'zod';

/** Client- or server-generated UUID (UUIDv7 for client-generated entities). */
export const Id = z.uuid();
export type Id = z.infer<typeof Id>;

/** ISO-8601 UTC timestamp string. */
export const IsoDateTime = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTime>;

/** Lower-case hex SHA-256 digest. */
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'Expected lower-case hex SHA-256');

export const Longitude = z.number().min(-180).max(180);
export const Latitude = z.number().min(-90).max(90);

/** GeoJSON order: [lng, lat]. */
export const LngLat = z.tuple([Longitude, Latitude]);
export type LngLat = z.infer<typeof LngLat>;

export const CircleZone = z.object({
  type: z.literal('circle'),
  center: LngLat,
  radiusM: z.number().min(5).max(5000),
});
export type CircleZone = z.infer<typeof CircleZone>;

/** Single outer ring, closed (first point == last point), at most 200 vertices. */
export const PolygonZone = z.object({
  type: z.literal('polygon'),
  coordinates: z.tuple([z.array(LngLat).min(4).max(201)]),
});
export type PolygonZone = z.infer<typeof PolygonZone>;

export const Zone = z.discriminatedUnion('type', [CircleZone, PolygonZone]);
export type Zone = z.infer<typeof Zone>;

/** A single GPS fix as captured on device. */
export const Fix = z.object({
  lat: Latitude,
  lng: Longitude,
  acc: z.number().min(0).max(10_000),
  ts: IsoDateTime,
  mocked: z.boolean().optional(),
});
export type Fix = z.infer<typeof Fix>;

export const Difficulty = z.enum(['easy', 'medium', 'hard']);
export type Difficulty = z.infer<typeof Difficulty>;

export const Visibility = z.enum(['public', 'unlisted', 'private']);
export type Visibility = z.infer<typeof Visibility>;
