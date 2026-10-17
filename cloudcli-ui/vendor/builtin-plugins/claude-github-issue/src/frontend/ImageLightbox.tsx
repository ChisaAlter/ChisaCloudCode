import React, { useEffect, useState } from 'react';

interface Props {
  src: string;
  alt: string;
  onClose: () => void;
}

export const ImageLightbox: React.FC<Props> = ({ src, alt, onClose }) => {
  const [error, setError] = useState(false);

  useEffect(() => {
    setError(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, src]);

  return (
    <div className="cgi-lightbox-overlay" onClick={onClose}>
      <button className="cgi-lightbox-close" onClick={onClose} title="Close (Esc)">✕</button>
      {error ? (
        <div className="cgi-lightbox-error" onClick={e => e.stopPropagation()}>
          <div style={{ fontSize: 32, marginBottom: 8, opacity: 0.5 }}>🖼</div>
          <div style={{ fontSize: 13, opacity: 0.8 }}>Image could not be loaded</div>
          <a
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 12, color: '#60a5fa', marginTop: 8, display: 'block' }}
            onClick={e => e.stopPropagation()}
          >
            Open original URL ↗
          </a>
        </div>
      ) : (
        <img
          src={src}
          alt={alt}
          className="cgi-lightbox-img"
          onClick={e => e.stopPropagation()}
          onError={() => setError(true)}
        />
      )}
    </div>
  );
};
