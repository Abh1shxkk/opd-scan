/**
 * Load an image from an authenticated API route into an object URL.
 *
 * Page renders, previews and thumbnails are patient data behind a role check, so they cannot be
 * fetched by putting the path in `<img src>` — the browser would send no Authorization header.
 * The blob URL is revoked on unmount and whenever the path changes, so a long session browsing a
 * 35-page record does not accumulate megabytes of detached blobs.
 */

import { useEffect, useState } from 'react';
import { fetchObjectUrl } from '../lib/api';

export interface AuthedImage {
  url: string | null;
  loading: boolean;
  error: string | null;
}

export function useAuthedObjectUrl(path: string | null | undefined): AuthedImage {
  const [state, setState] = useState<AuthedImage>({ url: null, loading: Boolean(path), error: null });

  useEffect(() => {
    if (!path) {
      setState({ url: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    let created: string | null = null;
    setState({ url: null, loading: true, error: null });

    fetchObjectUrl(path)
      .then((url) => {
        created = url;
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        setState({ url, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          url: null,
          loading: false,
          error: err instanceof Error ? err.message : 'The image could not be loaded.',
        });
      });

    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [path]);

  return state;
}
