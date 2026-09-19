import { useState } from 'react';
import type { Panel } from '../types/comic';

interface Props {
  panel: Panel;
}

/**
 * Renders one panel: its visible layers composited, then bubbles on top.
 * Layer x/y/width are percentages of the panel; aspect ratio is fixed
 * at 4:3 for the scaffold (real projects will carry their own geometry).
 */
export default function PanelView({ panel }: Props) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  function toggleLayer(id: string) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const hasArt = panel.layers.some((l) => l.visible && !hidden.has(l.id) && l.src);

  return (
    <figure className="panel">
      {panel.title && <figcaption className="panel-title">{panel.title}</figcaption>}
      <div className="panel-canvas">
        {!hasArt && <div className="panel-empty">No artwork yet</div>}
        {panel.layers
          .filter((l) => l.visible && !hidden.has(l.id) && l.src)
          .map((layer) => (
            <img
              key={layer.id}
              src={layer.src}
              alt={layer.name}
              className={`panel-layer ${layer.kind}`}
              style={{
                left: `${layer.x}%`,
                top: `${layer.y}%`,
                width: `${layer.width}%`,
                opacity: layer.opacity,
                transform: `rotate(${layer.rotation}deg)`,
                zIndex: layer.kind === 'background' ? 1 : 2,
              }}
              draggable={false}
            />
          ))}
        {panel.bubbles.map((b) => (
          <div
            key={b.id}
            className={`bubble ${b.kind}`}
            style={{ left: `${b.x}%`, top: `${b.y}%`, width: `${b.width}%` }}
          >
            {b.text}
          </div>
        ))}
      </div>
      {panel.layers.length > 0 && (
        <div className="p-2 border-top d-flex flex-wrap gap-2">
          {panel.layers.map((l) => (
            <div className="form-check form-switch" key={l.id}>
              <input
                className="form-check-input"
                type="checkbox"
                role="switch"
                id={`layer-${l.id}`}
                checked={!hidden.has(l.id)}
                onChange={() => toggleLayer(l.id)}
              />
              <label className="form-check-label small" htmlFor={`layer-${l.id}`}>
                {l.name}
              </label>
            </div>
          ))}
        </div>
      )}
    </figure>
  );
}
