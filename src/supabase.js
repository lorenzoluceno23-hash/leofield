import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://rptbuamczgoxjadenqrf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJwdGJ1YW1jemdveGphZGVucXJmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2MDQ3MjksImV4cCI6MjA5MjE4MDcyOX0.PeB14QLSg9v_NRj9iAoxXt3sOVIm5DGKrK8Y5AibVZg';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});

export const MEDIA_BUCKET = 'leofield-media';

// Helper: convert base64 data URL to Blob for upload
export function dataUrlToBlob(dataUrl) {
  const [header, base64] = dataUrl.split(',');
  const match = header.match(/:([^;]+);/);
  const mime = match ? match[1] : 'image/jpeg';
  const bin = atob(base64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// Cache signed URLs to avoid re-generating constantly
const signedUrlCache = new Map();
export async function getSignedUrl(path, expiresInSec = 3600) {
  if (!path) return null;
  const cached = signedUrlCache.get(path);
  if (cached && cached.expiresAt > Date.now()) return cached.url;
  const { data, error } = await supabase.storage.from(MEDIA_BUCKET).createSignedUrl(path, expiresInSec);
  if (error || !data) return null;
  signedUrlCache.set(path, { url: data.signedUrl, expiresAt: Date.now() + (expiresInSec - 60) * 1000 });
  return data.signedUrl;
}
