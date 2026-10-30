import { useId } from "react";

/**
 * A small SVG area chart — no charting library, no new dependency. Values
 * are only scaled to pixel coordinates here; every amount the user reads is
 * formatted by the caller (`formatValue`) from the original integer.
 */
export function AreaChart({
  values,
  labels,
  formatValue,
}: {
  values: number[];
  labels: string[];
  formatValue: (value: number) => string;
}) {
  // React 18 ids look like ":r0:"; colons break url(#...) references.
  const gradientId = `fp${useId().replace(/:/g, "")}`;
  const width = 800;
  const height = 240;
  const pad = { top: 12, right: 12, bottom: 28, left: 12 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const peak = Math.max(1, ...values);

  const x = (i: number) => pad.left + (values.length > 1 ? (i / (values.length - 1)) * plotW : plotW / 2);
  const y = (v: number) => pad.top + plotH - (v / peak) * plotH;

  const line = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(v)}`).join(" ");
  const area = `${line} L${x(values.length - 1)},${pad.top + plotH} L${x(0)},${pad.top + plotH} Z`;

  // At most ~6 x-axis labels, always including the first and last day.
  const step = Math.max(1, Math.ceil(labels.length / 6));
  const tickIndexes = labels
    .map((_, i) => i)
    .filter((i) => i % step === 0 || i === labels.length - 1);

  return (
    <svg className="dash-chart" viewBox={`0 0 ${width} ${height}`} role="img">
      <defs>
        <linearGradient id={`${gradientId}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#7C3AED" stopOpacity="0.45" />
          <stop offset="1" stopColor="#7C3AED" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${gradientId}-stroke`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#7C3AED" />
          <stop offset="0.5" stopColor="#3B82F6" />
          <stop offset="1" stopColor="#06B6D4" />
        </linearGradient>
      </defs>

      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <line
          key={f}
          className="dash-chart-grid"
          x1={pad.left}
          x2={width - pad.right}
          y1={pad.top + plotH * f}
          y2={pad.top + plotH * f}
          vectorEffect="non-scaling-stroke"
        />
      ))}

      {values.length > 0 ? (
        <>
          <path d={area} fill={`url(#${gradientId}-fill)`} />
          <path
            d={line}
            fill="none"
            stroke={`url(#${gradientId}-stroke)`}
            strokeWidth={2.5}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          {values.map((v, i) => (
            <circle key={labels[i]} cx={x(i)} cy={y(v)} r={8} fill="transparent">
              <title>{`${labels[i]}: ${formatValue(v)}`}</title>
            </circle>
          ))}
        </>
      ) : null}

      {tickIndexes.map((i) => (
        <text
          key={labels[i]}
          className="dash-chart-axis"
          x={x(i)}
          y={height - 6}
          textAnchor={i === 0 ? "start" : i === labels.length - 1 ? "end" : "middle"}
        >
          {labels[i]}
        </text>
      ))}
    </svg>
  );
}
