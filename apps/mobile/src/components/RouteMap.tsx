import type { ChallengeDefinition, LngLat } from '@trina/contracts';
import React, { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Circle, G, Polyline, Text as SvgText } from 'react-native-svg';
import { useTheme } from './theme';

/**
 * Tile-free vector "map": start zone, boundary, checkpoints, your track and position, drawn from the
 * challenge geometry alone. Works fully offline (MapLibre offline packs are an optional upgrade).
 */
export function RouteMap({
  def,
  reached = {},
  track = [],
  me,
  editable,
  onPressPoint,
  height = 320,
}: {
  def: Pick<ChallengeDefinition, 'area' | 'checkpoints' | 'route'>;
  reached?: Record<string, boolean>;
  track?: LngLat[];
  me?: { lng: number; lat: number; acc: number } | null;
  editable?: boolean;
  onPressPoint?: (p: LngLat) => void;
  height?: number;
}) {
  const t = useTheme();
  const width = 360;
  const proj = useMemo(() => {
    const pts: LngLat[] = [def.area.startZone.center, ...def.checkpoints.map((c) => c.geometry.center), ...track];
    if (me) pts.push([me.lng, me.lat]);
    const lat0 = def.area.startZone.center[1];
    const kx = Math.cos((lat0 * Math.PI) / 180) * 111_320;
    const ky = 110_540;
    const xs = pts.map((p) => p[0] * kx);
    const ys = pts.map((p) => p[1] * ky);
    const pad = 250; // metres
    const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
    const minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
    const scale = Math.min(width / (maxX - minX), height / (maxY - minY));
    const offX = (width - (maxX - minX) * scale) / 2;
    const offY = (height - (maxY - minY) * scale) / 2;
    return {
      scale,
      xy: (p: LngLat) => [offX + (p[0] * kx - minX) * scale, height - (offY + (p[1] * ky - minY) * scale)] as const,
      inverse: (x: number, y: number): LngLat => [((x - offX) / scale + minX) / kx, ((height - y - offY) / scale + minY) / ky],
    };
  }, [def, track, me, height]);

  const routeIds = def.route.checkpointIds.length ? def.route.checkpointIds : def.checkpoints.map((c) => c.id);
  const routePts = [def.area.startZone.center, ...routeIds.map((id) => def.checkpoints.find((c) => c.id === id)?.geometry.center).filter(Boolean) as LngLat[]];
  if (def.area.endZone) routePts.push(def.area.endZone.center);
  const [sx, sy] = proj.xy(def.area.startZone.center);
  const b = def.area.boundary;

  return (
    <View
      style={{ width: '100%', aspectRatio: width / height, backgroundColor: t.surfaceAlt, borderRadius: 16, overflow: 'hidden' }}
      onStartShouldSetResponder={() => !!editable}
      onResponderRelease={(e) => {
        if (!editable || !onPressPoint) return;
        const { locationX, locationY } = e.nativeEvent;
        e.currentTarget.measure?.((_x, _y, w) => {
          const k = width / (w || width);
          onPressPoint(proj.inverse(locationX * k, locationY * k));
        });
      }}
    >
      <Svg width="100%" height="100%" viewBox={`0 0 ${width} ${height}`}>
        {b && b.type === 'circle' && (() => {
          const [bx, by] = proj.xy(b.center);
          return <Circle cx={bx} cy={by} r={b.radiusM * proj.scale} stroke={t.textMuted} strokeDasharray="6 6" strokeWidth={1.5} fill="none" />;
        })()}
        {b && b.type === 'polygon' && <Polyline points={b.coordinates[0].map((p) => proj.xy(p).join(',')).join(' ')} stroke={t.textMuted} strokeDasharray="6 6" fill="none" />}
        <Polyline points={routePts.map((p) => proj.xy(p).join(',')).join(' ')} stroke={t.textMuted} strokeWidth={2} strokeDasharray="2 6" fill="none" />
        {track.length > 1 && <Polyline points={track.map((p) => proj.xy(p).join(',')).join(' ')} stroke={t.info} strokeWidth={4} fill="none" strokeLinejoin="round" />}
        <Circle cx={sx} cy={sy} r={Math.max(10, def.area.startZone.radiusM * proj.scale)} fill={t.accent} fillOpacity={0.25} stroke={t.accent} strokeWidth={2} />
        <SvgText x={sx} y={sy + 4} fontSize={12} fontWeight="bold" fill={t.text} textAnchor="middle">S</SvgText>
        {def.checkpoints.map((c, i) => {
          const [x, y] = proj.xy(c.geometry.center);
          const done = reached[c.id];
          return (
            <G key={c.id}>
              <Circle cx={x} cy={y} r={Math.max(12, c.geometry.radiusM * proj.scale)} fill={done ? t.primary : t.surface} stroke={t.primary} strokeWidth={3} />
              <SvgText x={x} y={y + 5} fontSize={14} fontWeight="bold" fill={done ? t.primaryText : t.text} textAnchor="middle">{done ? '✓' : String(routeIds.indexOf(c.id) + 1 || i + 1)}</SvgText>
            </G>
          );
        })}
        {me && (() => {
          const [mx, my] = proj.xy([me.lng, me.lat]);
          return (
            <G>
              <Circle cx={mx} cy={my} r={Math.max(6, me.acc * proj.scale)} fill={t.info} fillOpacity={0.15} />
              <Circle cx={mx} cy={my} r={7} fill={t.info} stroke="#fff" strokeWidth={2} />
            </G>
          );
        })()}
      </Svg>
    </View>
  );
}
