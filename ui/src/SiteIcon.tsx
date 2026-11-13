// A site's icon: the page's favicon through the server's /favicon proxy, or, when there is none,
// a tile with the site's first letter in a color picked from its name.
import { useEffect, useState } from 'preact/hooks';
import { cx } from './ui';

const token = new URLSearchParams(location.search).get('token') ?? '';

export function iconSrc(icon: string): string {
  return `/favicon?token=${encodeURIComponent(token)}&u=${encodeURIComponent(icon)}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** A stable hue per site, so the same site always gets the same tile. */
function hue(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h % 360;
}

/**
 * `plate`: in dark themes, draw image icons on a light rounded plate. Many favicons are dark
 * glyphs on transparency (GitHub's, for one) and disappear on a dark background.
 */
export function SiteIcon(props: { url: string; icon?: string; size?: number; class?: string; plate?: boolean }) {
  const size = props.size ?? 16;
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [props.icon]);
  const host = hostOf(props.url);
  if (props.icon && !failed) {
    const img = (
      <img
        src={iconSrc(props.icon)}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        class={cx('flex-none rounded-[3px] object-contain', props.class)}
        style={{ width: `${size}px`, height: `${size}px` }}
        onError={() => setFailed(true)}
      />
    );
    if (!props.plate) return img;
    // light-dark() follows the element's color-scheme, which every theme sets.
    return <span class="grid flex-none place-items-center rounded-[4px] bg-[light-dark(transparent,#ececf0)] p-[2px]">{img}</span>;
  }
  const letter = (host.match(/[a-z0-9]/i)?.[0] ?? '?').toUpperCase();
  return (
    <span
      aria-hidden="true"
      class={cx('inline-grid flex-none place-items-center rounded-[4px] font-semibold text-white', props.class)}
      style={{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.62)}px`, background: `hsl(${hue(host)} 50% 45%)` }}
    >
      {letter}
    </span>
  );
}
